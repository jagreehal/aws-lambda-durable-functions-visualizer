/**
 * Python parser for durable function handlers.
 *
 * Uses regex-based parsing to find @durable_execution decorated handlers
 * and extract durable primitives. Python SDK uses snake_case method names:
 *
 *   context.step()              → step
 *   context.invoke()            → invoke
 *   context.parallel()          → parallel
 *   context.map()               → map
 *   context.wait()              → wait
 *   context.wait_for_callback() → waitForCallback
 *   context.create_callback()   → createCallback
 *   context.wait_for_condition()→ waitForCondition
 *   context.run_in_child_context() → runInChildContext
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
// Primitive mapping: Python method name → graph NodeKind
// ---------------------------------------------------------------------------

interface PrimitiveInfo {
  kind: WorkflowNode['kind']
  idPrefix: string
}

const PRIMITIVES: Record<string, PrimitiveInfo> = {
  'step': { kind: 'step', idPrefix: 'step' },
  'invoke': { kind: 'invoke', idPrefix: 'invoke' },
  'parallel': { kind: 'parallel', idPrefix: 'parallel' },
  'map': { kind: 'map', idPrefix: 'map' },
  'wait': { kind: 'wait', idPrefix: 'wait' },
  'wait_for_callback': { kind: 'waitForCallback', idPrefix: 'callback' },
  'create_callback': { kind: 'createCallback', idPrefix: 'createcb' },
  'wait_for_condition': { kind: 'waitForCondition', idPrefix: 'waitcond' },
  'run_in_child_context': { kind: 'runInChildContext', idPrefix: 'child' },
  'with_retry': { kind: 'withRetry', idPrefix: 'retry' },
}

// ---------------------------------------------------------------------------
// Python-specific parsing
// ---------------------------------------------------------------------------

/**
 * Find the context parameter name from a @durable_execution handler.
 * Pattern: def handler(event: dict, context: DurableContext)
 * Returns the parameter name (e.g. "context", "ctx").
 */
function findContextParam(handlerBody: string): string[] {
  const paramPattern = /def\s+\w+\s*\([^)]*?(\w+)\s*:\s*DurableContext/g
  const names: string[] = []
  let match
  while ((match = paramPattern.exec(handlerBody)) !== null) {
    names.push(match[1])
  }
  if (names.length === 0) {
    // Fallback: common names
    names.push('context', 'ctx')
  }
  return names
}

/**
 * Extract the handler function body starting from @durable_execution.
 * Returns the text of the decorated function.
 */
function extractHandlerBody(source: string): string | null {
  // @durable_execution, @durable_execution(), @durable_execution(boto3_client=...) over several lines
  const decorator = /^[ \t]*@durable_execution\b/m.exec(source)
  if (!decorator) return null
  let idx = decorator.index + decorator[0].length
  const decoratorArgs = /^\s*\(/.exec(source.slice(idx))
  if (decoratorArgs) {
    const open = idx + decoratorArgs[0].length - 1
    idx = open + callArgs(source, open).length + 2
  }
  const def = /(?:async\s+)?def\s+\w+\s*\(/g
  def.lastIndex = idx
  const match = def.exec(source)
  if (!match) return null
  const open = match.index + match[0].length - 1
  const colon = source.indexOf(':', open + callArgs(source, open).length + 2)
  return colon === -1 ? null : extractPythonBlock(source, colon + 1)
}

/**
 * Extract a Python block (indentation-based) starting after a colon.
 */
function extractPythonBlock(source: string, startIdx: number): string {
  const lines = source.slice(startIdx).split('\n')
  const bodyLines: string[] = []
  let baseIndent: number | null = null

  let openString = '' // inside a ''' / """ string, whose lines may sit at any indent
  const trackStrings = (line: string) => {
    for (const quote of line.match(/'{3}|"{3}/g) ?? []) {
      if (!openString) openString = quote
      else if (quote === openString) openString = ''
    }
  }

  for (const line of lines) {
    if (openString) {
      bodyLines.push(line)
      trackStrings(line)
      continue
    }

    // Skip empty lines at the start
    if (baseIndent === null) {
      if (line.trim() === '') continue
      baseIndent = line.length - line.trimStart().length
      if (baseIndent === 0) break // not indented = not part of function body
      bodyLines.push(line)
      trackStrings(line)
      continue
    }

    // Empty lines are part of the block
    if (line.trim() === '') {
      bodyLines.push(line)
      continue
    }

    const indent = line.length - line.trimStart().length
    if (indent < baseIndent) break // dedented = end of block
    bodyLines.push(line)
    trackStrings(line)
  }

  return bodyLines.join('\n')
}

/**
 * Find helper functions that accept DurableContext and contain durable calls.
 */
function findHelperFunctions(source: string, contextNames: string[]): Map<string, string> {
  const helpers = new Map<string, string>()
  // Match: def func_name(..., param: DurableContext, ...):
  const funcPattern = /def\s+(\w+)\s*\(([^)]*DurableContext[^)]*)\)[^:]*:/g
  let match

  while ((match = funcPattern.exec(source)) !== null) {
    const funcName = match[1]
    const startIdx = match.index + match[0].length
    const body = extractPythonBlock(source, startIdx)

    // Check if the body contains durable calls
    const hasContextCall = contextNames.some((name) =>
      Object.keys(PRIMITIVES).some((method) =>
        body.includes(`${name}.${method}(`)
      )
    )

    if (hasContextCall) {
      helpers.set(funcName, body)
    }
  }

  return helpers
}

/**
 * Compute the 1-based line number of a substring within the full source.
 */
function lineOfSubstring(source: string, substring: string): number {
  const idx = source.indexOf(substring)
  if (idx === -1) return 0
  return source.slice(0, idx).split('\n').length
}

/** Count iterations for `for x in range(3)` / `range(1, 4)` with literal bounds. */
function pythonLoopIterations(header: string): number | undefined {
  const range = header.match(/\bin\s+range\(\s*(?:(\d+)\s*,\s*)?(\d+)\s*\)$/)
  if (!range) return undefined
  const count = Number(range[2]) - Number(range[1] ?? 0)
  return count > 0 ? count : undefined
}

/**
 * Extract durable primitive calls from a block of Python code.
 *
 * @param body - the code block to scan
 * @param contextNames - DurableContext parameter names
 * @param helpers - helper functions that use DurableContext
 * @param visited - recursion guard
 * @param source - the full file source (for computing absolute line numbers)
 * @param baseLineOffset - 1-based line offset of body within source
 */
function extractNodes(
  body: string,
  contextNames: string[],
  helpers: Map<string, string>,
  visited: Set<string>,
  source: string,
  baseLineOffset: number,
): WorkflowNode[] {
  const nodes: WorkflowNode[] = []
  const lines = body.split('\n')

  // Character offset of each line within `body`.
  const lineStarts: number[] = []
  let offset = 0
  for (const rawLine of lines) {
    lineStarts.push(offset)
    offset += rawLine.length + 1
  }

  /** Index of the first non-blank line after `index` (where an indented block starts). */
  const blockFirstLine = (index: number): number => {
    let next = index + 1
    while (next < lines.length && lines[next].trim() === '') next++
    return next
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    const absLine = baseLineOffset + i

    // Skip comments and empty lines
    if (line.startsWith('#') || line === '') continue

    // Nested def: its body runs only when called (helpers/branches resolve it from source)
    if (/^(?:async\s+)?def\s/.test(line)) {
      const sigEnd = i + balancedText(lines, i).split('\n').length - 1
      const defBody = extractPythonBlock(body, lineStarts[sigEnd] + lines[sigEnd].length)
      i = defBody.trim() ? blockFirstLine(sigEnd) + defBody.split('\n').length - 1 : sigEnd
      continue
    }

    // `branches = [...]` / `.append(...)` for a later parallel/map: branches, not steps here
    const assign = line.match(/^(\w+)\s*(?:=(?!=)|\+=|\.\s*(?:append|extend)\s*\()/)
    if (assign && usedAsBranches(assign[1], lines, i)) {
      i += balancedText(lines, i).split('\n').length - 1
      continue
    }

    // Check for if-statements wrapping durable calls
    const ifMatch = line.match(/^if\s+(.+?)\s*:/)
    if (ifMatch) {
      const condition = ifMatch[1]
      const blockStart = lineStarts[i] + lines[i].length
      const ifBody = extractPythonBlock(body, blockStart)
      const ifBodyFirstLine = blockFirstLine(i)
      const ifBodyOffset = baseLineOffset + ifBodyFirstLine
      const thenNodes = extractNodes(ifBody, contextNames, helpers, visited, source, ifBodyOffset)

      // else: / elif ...: at the if's own indent, after the then-block
      const indentOf = (l: string) => l.length - l.trimStart().length
      const nextHeader = (after: number): number => {
        let k = after + 1
        while (k < lines.length && lines[k].trim() === '') k++
        return k < lines.length && indentOf(lines[k]) === indentOf(lines[i]) && /^(?:elif\s|else\s*:)/.test(lines[k].trim()) ? k : -1
      }
      /** Last line index of the block opened by the header at `k`. */
      const blockEnd = (k: number) => blockFirstLine(k) + extractPythonBlock(body, lineStarts[k] + lines[k].length).split('\n').length - 1
      const endsWithReturn = (block: string) => /^return\b/.test(block.trim().split('\n').at(-1)?.trim() ?? '')

      const thenEnd = ifBodyFirstLine + ifBody.split('\n').length - 1
      let chainEnd = thenEnd
      let elseNodes: WorkflowNode[] = []
      let elseReturns = false
      const elseAt = nextHeader(thenEnd)
      if (elseAt !== -1 && lines[elseAt].trim().startsWith('else')) {
        const elseBody = extractPythonBlock(body, lineStarts[elseAt] + lines[elseAt].length)
        elseNodes = extractNodes(elseBody, contextNames, helpers, visited, source, baseLineOffset + blockFirstLine(elseAt))
        elseReturns = endsWithReturn(elseBody)
        chainEnd = blockEnd(elseAt)
      } else if (elseAt !== -1) {
        // elif: an else block holding another if/elif/else chain
        chainEnd = blockEnd(elseAt)
        for (let k = nextHeader(chainEnd); k !== -1; k = nextHeader(chainEnd)) chainEnd = blockEnd(k)
        const chain = [lines[elseAt].replace(/\belif\b/, 'if'), ...lines.slice(elseAt + 1, chainEnd + 1)].join('\n')
        elseNodes = extractNodes(chain, contextNames, helpers, visited, source, baseLineOffset + elseAt)
      }

      if (thenNodes.length > 0 || elseNodes.length > 0) {
        // Only the else side does durable work: draw it as the then side of the negated condition
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

        // Land on the last line of the chain; the for loop's i++ moves past it.
        i = chainEnd
        continue
      }
    }

    // for / while / async for → loop node followed by the loop body
    const loopMatch = line.replace(/\s+#.*$/, '').match(/^(?:async\s+)?(for|while)\s+(.+?)\s*:$/)
    if (loopMatch) {
      const header = loopMatch[2].trim()
      const loopBody = extractPythonBlock(body, lineStarts[i] + lines[i].length)
      const bodyFirstLine = blockFirstLine(i)
      const bodyNodes = extractNodes(loopBody, contextNames, helpers, visited, source, baseLineOffset + bodyFirstLine)

      if (bodyNodes.length > 0) {
        const iterations = loopMatch[1] === 'for' ? pythonLoopIterations(header) : undefined
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
        // Land on the last body line; the for loop's i++ moves past it.
        i = bodyFirstLine + loopBody.split('\n').length - 1
        continue
      }
    }

    // Check for durable primitive calls
    // The leftmost durable call on the line is the statement; later ones are nested in its arguments
    let firstCall = ''
    let firstAt = Infinity
    for (const contextName of contextNames) {
      for (const method of Object.keys(PRIMITIVES)) {
        const at = line.search(new RegExp(`${contextName}\\.${method}\\s*\\(`))
        if (at !== -1 && at < firstAt) { firstAt = at; firstCall = `${contextName}.${method}` }
      }
    }

    let matched = false
    for (const contextName of contextNames) {
      if (matched) break
      for (const [method, info] of Object.entries(PRIMITIVES)) {
        const callPattern = new RegExp(`${contextName}\\.${method}\\s*\\(`)
        if (`${contextName}.${method}` !== firstCall) continue

        matched = true
        let callLines = 1
        const nameArg = extractNameArg(line, lines, i)

        const node: WorkflowNode = {
          id: nextId(info.idPrefix),
          kind: info.kind,
          label: nameArg ?? method.replace(/_/g, ' '),
          sourceLine: absLine,
        }

        if (info.kind === 'invoke') {
          const fnMatch = line.match(/function_name\s*=\s*["']([^"']+)["']/)
            ?? line.match(/invoke\s*\(\s*["']([^"']+)["']/)
          if (fnMatch) node.target = fnMatch[1]
          const tenantMatch = extractPythonConfig(lines, i).tenantId
          if (tenantMatch) node.tenantId = tenantMatch
        }

        if (info.kind === 'parallel' || info.kind === 'map') {
          node.branches = extractPythonBranches(info.kind, {
            contextNames, helpers, visited, source, lines, startLine: i, baseLineOffset,
          })
          // The call's own name=, not one from a ParallelBranch(name=...) inside it
          const call = extractCallText(lines, i, '\n')
          const args = splitTopLevel(callArgs(call, call.indexOf('(', call.search(callPattern))))
          const topName = args.map((a) => a.match(/^name\s*=\s*["']([^"']+)["']$/)?.[1]).find(Boolean)
          if (topName) node.label = topName
          // Branch bodies live in node.branches; don't rescan the call's argument lines.
          callLines = call.split('\n').length
          const config = extractPythonConfig(lines, i)
          if (config.nestingType) node.nestingType = config.nestingType
          if (config.completionConfig) node.completionConfig = config.completionConfig
          if (config.maxConcurrency != null) node.maxConcurrency = config.maxConcurrency
        }

        if (info.kind === 'runInChildContext') {
          const config = extractPythonConfig(lines, i)
          if (config.nestingType) node.nestingType = config.nestingType
          const call = extractCallText(lines, i, '\n')
          const args = splitTopLevel(callArgs(call, call.indexOf('(', call.search(callPattern))))
          const topName = args.map((a) => a.match(/^name\s*=\s*["']([^"']+)["']$/)?.[1]).find(Boolean)
          if (topName) node.label = topName
          const callback = args.find((a) => !/^\w+\s*=[^=]/.test(a)) ?? keywordArg(args, 'func')
          const branches = callback && callbackBranches(node.label, callback, {
            contextNames, helpers, visited, source, lines, startLine: i, baseLineOffset,
          })
          if (branches) node.branches = branches
          // The callback's calls live in node.branches; don't rescan the call's argument lines.
          callLines = call.split('\n').length
        }

        if (info.kind === 'step') {
          const config = extractPythonConfig(lines, i)
          if (config.stepSemantics) node.stepSemantics = config.stepSemantics
        }

        nodes.push(node)
        i += callLines - 1
        break
      }
    }

    // Check for helper function calls (only if no primitive matched)
    if (!matched) {
      // Check for standalone with_retry(context, ...) call
      const multiLineText = lines.slice(i, i + 10).join(' ')
      const withRetryPattern = new RegExp(`with_retry\\s*\\(\\s*(${contextNames.join('|')})`)
      if (withRetryPattern.test(multiLineText) && /^(?:return\s+|\w+(?:\s*:[^=]+)?\s*=\s*)?with_retry\s*\(/.test(line)) {
        matched = true
        const call = extractCallText(lines, i, '\n')
        const args = splitTopLevel(callArgs(call, call.indexOf('(', call.search(/with_retry\s*\(/))))
        const topName = args.map((a) => a.match(/^name\s*=\s*["']([^"']+)["']$/)?.[1]).find(Boolean)
        const nameMatch = multiLineText.match(/with_retry\s*\([\s\S]*?name\s*=\s*["']([^"']+)["']/)
        const config = extractPythonConfig(lines, i)
        const node: WorkflowNode = {
          id: nextId('retry'),
          kind: 'withRetry',
          label: topName ?? nameMatch?.[1] ?? 'with_retry',
          nestingType: config.nestingType,
          sourceLine: absLine,
        }
        // with_retry(context, func, config, name=...)
        const callback = args.filter((a) => !/^\w+\s*=[^=]/.test(a))[1] ?? keywordArg(args, 'func')
        const branches = callback && callbackBranches(node.label, callback, {
          contextNames, helpers, visited, source, lines, startLine: i, baseLineOffset,
        })
        if (branches) node.branches = branches
        nodes.push(node)
        i += call.split('\n').length - 1
      }
    }

    if (!matched) {
      for (const [funcName, helperBody] of helpers) {
        if (line.includes(`${funcName}(`) && !visited.has(funcName)) {
          visited.add(funcName)
          const helperOffset = lineOfSubstring(source, helperBody)
          const inlined = extractNodes(helperBody, contextNames, helpers, visited, source, helperOffset)
          nodes.push(...inlined)
          visited.delete(funcName)
        }
      }
    }
  }

  return nodes
}

/**
 * Extract the name= keyword argument from a Python call.
 * Priority: string name= > variable name= > function reference.
 */
function extractNameArg(line: string, lines: string[], lineIdx: number): string | undefined {
  // Build the full call text by matching parentheses from this line
  const callText = extractCallText(lines, lineIdx)
  // Explicit name= string literal is most reliable
  const strMatch = callText.match(/name\s*=\s*["']([^"']+?)["']/)
  if (strMatch) return strMatch[1]
  // Function reference from first positional arg (more descriptive than unresolved variable)
  const fnMatch = callText.match(/\.\w+\s*\(\s*(\w+)\s*\(/)
  if (fnMatch) return fnMatch[1]
  // Variable-based name= as last resort (name=comp_name)
  const varMatch = callText.match(/name\s*=\s*(\w+?)\s*[,)]/)
  if (varMatch) return varMatch[1]
  return undefined
}

/**
 * Extract the full call text from lines starting at lineIdx, matching parentheses.
 * Returns text from the method call up to and including the matching closing paren.
 */
function extractCallText(lines: string[], lineIdx: number, sep = ' '): string {
  let depth = 0
  let started = false
  const parts: string[] = []
  for (let i = lineIdx; i < lines.length; i++) {
    parts.push(lines[i])
    for (const ch of lines[i]) {
      if (ch === '(') { started = true; depth++ }
      else if (ch === ')') depth--
    }
    if (started && depth === 0) break
  }
  return parts.join(sep)
}

/**
 * Extract config-level flags from a Python durable call's surrounding lines.
 */
interface PythonConfigFlags {
  nestingType?: string
  completionConfig?: string
  stepSemantics?: string
  tenantId?: string
  maxConcurrency?: number
}

function extractPythonConfig(lines: string[], lineIdx: number): PythonConfigFlags {
  const flags: PythonConfigFlags = {}
  const searchText = lines.slice(lineIdx, lineIdx + 10).join(' ')

  const nesting = searchText.match(/["']?\s*nesting_type\s*["']?\s*[=:]\s*NestingType\.(\w+)/)
  if (nesting) flags.nestingType = nesting[1]

  const completion = searchText.match(/["']?\s*completion_config\s*["']?\s*[=:]\s*CompletionConfig\.(\w+)\(/)
  if (completion) flags.completionConfig = completion[1].replace(/_/g, ' ')

  const semantics = searchText.match(/["']?\s*step_semantics\s*["']?\s*[=:]\s*StepSemantics\.(\w+)/)
  if (semantics) flags.stepSemantics = semantics[1].replace(/_/g, ' ').replace(/AT MOST ONCE PER RETRY/i, 'AtMostOncePerRetry').replace(/AT LEAST ONCE PER RETRY/i, 'AtLeastOncePerRetry')

  const tenant = searchText.match(/["']?\s*tenant_id\s*["']?\s*[=:]\s*["']([^"']+)["']/)
  if (tenant) flags.tenantId = tenant[1]

  const concurrency = searchText.match(/["']?\s*max_concurrency\s*["']?\s*[=:]\s*(\d+)/)
  if (concurrency) flags.maxConcurrency = Number(concurrency[1])

  return flags
}

/** Remove `# ...` comments that sit outside strings. */
function stripComments(text: string): string {
  let out = ''
  let quote = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === '\\') { out += ch + (text[++i] ?? ''); continue }
      if (ch === quote) quote = ''
    } else if (ch === '"' || ch === "'") quote = ch
    else if (ch === '#') {
      while (i < text.length && text[i] !== '\n') i++
      if (i < text.length) out += '\n'
      continue
    }
    out += ch
  }
  return out
}

/** Split on commas that sit outside brackets, strings and lambda parameter lists. */
function splitTopLevel(raw: string): string[] {
  const text = stripComments(raw)
  const parts: string[] = []
  let depth = 0
  let quote = ''
  let start = 0
  let lambdaParams = /^\s*(?:\w+\s*=\s*)?lambda\b/.test(text)
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = ''
    } else if (ch === '"' || ch === "'") quote = ch
    else if ('([{'.includes(ch)) depth++
    else if (')]}'.includes(ch)) depth--
    else if (ch === ':' && depth === 0) lambdaParams = false
    else if (ch === ',' && depth === 0 && !lambdaParams) {
      parts.push(text.slice(start, i))
      start = i + 1
      lambdaParams = /^\s*(?:\w+\s*=\s*)?lambda\b/.test(text.slice(start))
    }
  }
  parts.push(text.slice(start))
  return parts.map((p) => p.trim()).filter(Boolean)
}

/** Text between the parentheses of a call, starting at its opening `(`. */
function callArgs(text: string, open: number): string {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++
    else if (text[i] === ')' && --depth === 0) return text.slice(open + 1, i)
  }
  return text.slice(open + 1)
}

interface BranchContext {
  contextNames: string[]
  helpers: Map<string, string>
  visited: Set<string>
  source: string
  /** Lines and absolute line offset of the block holding the parallel/map call. */
  lines: string[]
  startLine: number
  baseLineOffset: number
}

/** One branch expression plus where it sits in the source; `generated` = element of a comprehension/map(). */
interface BranchItem {
  expr: string
  bc: BranchContext
  generated?: boolean
}

/**
 * Build the branches of a parallel/map call by parsing what each branch runs.
 * parallel: `[fn, lambda ctx: ..., ParallelBranch(func=..., name="x")]`, a variable holding
 * such a list (plus later append/extend/+=), or a comprehension / `list(map(...))`.
 * map: `(items, fn_or_lambda, ...)` → one dynamic branch.
 */
function extractPythonBranches(kind: 'parallel' | 'map', bc: BranchContext): WorkflowBranch[] {
  const callText = extractCallText(bc.lines, bc.startLine, '\n')
  const open = callText.search(new RegExp(`\\.${kind}\\s*\\(`))
  if (open === -1) return []
  const args = splitTopLevel(callArgs(callText, callText.indexOf('(', open)))
  const positional = args.filter((a) => !/^\w+\s*=[^=]/.test(a))
  const keyword = (key: string) => keywordArg(args, key)

  if (kind === 'map') {
    const fn = positional[1] ?? keyword('func')
    return fn ? [{ ...toBranch(resolveBranchNodes(fn, bc, 0)), dynamic: true }] : []
  }
  const listText = positional[0] ?? keyword('functions')
  const items = listText ? resolveList(listText, bc, 0) : undefined
  return (items ?? []).map((item) => {
    const resolved = resolveBranchNodes(item.expr, item.bc, 0)
    if (!item.generated) return toBranch(resolved)
    const label = resolved.name !== 'branch' ? resolved.name : item.expr.replace(/\s+/g, ' ').slice(0, 40)
    return { ...toBranch({ name: label, nodes: resolved.nodes }), name: 'each item', dynamic: true }
  })
}

/** Value of `key=value` among split call arguments. */
function keywordArg(args: string[], key: string): string | undefined {
  return args.find((a) => new RegExp(`^${key}\\s*=[^=]`).test(a))?.replace(/^\w+\s*=\s*/, '')
}

/** A child-context / with_retry callback as one branch named after the call, or undefined if nothing durable runs. */
function callbackBranches(label: string, callback: string, bc: BranchContext): WorkflowBranch[] | undefined {
  const { nodes } = resolveBranchNodes(callback, bc, 0)
  return nodes.length > 0 ? [{ name: label, dynamic: false, nodes }] : undefined
}

/** Lines from `start` until brackets opened there are closed, joined with newlines. */
function balancedText(lines: string[], start: number): string {
  let depth = 0
  let j = start
  for (; j < lines.length; j++) {
    for (const ch of lines[j].replace(/#.*$/, '')) {
      if ('([{'.includes(ch)) depth++
      else if (')]}'.includes(ch)) depth--
    }
    if (depth <= 0) break
  }
  return lines.slice(start, j + 1).join('\n')
}

/** Whether `name` is passed as the branch list / callback of a later parallel/map call. */
function usedAsBranches(name: string, lines: string[], from: number): boolean {
  const asArg = new RegExp(`^(?:(?:functions|func)\\s*=\\s*)?${name}$`)
  for (let j = from + 1; j < lines.length; j++) {
    const call = lines[j].search(/\.(?:parallel|map)\s*\(/)
    if (call === -1) continue
    const text = extractCallText(lines, j, '\n')
    const args = splitTopLevel(callArgs(text, text.indexOf('(', call)))
    if (args.some((a) => asArg.test(a))) return true
  }
  return false
}

/** Index of a comprehension's top-level `for` inside list text, or -1. */
function comprehensionFor(inner: string): number {
  let depth = 0
  let quote = ''
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = ''
    } else if (ch === '"' || ch === "'") quote = ch
    else if ('([{'.includes(ch)) depth++
    else if (')]}'.includes(ch)) depth--
    else if (depth === 0 && /\sfor\s/.test(inner.slice(i, i + 5))) return i
  }
  return -1
}

/** Branch expressions of a list-valued expression, or undefined when it can't be read. */
function resolveList(text: string, bc: BranchContext, depth: number): BranchItem[] | undefined {
  if (depth > 10) return undefined
  const list = text.match(/^\[([\s\S]*)\]$/)
  if (list) {
    const at = comprehensionFor(list[1])
    if (at !== -1) return [{ expr: list[1].slice(0, at).trim(), bc, generated: true }]
    // Point each item at its own line, so repeated lambdas don't all resolve to the first
    let cursor = bc.startLine
    return splitTopLevel(list[1]).map((expr) => {
      const firstLine = expr.split('\n')[0]
      const at = bc.lines.findIndex((l, j) => j >= cursor && l.includes(firstLine))
      if (at !== -1) cursor = at + expr.split('\n').length - 1
      return { expr, bc: at === -1 ? bc : { ...bc, startLine: at } }
    })
  }
  const call = text.match(/^(list|map)\s*\(/)
  if (call && text.endsWith(')')) {
    const inner = callArgs(text, call[0].length - 1)
    if (call[1] === 'map') {
      // map(f, xs) calls f once per item, so f is a factory like `make(x)`
      const fn = splitTopLevel(inner)[0]
      return fn ? [{ expr: /^\w+$/.test(fn) ? `${fn}(item)` : fn, bc, generated: true }] : undefined
    }
    return resolveList(comprehensionFor(inner) !== -1 ? `[${inner}]` : inner.trim(), bc, depth + 1)
  }
  if (/^\w+$/.test(text)) return resolveVariable(text, bc, depth + 1)?.items
  return undefined
}

/** Line index → index of the innermost enclosing `def` line (-1 = module level, -2 = blank). */
function defOwners(src: string[]): number[] {
  const owners: number[] = []
  const stack: { indent: number; def: number }[] = []
  src.forEach((l, j) => {
    if (!l.trim()) { owners.push(-2); return }
    const indent = l.length - l.trimStart().length
    while (stack.length && indent <= stack[stack.length - 1].indent) stack.pop()
    owners.push(stack.length ? stack[stack.length - 1].def : -1)
    if (/^\s*(?:async\s+)?def\s/.test(l)) stack.push({ indent, def: j })
  })
  return owners
}

/**
 * Resolve a variable as Python scoping would: the nearest assignment before the call in the
 * enclosing function, then each enclosing function outwards, then module level.
 * Returns the list items it holds, including later `.append` / `.extend` / `+=` in that scope.
 */
function resolveVariable(name: string, bc: BranchContext, depth: number): { text: string; bc: BranchContext; items?: BranchItem[] } | undefined {
  const src = bc.source.split('\n')
  const owners = defOwners(src)
  const callIdx = Math.min(bc.baseLineOffset + bc.startLine - 1, src.length - 1)
  const assign = new RegExp(`^(\\s*)${name}\\s*=(?!=)\\s*`)
  const ctx = (j: number): BranchContext => ({ ...bc, lines: src, startLine: j, baseLineOffset: 1 })

  let found = -1
  for (let scope = owners[callIdx]; found === -1; scope = owners[scope]) {
    // Module-level names may be bound anywhere in the file before the handler runs
    const limit = scope === -1 ? src.length : callIdx
    for (let j = limit - 1; j >= 0; j--) {
      if (owners[j] === scope && assign.test(src[j])) { found = j; break }
    }
    if (scope === -1) break
  }
  if (found === -1) return undefined

  const text = balancedText(src, found).slice(assign.exec(src[found])![0].length).trim()
  const items = resolveList(text, ctx(found), depth + 1)
  if (items) {
    const mutation = new RegExp(`^\\s*${name}\\s*(?:\\.\\s*(append|extend)\\s*\\(|\\+=\\s*)`)
    for (let k = found + 1; k < callIdx; k++) {
      const m = owners[k] === owners[found] ? mutation.exec(src[k]) : null
      if (!m) continue
      const stmt = balancedText(src, k)
      const arg = m[1] ? splitTopLevel(callArgs(stmt, m[0].length - 1))[0] : stmt.slice(m[0].length).trim()
      if (!arg) continue
      if (m[1] === 'append') items.push({ expr: arg, bc: ctx(k) })
      else items.push(...(resolveList(arg, ctx(k), depth + 1) ?? []))
    }
  }
  return { text, bc: ctx(found), items }
}

function toBranch({ name, nodes }: { name: string; nodes: WorkflowNode[] }): WorkflowBranch {
  return {
    name,
    dynamic: false,
    nodes: nodes.length > 0 ? nodes : [{ id: nextId('step'), kind: 'step', label: name }],
  }
}

/** Nodes run by one branch expression; empty nodes = nothing durable found (caller adds a placeholder). */
function resolveBranchNodes(item: string, bc: BranchContext, depth: number): { name: string; nodes: WorkflowNode[] } {
  if (depth > 10) return { name: 'branch', nodes: [] }

  // ParallelBranch(func=..., name="x") or similar wrapper
  const wrapper = item.match(/^(\w+)\s*\(([\s\S]*)\)$/)
  const wrapperArgs = wrapper ? splitTopLevel(wrapper[2]) : []
  const funcArg = keywordArg(wrapperArgs, 'func')
    ?? (wrapper?.[1] === 'ParallelBranch' ? wrapperArgs.find((a) => !/^\w+\s*=[^=]/.test(a)) : undefined)
  if (wrapper && funcArg) {
    const inner = resolveBranchNodes(funcArg, bc, depth + 1)
    const name = wrapperArgs.map((a) => a.match(/^name\s*=\s*["']([^"']+)["']$/)?.[1]).find(Boolean)
    return name ? { ...inner, name } : inner
  }

  const lambda = item.match(/^lambda\s*([^:]*):([\s\S]*)$/)
  if (lambda) {
    const param = lambda[1].split(',')[0].trim()
    const firstLine = item.split('\n')[0]
    const rel = bc.lines.findIndex((l, j) => j >= bc.startLine && l.includes(firstLine))
    const nodes = extractNodes(lambda[2].trim(), param ? [...bc.contextNames, param] : bc.contextNames,
      bc.helpers, bc.visited, bc.source, bc.baseLineOffset + Math.max(rel, bc.startLine))
    return { name: 'branch', nodes }
  }

  // A variable holding a lambda / wrapper / factory call
  const ident = item.match(/^(\w+)(\s*\([\s\S]*\))?$/)
  if (!ident) return { name: 'branch', nodes: [] }
  const fnName = ident[1]
  if (!ident[2]) {
    const assigned = resolveVariable(fnName, bc, depth + 1)
    if (assigned && /^(?:lambda\b|\w+\s*\()/.test(assigned.text)) {
      const branch = resolveBranchNodes(assigned.text, assigned.bc, depth + 1)
      return branch.name === 'branch' ? { ...branch, name: fnName } : branch
    }
  }

  // A same-file function: its body, or for a factory call `make(x)`, what it returns
  const def = new RegExp(`def\\s+${fnName}\\s*\\(\\s*(\\w*)[^)]*\\)[^:]*:`).exec(bc.source)
  if (!def || bc.visited.has(fnName)) return { name: fnName, nodes: [] }
  const body = extractPythonBlock(bc.source, def.index + def[0].length)
  const bodyLine = lineOfSubstring(bc.source, body)
  bc.visited.add(fnName)
  let nodes = extractNodes(body, def[1] ? [...bc.contextNames, def[1]] : bc.contextNames,
    bc.helpers, bc.visited, bc.source, bodyLine)
  if (nodes.length === 0 && ident[2]) {
    const bodyLines = body.split('\n')
    let ret = bodyLines.length - 1
    while (ret >= 0 && !/^\s*return\s+\S/.test(bodyLines[ret])) ret--
    if (ret !== -1) {
      const retExpr = bodyLines[ret].trim().replace(/^return\s+/, '')
      nodes = resolveBranchNodes(retExpr, { ...bc, lines: bc.source.split('\n'), startLine: bodyLine + ret - 1, baseLineOffset: 1 }, depth + 1).nodes
    }
  }
  bc.visited.delete(fnName)
  const decorated = bc.source.slice(0, def.index).match(/@\w+\s*\(\s*name\s*=\s*["']([^"']+)["']\s*\)\s*$/)
  return { name: decorated?.[1] ?? fnName, nodes }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export class PythonParser implements Parser {
  extensions = ['.py']

  parseFile(filePath: string, options?: ParseOptions): WorkflowGraph {
    resetIds()

    const source = readFileSync(filePath, 'utf-8')
    const fileName = basename(filePath, '.py')
    const name = options?.name ?? fileName

    const handlerBody = extractHandlerBody(source)
    if (!handlerBody) {
      throw new Error(`No @durable_execution handler found in ${filePath}`)
    }

    const contextNames = findContextParam(source)
    const helpers = findHelperFunctions(source, contextNames)

    const handlerOffset = lineOfSubstring(source, handlerBody)
    const workflowNodes = extractNodes(handlerBody, contextNames, helpers, new Set(), source, handlerOffset)

    const startNode: WorkflowNode = { id: 'node_start', kind: 'start', label: 'Start' }
    const endNode: WorkflowNode = { id: 'node_end', kind: 'end', label: 'End' }
    const allNodes = [startNode, ...workflowNodes, endNode]
    const edges = buildEdges(allNodes)

    return { name, nodes: allNodes, edges }
  }
}
