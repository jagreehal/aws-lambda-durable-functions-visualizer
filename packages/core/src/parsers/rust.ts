/**
 * Rust parser for AWS Lambda Durable Execution SDK (preview).
 *
 * Uses regex-based parsing to find `durable::run(handler)` entry points and
 * extract the fluent builder API. The Rust SDK uses snake_case methods on
 * `DurableContext` terminated by `.await?`, with names set on the builder
 * chain rather than as an argument:
 *
 *   ctx.step(|_| async { Ok(()) }).name("greet").await?
 *   ctx.wait(Duration::from_secs(1)).name("cooldown").await?
 *   ctx.parallel(branches).name("fanout").nesting(NestingMode::Flat).await?
 *
 * Combinators are detected too: join_all, try_join_all, select_ok, race.
 */

import { readFileSync } from 'node:fs'
import type { WorkflowNode, WorkflowBranch, WorkflowGraph } from '../graph.js'
import { buildEdges, loopLabel } from '../graph.js'
import type { Parser, ParseOptions } from '../parser.js'
import { basename } from 'node:path'

let nodeCounter = 0
function nextId(prefix: string): string {
  return `${prefix}_${++nodeCounter}`
}
function resetIds(): void {
  nodeCounter = 0
}

// ---------------------------------------------------------------------------
// Primitive mapping: Rust method name → graph NodeKind
// ---------------------------------------------------------------------------

interface PrimitiveInfo {
  kind: WorkflowNode['kind']
  idPrefix: string
}

const PRIMITIVES: Record<string, PrimitiveInfo> = {
  'step': { kind: 'step', idPrefix: 'step' },
  'invoke': { kind: 'invoke', idPrefix: 'invoke' },
  'parallel': { kind: 'parallel', idPrefix: 'parallel' },
  'parallel_mixed': { kind: 'parallel', idPrefix: 'parallel' },
  'map': { kind: 'map', idPrefix: 'map' },
  'wait': { kind: 'wait', idPrefix: 'wait' },
  'wait_for_callback': { kind: 'waitForCallback', idPrefix: 'callback' },
  'create_callback': { kind: 'createCallback', idPrefix: 'createcb' },
  'wait_for_condition': { kind: 'waitForCondition', idPrefix: 'waitcond' },
  'run_in_child_context': { kind: 'runInChildContext', idPrefix: 'child' },
  'with_retry': { kind: 'withRetry', idPrefix: 'retry' },
  'join_all': { kind: 'promiseAllSettled', idPrefix: 'allsettled' },
  'try_join_all': { kind: 'promiseAll', idPrefix: 'all' },
  'select_ok': { kind: 'promiseAny', idPrefix: 'any' },
  'race': { kind: 'promiseRace', idPrefix: 'race' },
}

// ---------------------------------------------------------------------------
// Rust-specific parsing
// ---------------------------------------------------------------------------

/** Find the crate alias: `use aws_durable_execution_sdk as durable;`. */
function findCrateAlias(source: string): string {
  const match = source.match(/use\s+aws_durable_execution_sdk\s+as\s+(\w+)\s*;/)
  return match?.[1] ?? 'durable'
}

/** Find DurableContext parameter names from `ctx: durable::DurableContext` signatures. */
function findContextParam(source: string): string[] {
  const names = new Set<string>()
  const paramPattern = /(\w+)\s*:\s*(?:\w+::)?DurableContext/g
  let match
  while ((match = paramPattern.exec(source)) !== null) {
    names.add(match[1])
  }
  if (names.size === 0) {
    names.add('ctx')
    names.add('context')
  }
  return [...names]
}

/**
 * Extract a brace-delimited block starting just after an opening brace.
 */
function extractBraceBlock(source: string, startIdx: number): string {
  let depth = 1
  let i = startIdx
  while (i < source.length && depth > 0) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') depth--
    i++
  }
  return source.slice(startIdx, i - 1)
}

/** Find the handler body: either a named fn or an inline closure. */
function extractHandlerBody(
  source: string,
  alias: string,
): { body: string; offset: number } | null {
  const entryPattern = new RegExp(`${alias}::(?:run_with_options|run|wrap)\\s*\\(`)
  const entry = entryPattern.exec(source)
  if (!entry) return null

  const argStart = entry.index + entry[0].length
  const argHead = source.slice(argStart, argStart + 120)

  // Inline closure: run(|event, ctx| async move { ... })
  if (/^\s*\|/.test(argHead)) {
    const closureTail = source.slice(argStart)
    const asyncBlock = closureTail.match(/async(?:\s+move)?\s*\{/)
    if (!asyncBlock || asyncBlock.index == null) return null
    const braceIdx = argStart + asyncBlock.index + asyncBlock[0].length
    const body = extractBraceBlock(source, braceIdx)
    return { body, offset: lineOfSubstring(source, body) }
  }

  // Named function: run(handler) → async fn handler(...) { ... }
  const nameMatch = argHead.match(/^\s*(\w+)\s*[,)]/)
  if (!nameMatch) return null
  const fnName = nameMatch[1]
  const fnPattern = new RegExp(`\\basync\\s+fn\\s+${fnName}\\s*\\([^)]*\\)[^{]*\\{`)
  const fnMatch = fnPattern.exec(source)
  if (!fnMatch) return null

  const body = extractBraceBlock(source, fnMatch.index + fnMatch[0].length)
  return { body, offset: lineOfSubstring(source, body) }
}

/** Compute the 1-based line number of a substring within the full source. */
function lineOfSubstring(source: string, substring: string): number {
  const idx = source.indexOf(substring)
  if (idx === -1) return 0
  return source.slice(0, idx).split('\n').length
}

/**
 * Collect the builder-chain lines from startIdx until the chain terminates.
 *
 * Termination is detected by brace depth, not indentation: the chain's own
 * `.await?`/`.future()`/`.spawn()`/`;` sits at brace depth 0, while nested
 * closures (parallel branches, child contexts, step bodies) push the depth
 * above 0 so their `.await` lines are collected rather than mistaken for the
 * end of the chain.
 */
function collectChain(lines: string[], startIdx: number): string[] {
  const parts: string[] = []
  let depth = 0
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    parts.push(line)

    if (depth === 0) {
      const isTerminal = /^\.await\b/.test(trimmed)
        || /^\.future\b/.test(trimmed)
        || /^\.spawn\b/.test(trimmed)
        || trimmed.endsWith(';')
      if (isTerminal) break
    }

    for (const ch of line) {
      if (ch === '{') depth++
      else if (ch === '}') depth--
    }
    // Closed the enclosing block: a chain without a terminal (a closure's tail expression) ends here.
    if (depth < 0) break
    // A line that closes its own closures and ends the statement: `})];`.
    if (depth === 0 && i > startIdx && trimmed.endsWith(';')) break
  }
  return parts
}

/**
 * Resolve the node's name from a `.name(...)` on the builder chain.
 *
 * The node's own name is the last `.name(...)` applied before the terminal
 * `.await?`; nested closures inside the method arguments appear earlier in the
 * chain. Resolution layers: string literal, local constant propagation,
 * identifier fallback.
 */
function extractNameArg(chain: string, source: string): string | undefined {
  const strMatches = [...chain.matchAll(/\.name\(\s*"([^"]+)"\s*\)/g)]
  if (strMatches.length > 0) return strMatches[strMatches.length - 1][1]

  const varMatches = [...chain.matchAll(/\.name\(\s*&?\s*(\w+)\s*\)/g)]
  if (varMatches.length > 0) {
    const ident = varMatches[varMatches.length - 1][1]
    const constValue = resolveConstBinding(source, ident)
    return constValue ?? ident
  }
  return undefined
}

/** Resolve `let ident = "literal";` (or `let ident: &str = "literal";`). */
function resolveConstBinding(source: string, ident: string): string | undefined {
  const pattern = new RegExp(`\\blet\\s+${ident}\\s*(?::\\s*&?\\s*str)?\\s*=\\s*"([^"]+)"`)
  return pattern.exec(source)?.[1]
}

interface RustConfigFlags {
  nestingType?: string
  completionConfig?: string
  stepSemantics?: string
  tenantId?: string
  maxConcurrency?: number
  retryStrategy?: string
}

function extractRustConfig(chain: string): RustConfigFlags {
  const flags: RustConfigFlags = {}

  const nesting = chain.match(/\.nesting\(\s*(?:\w+::)*NestingMode::(\w+)/)
  if (nesting) flags.nestingType = nesting[1] === 'Flat' ? 'FLAT' : 'NESTED'

  if (/\.completion\(/.test(chain)) {
    const parts: string[] = []
    const min = chain.match(/\.min_successful\(\s*(\d+)/)
    if (min) parts.push(`minSuccessful:${min[1]}`)
    const count = chain.match(/\.tolerated_failure_count\(\s*(\d+)/)
    if (count) parts.push(`toleratedFailures:${count[1]}`)
    const pct = chain.match(/\.tolerated_failure_percentage\(\s*(\d+)/)
    if (pct) parts.push(`toleratedPct:${pct[1]}%`)
    flags.completionConfig = parts.length > 0 ? parts.join(' ') : 'completion'
  }

  const semantics = chain.match(/\.semantics\(\s*(?:\w+::)*StepSemantics::(\w+)/)
  if (semantics) flags.stepSemantics = semantics[1] === 'AtMostOncePerRetry' ? 'AtMostOncePerRetry' : semantics[1]

  const tenant = chain.match(/\.tenant_id\(\s*"([^"]+)"/)
  if (tenant) flags.tenantId = tenant[1]

  const concurrency = chain.match(/\.max_concurrency\(\s*(\d+)/)
  if (concurrency) flags.maxConcurrency = Number(concurrency[1])

  if (/\.retry_strategy\(/.test(chain)) flags.retryStrategy = 'retry_strategy'

  return flags
}

/** 1-based line number of a character index. */
function lineAt(text: string, idx: number): number {
  return text.slice(0, idx).split('\n').length
}

/** Helpers currently being expanded, so a recursive helper can't loop forever. */
const activeHelpers = new Set<string>()

/**
 * Nodes of a same-file `async fn name(ctx: DurableContext, ...)` helper, or
 * null when there is no such fn (or it is already being expanded).
 */
function helperNodes(name: string, contextNames: string[], source: string): WorkflowNode[] | null {
  if (activeHelpers.has(name)) return null
  const fn = new RegExp(`\\bfn\\s+${name}\\s*(?:<[^>]*>)?\\s*\\(\\s*(?:mut\\s+)?(\\w+)\\s*:\\s*&?\\s*(?:\\w+::)*DurableContext[^{]*\\{`).exec(source)
  if (!fn) return null
  const braceIdx = fn.index + fn[0].length
  const names = contextNames.includes(fn[1]) ? contextNames : [...contextNames, fn[1]]
  activeHelpers.add(name)
  try {
    return extractNodes(extractBraceBlock(source, braceIdx), names, source, lineAt(source, braceIdx))
  } finally {
    activeHelpers.delete(name)
  }
}

/**
 * Parse the closure (or helper fn name) starting at `idx` in `text`:
 * `|ctx, ...| async move { ... }`, `|ctx| helper(ctx)`, or `helper`.
 * The first closure param is the durable context. Returns the nodes found and
 * the index just past what was consumed, or null when nothing matched.
 */
function closureNodes(
  text: string,
  idx: number,
  textLine: number,
  contextNames: string[],
  source: string,
): { nodes: WorkflowNode[]; end: number } | null {
  const rest = text.slice(idx)
  const closure = /^(?:move\s*)?\|([^|]*)\|\s*(?:async(?:\s+move)?\s*)?\{/.exec(rest)
  if (closure) {
    const braceIdx = idx + closure[0].length
    const body = extractBraceBlock(text, braceIdx)
    const param = closure[1].match(/^\s*(?:mut\s+)?(\w+)/)?.[1]
    const names = param && !contextNames.includes(param) ? [...contextNames, param] : contextNames
    let nodes = extractNodes(body, names, source, textLine + lineAt(text, braceIdx) - 1)
    // `async move { helper(ctx).await }` → follow the helper.
    const call = nodes.length === 0 ? body.match(/^\s*(\w+)\s*\(/) : null
    if (call) nodes = helperNodes(call[1], contextNames, source) ?? []
    return { nodes, end: braceIdx + body.length }
  }
  const helper = /^(?:move\s*)?\|[^|]*\|\s*(\w+)\s*\(/.exec(rest) ?? /^(\w+)\s*[,)]/.exec(rest)
  if (helper) {
    const nodes = helperNodes(helper[1], contextNames, source)
    if (nodes) return { nodes, end: idx + helper[0].length }
  }
  return null
}

/**
 * Extract parallel branches from `Branch::new("name", <closure or helper>)`.
 *
 * Only the given text (the parallel call's own chain, or a `let` initializer)
 * is scanned, and each branch body is parsed with `extractNodes` (so a nested
 * parallel becomes a nested node and its `Branch::new` calls are skipped
 * here). A branch with no durable calls keeps a placeholder step.
 */
function extractRustBranches(
  chain: string,
  chainLine: number,
  contextNames: string[],
  source: string,
  setIdent?: string,
): WorkflowBranch[] {
  const branches: WorkflowBranch[] = []
  // `BranchSet::add(name, f)` / `add_with_serdes(name, serdes, f)` only for a resolved set variable.
  const setAdd = setIdent ? `|\\b${setIdent}\\s*\\.\\s*(add(?:_with_serdes)?)` : ''
  const branchPattern = new RegExp(`(?:Branch::(new|unnamed)${setAdd})\\s*\\(`, 'g')
  let match
  while ((match = branchPattern.exec(chain)) !== null) {
    const ctor = match[1] ?? match[2]
    const closureArg = ctor === 'unnamed' ? 0 : ctor === 'add_with_serdes' ? 2 : 1
    const argIdx = argStart(chain, branchPattern.lastIndex - 1, closureArg)
    if (argIdx < 0) continue
    // A computed name (`format!(..)`, a variable) means the branch is generated per item.
    const literal = ctor === 'unnamed' ? undefined : /^\s*"([^"]+)"\s*,/.exec(chain.slice(branchPattern.lastIndex))?.[1]
    const unnamed = ctor === 'unnamed'
    const name = literal ?? (unnamed ? `branch ${branches.length + 1}` : 'each item')
    const parsed = closureNodes(chain, argIdx, chainLine, contextNames, source)
    // Skip past the body so a nested parallel's Branch::new calls aren't counted here.
    if (parsed) branchPattern.lastIndex = parsed.end
    const nodes = parsed?.nodes.length ? parsed.nodes : [{ id: nextId('step'), kind: 'step' as const, label: name }]
    branches.push({ name, dynamic: literal == null && !unnamed, nodes })
  }

  return branches
}

/** `ctx.map(items, |child, item, idx| async move { ... })` → one dynamic branch. */
function extractMapBranches(
  chain: string,
  chainLine: number,
  contextNames: string[],
  source: string,
): WorkflowBranch[] {
  const call = /\.map\s*(?:::<[^>]*>)?\s*\(/.exec(chain)
  const argIdx = call ? argStart(chain, call.index + call[0].length - 1, 1) : -1
  if (argIdx < 0) return []
  const parsed = closureNodes(chain, argIdx, chainLine, contextNames, source)
  return parsed?.nodes.length ? [{ name: 'each item', dynamic: true, nodes: parsed.nodes }] : []
}

/**
 * Index of argument `n` (0-based, whitespace skipped) of the call whose `(` is
 * at `openIdx`, or -1. Nested ()/[]/{} and string literals are skipped.
 */
function argStart(text: string, openIdx: number, n: number): number {
  const skipWs = (i: number) => i + (text.slice(i).match(/^\s*/)?.[0].length ?? 0)
  if (n === 0) return skipWs(openIdx + 1)
  let depth = 0
  for (let i = openIdx + 1; i < text.length; i++) {
    const ch = text[i]
    if (ch === '"') {
      while (++i < text.length && text[i] !== '"') if (text[i] === '\\') i++
    } else if ('([{'.includes(ch)) depth++
    else if (')]}'.includes(ch)) {
      if (depth-- === 0) return -1
    } else if (ch === ',' && depth === 0 && --n === 0) {
      return skipWs(i + 1)
    }
  }
  return -1
}

/** `let [mut] ident` → ident. */
const LET_BINDING = /^let\s+(?:mut\s+)?(\w+)\b/

/**
 * Branches for `ctx.parallel(ident)`: the nearest `let ident` before the call
 * that is in scope (same block or an enclosing one, never another fn), plus
 * any `ident.push(..)` / `ident.extend(..)` between it and the call, in order.
 */
function resolveBranchList(
  ident: string,
  callLine: number,
  contextNames: string[],
  source: string,
): WorkflowBranch[] {
  const srcLines = source.split('\n')

  // Innermost fn whose body contains the call; its first line bounds the search.
  let fnStart = 0
  for (const fn of source.matchAll(/\bfn\s+\w+[^;{]*\{/g)) {
    const braceIdx = fn.index + fn[0].length
    const start = lineAt(source, braceIdx)
    const end = lineAt(source, braceIdx + extractBraceBlock(source, braceIdx).length)
    if (start <= callLine && callLine <= end && start > fnStart) fnStart = start
  }

  // Walk back from the call. `depth` rises inside blocks that closed before the
  // call and falls when leaving an enclosing block; a line is in scope only
  // while depth is at its lowest so far.
  let depth = 0
  let minDepth = 0
  let letIdx = -1
  for (let j = callLine - 2; j >= Math.max(fnStart - 1, 0); j--) {
    // Count the line's own braces first: a `let` may open its first closure on the same line.
    for (const ch of [...srcLines[j]].reverse()) {
      if (ch === '}') depth++
      else if (ch === '{') depth--
    }
    minDepth = Math.min(minDepth, depth)
    if (depth === minDepth && srcLines[j].trim().match(LET_BINDING)?.[1] === ident) {
      letIdx = j
      break
    }
  }
  if (letIdx < 0) return []

  const branches: WorkflowBranch[] = []
  const growth = new RegExp(`\\b${ident}\\s*\\.\\s*(?:push|extend|add|add_with_serdes)\\s*\\(`)
  for (let j = letIdx; j < callLine - 1; j++) {
    if (j > letIdx && !growth.test(srcLines[j].trim())) continue
    const stmt = collectChain(srcLines, j)
    branches.push(...extractRustBranches(stmt.join('\n'), j + 1, contextNames, source, ident))
    j += stmt.length - 1
  }
  return branches
}

/** True when a block's last statement is a `return`. */
function endsWithReturn(block: string): boolean {
  return block.trim().split('\n').pop()?.trim().startsWith('return ') ?? false
}

/** Index just past the last `}` of the `if ... {} else if ... {} else {}` chain starting at `ifIdx`. */
function ifChainEnd(text: string, ifIdx: number): number {
  const braceIdx = text.indexOf('{', ifIdx) + 1
  const end = braceIdx + extractBraceBlock(text, braceIdx).length + 1
  const next = /^\s*else\s*(if\b|\{)/.exec(text.slice(end))
  if (!next) return end
  const at = end + next[0].length - next[1].length
  return next[1] === '{' ? at + 1 + extractBraceBlock(text, at + 1).length + 1 : ifChainEnd(text, at)
}

/** Count iterations for `for _ in 0..3` / `0..=3` ranges with literal bounds. */
function rustLoopIterations(header: string): number | undefined {
  const range = header.match(/\bin\s+(\d+)\s*\.\.(=?)\s*(\d+)$/)
  if (!range) return undefined
  const count = Number(range[3]) - Number(range[1]) + (range[2] ? 1 : 0)
  return count > 0 ? count : undefined
}

function extractNodes(
  body: string,
  contextNames: string[],
  source: string,
  baseLineOffset: number,
): WorkflowNode[] {
  const nodes: WorkflowNode[] = []
  const lines = body.split('\n')

  // Character offset of each line within `body`, for locating braces.
  const lineStarts: number[] = []
  let offset = 0
  for (const rawLine of lines) {
    lineStarts.push(offset)
    offset += rawLine.length + 1
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    const absLine = baseLineOffset + i

    if (line.startsWith('//') || line.startsWith('/*') || line === '') continue

    // if <condition> { ... } [else if ... | else { ... }] → condition node
    const ifMatch = line.match(/^if\s+(.+?)\s*\{/)
    if (ifMatch) {
      const braceIdx = body.indexOf('{', lineStarts[i]) + 1
      const condition = ifMatch[1].trim()
      const ifBody = extractBraceBlock(body, braceIdx)
      // The body text starts on the header line, so its first line is absLine
      const thenNodes = extractNodes(ifBody, contextNames, source, absLine)

      // An `else if` chain is parsed as an else block holding the next `if`.
      let end = braceIdx + ifBody.length + 1
      let elseNodes: WorkflowNode[] = []
      let elseReturns = false
      const elseMatch = /^\s*else\s*(if\b|\{)/.exec(body.slice(end))
      if (elseMatch) {
        const at = end + elseMatch[0].length - elseMatch[1].length
        const elseLine = baseLineOffset + lineAt(body, at) - 1
        if (elseMatch[1] === '{') {
          const elseBody = extractBraceBlock(body, at + 1)
          elseNodes = extractNodes(elseBody, contextNames, source, elseLine)
          elseReturns = endsWithReturn(elseBody)
          end = at + 1 + elseBody.length + 1
        } else {
          end = ifChainEnd(body, at)
          elseNodes = extractNodes(body.slice(at, end), contextNames, source, elseLine)
        }
      }

      if (thenNodes.length > 0 || elseNodes.length > 0) {
        // Only the else side does durable work: draw it as the then side of the negated condition.
        const flipped = thenNodes.length === 0
        const label = flipped ? `!(${condition})` : condition
        nodes.push({
          id: nextId('cond'),
          kind: 'condition',
          label,
          condition: label,
          thenCount: flipped ? elseNodes.length : thenNodes.length,
          thenReturns: flipped ? elseReturns : endsWithReturn(ifBody),
          elseCount: flipped ? undefined : elseNodes.length || undefined,
          elseReturns: flipped || elseNodes.length === 0 ? undefined : elseReturns,
          sourceLine: absLine,
        })
        nodes.push(...thenNodes, ...elseNodes)
        // Land on the line of the chain's last closing brace; the for loop's i++ moves past it.
        i = lineAt(body, end - 1) - 1
        continue
      }
    }

    // for / while / loop → loop node followed by the loop body. The block opens
    // at the trailing brace; labeled loops (`'outer: for ...`) are supported.
    const loopMatch = line.replace(/\s*\/\/.*$/, '').match(/^(?:'\w+:\s*)?(for|while|loop)\b\s*(.*?)\s*\{$/)
    if (loopMatch) {
      const header = loopMatch[1] === 'loop' ? '' : loopMatch[2].trim()
      const braceIdx = lineStarts[i] + lines[i].replace(/\s*\/\/.*$/, '').trimEnd().length
      const loopBody = extractBraceBlock(body, braceIdx)
      const bodyNodes = extractNodes(loopBody, contextNames, source, absLine)

      if (bodyNodes.length > 0) {
        const iterations = loopMatch[1] === 'for' ? rustLoopIterations(header) : undefined
        nodes.push({
          id: nextId('loop'),
          kind: 'loop',
          label: loopLabel(header, iterations),
          loopHeader: header,
          bodyCount: bodyNodes.length,
          iterations,
          sourceLine: absLine,
        })
        nodes.push(...bodyNodes)
        // Land on the closing brace line; the for loop's i++ moves past it.
        i += loopBody.split('\n').length - 1
        continue
      }
    }

    // A branch list built ahead of `ctx.parallel(list)` (`let`, `.push`,
    // `.extend`): its closures belong to that parallel, so skip the statement.
    if (/^(?:let\b|\w+\s*\.\s*(?:push|extend)\s*\()/.test(line)) {
      const stmt = collectChain(lines, i).join('\n')
      const ctor = /Branch::(?:new|unnamed)|\.\s*add(?:_with_serdes)?\s*\(/.exec(stmt)
      const prefix = ctor ? stmt.slice(0, ctor.index) : ''
      const durable = new RegExp(`\\b(?:${contextNames.join('|')})\\s*\\.\\s*(?:${Object.keys(PRIMITIVES).join('|')})\\b`)
      if (ctor && !durable.test(prefix)) {
        i += stmt.split('\n').length - 1
        continue
      }
    }

    // Durable primitive calls: ctx.<method>( — rustfmt may split the receiver
    // and method across two lines (`ctx` on one line, `.step(` on the next).
    let matched = false
    for (const method of Object.keys(PRIMITIVES)) {
      if (matched) break
      for (const ctxName of contextNames) {
        const methodIdx = findMethodLine(lines, i, ctxName, method)
        if (methodIdx < 0) continue

        matched = true
        const info = PRIMITIVES[method]
        const chainLines = collectChain(lines, methodIdx)
        const chain = chainLines.join('\n')
        const label = extractNameArg(chain, source)
        const config = extractRustConfig(chain)

        const node: WorkflowNode = {
          id: nextId(info.idPrefix),
          kind: info.kind,
          label: label ?? method.replace(/_/g, ' '),
          sourceLine: baseLineOffset + methodIdx,
        }

        if (info.kind === 'invoke') {
          const fnMatch = chain.match(/\.invoke::<[^>]*>\s*\(\s*&?\s*([^,\s]+)/)
            ?? chain.match(/\.invoke\s*\(\s*&?\s*([^,\s]+)/)
          if (fnMatch) node.target = fnMatch[1].replace(/^"|"$/g, '')
          if (config.tenantId) node.tenantId = config.tenantId
        }

        if (info.kind === 'parallel' || info.kind === 'map') {
          const chainLine = baseLineOffset + methodIdx
          node.branches = info.kind === 'map'
            ? extractMapBranches(chain, chainLine, contextNames, source)
            : extractRustBranches(chain, chainLine, contextNames, source)
          // `ctx.parallel(branches)` → the in-scope `let branches = ...` before the call.
          const ident = info.kind === 'parallel' && node.branches.length === 0
            ? chain.match(/\.parallel(?:_mixed)?\s*\(\s*&?\s*(\w+)\s*[,)]/)?.[1]
            : undefined
          if (ident) node.branches = resolveBranchList(ident, chainLine, contextNames, source)
          if (config.nestingType) node.nestingType = config.nestingType
          if (config.completionConfig) node.completionConfig = config.completionConfig
          if (config.maxConcurrency != null) node.maxConcurrency = config.maxConcurrency
        }

        if (info.kind === 'runInChildContext') {
          if (config.nestingType) node.nestingType = config.nestingType
        }

        // The closure's durable calls become one branch drawn inside the node.
        if (info.kind === 'runInChildContext' || info.kind === 'withRetry') {
          const call = new RegExp(`\\.${method}\\s*(?:::<[^>]*>)?\\s*\\(`).exec(chain)
          const parsed = call
            ? closureNodes(chain, argStart(chain, call.index + call[0].length - 1, 0), baseLineOffset + methodIdx, contextNames, source)
            : null
          if (parsed?.nodes.length) node.branches = [{ name: node.label, dynamic: false, nodes: parsed.nodes }]
        }

        if (info.kind === 'step' || info.kind === 'withRetry') {
          if (config.stepSemantics) node.stepSemantics = config.stepSemantics
          if (config.retryStrategy) node.retryStrategy = config.retryStrategy
        }

        nodes.push(node)
        // Skip the rest of the chain so durable calls inside its closures aren't emitted again here.
        i = methodIdx + chainLines.length - 1
        break
      }
    }
  }

  return nodes
}

/**
 * Locate the line index where `ctx.<method>(` starts, handling both the
 * same-line form (`ctx.step(`) and the rustfmt split form (`ctx` ending one
 * line, `.step(` starting the next). Returns -1 when absent.
 */
function findMethodLine(lines: string[], i: number, ctxName: string, method: string): number {
  const line = lines[i].trim()
  // Optional turbofish (::<...>) between the method name and the opening paren.
  const turbofish = `(?:::<[^>]*>)?\\s*\\(`

  if (new RegExp(`${ctxName}\\.${method}${turbofish}`).test(line)) return i

  if (new RegExp(`^\\.${method}${turbofish}`).test(line) && i > 0) {
    const prev = lines[i - 1].trim()
    if (prev.endsWith(ctxName)) return i
  }

  return -1
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export class RustParser implements Parser {
  extensions = ['.rs']

  parseFile(filePath: string, options?: ParseOptions): WorkflowGraph {
    resetIds()

    const source = readFileSync(filePath, 'utf-8')
    const fileName = basename(filePath, '.rs')
    const name = options?.name ?? fileName

    const alias = findCrateAlias(source)
    const handler = extractHandlerBody(source, alias)
    if (!handler) {
      throw new Error(`No ${alias}::run() entry point found in ${filePath}`)
    }

    const contextNames = findContextParam(source)
    const workflowNodes = extractNodes(handler.body, contextNames, source, handler.offset)

    const startNode: WorkflowNode = { id: 'node_start', kind: 'start', label: 'Start' }
    const endNode: WorkflowNode = { id: 'node_end', kind: 'end', label: 'End' }
    const allNodes = [startNode, ...workflowNodes, endNode]
    const edges = buildEdges(allNodes)

    return { name, nodes: allNodes, edges }
  }
}
