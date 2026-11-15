/**
 * Go parser for the AWS Durable Execution SDK for Go (preview).
 *
 * Uses regex-based parsing to find `durable.Start(handler)` entry points and
 * extract the package-level generic primitive functions. The Go SDK uses
 * free functions whose first argument is the durable Context and whose second
 * argument is the operation name:
 *
 *   durable.Step(ctx, "greet", func(sc durable.StepContext) (string, error) { ... })
 *   durable.Wait(ctx, "cooling-off", 5*time.Second)
 *   durable.Invoke[Receipt](ctx, "charge", paymentFnArn, order, durable.WithTenantID("t1"))
 *   durable.Parallel(ctx, "fanout", []durable.Branch[string]{
 *       {Name: "a", Func: func(ctx durable.Context) (string, error) { ... }},
 *   }, durable.WithMaxConcurrency(2))
 *
 * Concurrency combinators `All`, `AllSettled`, `Any`, `Race`, and `Select`
 * map to the promise-combinator kinds. `Go` runs durable work concurrently on
 * a child context and maps to runInChildContext.
 *
 * Structural scanning (brace/paren matching, argument splitting) is done over
 * a length-preserving "mask" of the source in which string, rune, and comment
 * contents are blanked. Positions and line numbers therefore line up with the
 * original text, while delimiters that appear inside strings, runes, or
 * comments cannot confuse the scanner.
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
// Primitive mapping: Go function name → graph NodeKind
// ---------------------------------------------------------------------------

interface PrimitiveInfo {
  kind: WorkflowNode['kind']
  idPrefix: string
}

const PRIMITIVES: Record<string, PrimitiveInfo> = {
  'Step': { kind: 'step', idPrefix: 'step' },
  'StepAsync': { kind: 'step', idPrefix: 'step' },
  'Invoke': { kind: 'invoke', idPrefix: 'invoke' },
  'InvokeAsync': { kind: 'invoke', idPrefix: 'invoke' },
  'Parallel': { kind: 'parallel', idPrefix: 'parallel' },
  'ParallelMixed': { kind: 'parallel', idPrefix: 'parallel' },
  'Map': { kind: 'map', idPrefix: 'map' },
  'Wait': { kind: 'wait', idPrefix: 'wait' },
  'WaitAsync': { kind: 'wait', idPrefix: 'wait' },
  'WaitForCallback': { kind: 'waitForCallback', idPrefix: 'callback' },
  'CreateCallback': { kind: 'createCallback', idPrefix: 'createcb' },
  'WaitForCondition': { kind: 'waitForCondition', idPrefix: 'waitcond' },
  'RunInChildContext': { kind: 'runInChildContext', idPrefix: 'child' },
  'RunInChildContextAsync': { kind: 'runInChildContext', idPrefix: 'child' },
  'Go': { kind: 'runInChildContext', idPrefix: 'go' },
  'Retry': { kind: 'withRetry', idPrefix: 'retry' },
  'All': { kind: 'promiseAll', idPrefix: 'all' },
  'Join': { kind: 'promiseAll', idPrefix: 'join' },
  'AllSettled': { kind: 'promiseAllSettled', idPrefix: 'allsettled' },
  'Any': { kind: 'promiseAny', idPrefix: 'any' },
  'Race': { kind: 'promiseRace', idPrefix: 'race' },
  'Select': { kind: 'promiseRace', idPrefix: 'select' },
}

const METHOD_NAMES = Object.keys(PRIMITIVES)

// ---------------------------------------------------------------------------
// Length-preserving masking of strings, runes, and comments
// ---------------------------------------------------------------------------

/**
 * Return a copy of `text` with the contents of string literals, rune
 * literals, and comments replaced by spaces. Newlines and the overall length
 * are preserved, so an index into the mask is also a valid index into the
 * original text.
 */
function maskCode(text: string): string {
  const out = text.split('')
  const len = text.length
  const blank = (i: number) => {
    if (out[i] !== '\n') out[i] = ' '
  }

  let i = 0
  while (i < len) {
    const ch = text[i]
    const next = text[i + 1]

    if (ch === '/' && next === '/') {
      while (i < len && text[i] !== '\n') {
        blank(i)
        i++
      }
      continue
    }

    if (ch === '/' && next === '*') {
      blank(i)
      blank(i + 1)
      i += 2
      while (i < len && !(text[i] === '*' && text[i + 1] === '/')) {
        blank(i)
        i++
      }
      if (i < len) {
        blank(i)
        blank(i + 1)
        i += 2
      }
      continue
    }

    if (ch === '"' || ch === '`' || ch === "'") {
      const quote = ch
      blank(i)
      i++
      while (i < len) {
        if (quote !== '`' && text[i] === '\\') {
          blank(i)
          i++
          if (i < len) {
            blank(i)
            i++
          }
          continue
        }
        if (text[i] === quote) {
          blank(i)
          i++
          break
        }
        blank(i)
        i++
      }
      continue
    }

    i++
  }

  return out.join('')
}

// ---------------------------------------------------------------------------
// Generic Go parsing helpers
// ---------------------------------------------------------------------------

/** Find the package alias used for the durable SDK import (default "durable"). */
function findPackageAlias(source: string): string {
  const match = source.match(/(\w+)\s+"github\.com\/aws\/aws-durable-execution-sdk-go\/durable"/)
  const alias = match?.[1]
  if (!alias || alias === 'import') return 'durable'
  return alias
}

/**
 * Extract a brace-delimited block whose opening brace is at `openIdx`.
 * `mask` is `maskCode(text)`; braces inside strings/comments are ignored.
 * Returns the block content without the outer braces.
 */
function extractBlock(text: string, mask: string, openIdx: number): string {
  let depth = 1
  let i = openIdx + 1
  while (i < text.length && depth > 0) {
    const ch = mask[i]
    if (ch === '{') depth++
    else if (ch === '}') depth--
    i++
  }
  return text.slice(openIdx + 1, i - 1)
}

/** Compute the 1-based line number of a substring within the full source. */
function lineOfSubstring(source: string, substring: string): number {
  const idx = source.indexOf(substring)
  if (idx === -1) return 0
  return source.slice(0, idx).split('\n').length
}

/**
 * Find the handler body: the named function passed to `<alias>.Start()` or
 * `<alias>.Wrap()` (or an inline function literal).
 */
function extractHandlerBody(
  source: string,
  alias: string,
): { name?: string; body: string; offset: number } | null {
  const mask = maskCode(source)
  const entryPattern = new RegExp(`\\b${alias}\\.(?:Start|Wrap)(?:\\[[^\\]]*\\])?\\s*\\(`)
  const entry = entryPattern.exec(mask)
  if (!entry) return null

  const argStart = entry.index + entry[0].length
  const argHead = mask.slice(argStart, argStart + 120)

  // Inline function literal: Start(func(ctx durable.Context, ...) ... { ... })
  if (/^\s*func\s*\(/.test(argHead)) {
    const braceIdx = mask.indexOf('{', argStart)
    if (braceIdx === -1) return null
    const body = extractBlock(source, mask, braceIdx)
    return { body, offset: lineOfSubstring(source, body) }
  }

  // Named function: Start(handler) → func handler(...) { ... }
  const nameMatch = argHead.match(/^\s*(\w+)\s*[,)]/)
  if (!nameMatch) return null
  const fnName = nameMatch[1]
  const fnPattern = new RegExp(`\\bfunc\\s+${fnName}\\s*\\(`)
  const fnMatch = fnPattern.exec(mask)
  if (!fnMatch) return null

  const braceIdx = findSignatureBrace(mask, fnMatch.index + fnMatch[0].length)
  if (braceIdx === -1) return null
  const body = extractBlock(source, mask, braceIdx)
  return { name: fnName, body, offset: lineOfSubstring(source, body) }
}

/**
 * Find the opening brace of a function body, skipping the parameter and
 * result lists. Go result types may themselves contain parentheses (e.g.
 * `(O, error)`), so scan for the first `{` at paren depth zero.
 */
function findSignatureBrace(mask: string, startIdx: number): number {
  let depth = 0
  for (let i = startIdx; i < mask.length; i++) {
    const ch = mask[i]
    if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (ch === '{' && depth <= 0) return i
    else if (ch === ';' && depth <= 0) return -1
  }
  return -1
}

/**
 * Find helper functions that accept a durable Context and contain durable
 * operations, so their calls can be inlined at the call site.
 */
function findHelperFunctions(
  source: string,
  alias: string,
  entryHandler?: string,
): Helpers {
  const helpers: Helpers = new Map()
  const mask = maskCode(source)
  // Optional receiver `(s *T)` / `(T)` / `(s *T[K])`, then name and params.
  const funcPattern = new RegExp(`\\bfunc\\s+(?:\\(\\s*(?:(\\w+)\\s+)?\\*?(\\w+)(?:\\[[^\\]]*\\])?\\s*\\)\\s*)?(\\w+)\\s*\\(([^)]*${alias}\\.Context[^)]*)\\)`, 'g')
  const callPattern = new RegExp(`\\b${alias}\\.(?:${METHOD_NAMES.join('|')})\\b`)

  let match
  while ((match = funcPattern.exec(mask)) !== null) {
    const [, recvName, recvType, funcName] = match
    if (!recvType && funcName === entryHandler) continue

    const bodyStart = match.index + match[0].length
    const braceIdx = findSignatureBrace(mask, bodyStart)
    if (braceIdx === -1) continue
    const body = extractBlock(source, mask, braceIdx)

    if (callPattern.test(body)) {
      // Another function only sees package-level names: its scope is this map.
      helpers.set(recvType ? `${recvType}.${funcName}` : funcName, {
        kind: 'func',
        body,
        offset: lineOfSubstring(source, body),
        scope: helpers,
        recv: recvType && recvName ? [recvName, recvType] : undefined,
      })
    }
  }

  return helpers
}

/**
 * Collect a call's text by matching parentheses. Parentheses inside strings
 * and comments are ignored via the mask; the returned text is the original.
 */
function collectCallText(
  lines: string[],
  maskLines: string[],
  startLine: number,
  startChar: number,
): { text: string; endLine: number } {
  let depth = 0
  let started = false
  const parts: string[] = []

  for (let i = startLine; i < lines.length; i++) {
    const segment = i === startLine ? lines[i].slice(startChar) : lines[i]
    const maskSegment = i === startLine ? maskLines[i].slice(startChar) : maskLines[i]
    parts.push(segment)
    for (const ch of maskSegment) {
      if (ch === '(') { started = true; depth++ }
      else if (ch === ')') depth--
    }
    if (started && depth <= 0) return { text: parts.join('\n'), endLine: i }
  }
  return { text: parts.join('\n'), endLine: lines.length - 1 }
}

/** Split a call's top-level comma-separated arguments, respecting nesting and literals. */
function splitTopLevelArgs(text: string): string[] {
  const open = text.indexOf('(')
  if (open < 0) return []
  const args: string[] = []
  let depth = 1
  let current = ''
  let i = open + 1

  while (i < text.length) {
    const ch = text[i]

    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i += 2
      continue
    }
    if (ch === '"' || ch === '`' || ch === "'") {
      const quote = ch
      current += ch
      i++
      while (i < text.length) {
        current += text[i]
        if (quote !== '`' && text[i] === '\\') {
          i++
          if (i < text.length) current += text[i]
          i++
          continue
        }
        if (text[i] === quote) { i++; break }
        i++
      }
      continue
    }

    if (ch === '(' || ch === '[' || ch === '{') {
      depth++
      current += ch
      i++
      continue
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth--
      if (depth === 0) { args.push(current); break }
      current += ch
      i++
      continue
    }
    if (ch === ',' && depth === 1) {
      args.push(current)
      current = ''
      i++
      continue
    }
    current += ch
    i++
  }

  return args.map((a) => a.trim())
}

/**
 * Find a durable primitive call on a line. Handles optional generic type
 * arguments (including nested brackets) between the function name and the
 * opening paren, e.g. `durable.Invoke[map[string]int, []Foo](`.
 */
function findCallOnLine(
  maskLine: string,
  alias: string,
): { method: string; index: number; openParen: number } | null {
  const re = new RegExp(`\\b${alias}\\.(\\w+)`, 'g')
  let match
  while ((match = re.exec(maskLine)) !== null) {
    const method = match[1]
    if (!(method in PRIMITIVES)) continue

    let k = match.index + match[0].length
    while (maskLine[k] === ' ' || maskLine[k] === '\t') k++

    if (maskLine[k] === '[') {
      let depth = 0
      do {
        const ch = maskLine[k]
        if (ch === '[') depth++
        else if (ch === ']') depth--
        k++
      } while (k < maskLine.length && depth > 0)
      while (maskLine[k] === ' ' || maskLine[k] === '\t') k++
    }

    if (maskLine[k] === '(') {
      return { method, index: match.index, openParen: k }
    }
  }
  return null
}

/** Resolve a name/string argument to a display label. */
function labelFromArg(arg: string | undefined, source?: string): string | undefined {
  if (!arg) return undefined
  const str = arg.match(/^"((?:[^"\\]|\\.)*)"$/)
  if (str) return str[1] || undefined
  const raw = arg.match(/^`([^`]*)`$/)
  if (raw) return raw[1] || undefined
  if (/^[A-Za-z_][\w.]*$/.test(arg)) {
    if (source) {
      const resolved = resolveGoStringConst(source, arg)
      if (resolved !== undefined) return resolved || undefined
    }
    return arg
  }
  return undefined
}

/** Resolve `ident := "literal"` (or `=`, or `const ident =`) from the source. */
function resolveGoStringConst(source: string, ident: string): string | undefined {
  const match = source.match(new RegExp(`\\b${ident}\\s*:?=\\s*"((?:[^"\\\\]|\\\\.)*)"`))
  return match?.[1]
}

/** Default label for an unnamed operation, matching the lowercase style of the other parsers. */
function defaultLabel(method: string): string {
  const base = method.replace(/Async$/, '')
  return base.charAt(0).toLowerCase() + base.slice(1)
}

// ---------------------------------------------------------------------------
// Config extraction
// ---------------------------------------------------------------------------

interface GoConfigFlags {
  nestingType?: string
  completionConfig?: string
  stepSemantics?: string
  tenantId?: string
  maxConcurrency?: number
  retryStrategy?: string
  timeout?: string
}

function extractGoConfig(callText: string, alias: string): GoConfigFlags {
  const flags: GoConfigFlags = {}

  const nesting = callText.match(/WithNesting\s*\(\s*(?:\w+\.)?Nesting(Nested|Flat)/)
  if (nesting) flags.nestingType = nesting[1].toUpperCase()
  if (new RegExp(`WithChildVirtual\\s*\\(`).test(callText)) flags.nestingType = 'FLAT'

  const concurrency = callText.match(/WithMaxConcurrency\s*\(\s*(\d+)/)
  if (concurrency) flags.maxConcurrency = Number(concurrency[1])

  const completion = callText.match(new RegExp(`WithCompletion\\s*\\(\\s*(?:\\w+\\.)?CompletionConfig\\s*\\{([\\s\\S]*?)\\}`))
  if (completion) {
    const parts: string[] = []
    const min = completion[1].match(/MinSuccessful\s*:\s*(\d+)/)
    if (min) parts.push(`minSuccessful:${min[1]}`)
    const count = completion[1].match(/ToleratedFailureCount\s*:\s*(?:\w+\.Int\()?\s*(\d+)/)
    if (count) parts.push(`toleratedFailures:${count[1]}`)
    const pct = completion[1].match(/ToleratedFailurePercentage\s*:\s*(?:\w+\.Int\()?\s*(\d+)/)
    if (pct) parts.push(`toleratedPct:${pct[1]}%`)
    flags.completionConfig = parts.length > 0 ? parts.join(' ') : 'completion'
  }

  const semantics = callText.match(/WithSemantics\s*\(\s*(?:\w+\.)?(AtMostOncePerRetry|AtLeastOncePerRetry)/)
  if (semantics) flags.stepSemantics = semantics[1]

  const tenant = callText.match(/WithTenantID\s*\(\s*"([^"]+)"/)
  if (tenant) flags.tenantId = tenant[1]

  const retry = callText.match(/WithRetry\s*\(\s*([^,)]+?)\s*\)/)
  if (retry) {
    const strategy = retry[1].trim()
    const named = strategy.match(new RegExp(`(?:${alias}\\.)?(\\w+)\\s*(?:\\(|$)`))
    flags.retryStrategy = named?.[1] ?? strategy
  }

  const timeout = callText.match(/With(?:Callback|CallbackHeartbeat)Timeout\s*\(\s*([^)]+?)\s*\)/)
  if (timeout) flags.timeout = timeout[1].trim()

  return flags
}

// ---------------------------------------------------------------------------
// Branch extraction
// ---------------------------------------------------------------------------

/** Branch literals added to a slice: the slice literal or an `append(...)` call. */
type BranchPart = { text: string; offset: number; dynamic: boolean }

/**
 * What a name means at a point in the code. Package-level functions are keyed
 * by name and methods by `Type.name`; local variables are added per block.
 */
type Binding =
  | { kind: 'func'; body: string; offset: number; scope?: Helpers; recv?: [string, string]; params?: string[] }
  | { kind: 'branches'; parts: BranchPart[]; loopDepth: number }
  | { kind: 'branch'; text: string; offset: number }
  | { kind: 'value'; type: string }
type Helpers = Map<string, Binding>

/** Resolve `fn` or `v.method` to a function binding and its visited-key. */
function resolveRef(ref: string | undefined, helpers: Helpers): { key: string; fn: Extract<Binding, { kind: 'func' }> } | undefined {
  const m = ref?.trim().match(/^(\w+)(?:\.(\w+))?$/)
  if (!m) return undefined
  const [, head, method] = m
  let key = head
  if (method) {
    const recv = helpers.get(head)
    if (recv?.kind === 'value') key = `${recv.type}.${method}`
    else if (recv) return undefined
    else {
      // Receiver type unknown: accept the method only if one type defines it.
      const candidates = [...helpers.keys()].filter((k) => k.endsWith(`.${method}`))
      if (candidates.length !== 1) return undefined
      key = candidates[0]
    }
  }
  const fn = helpers.get(key)
  return fn?.kind === 'func' ? { key, fn } : undefined
}

/** Nodes from a function reference (`fn`, `s.method`), via the helpers map. */
function nodesFromRef(
  ref: string | undefined,
  contextNames: string[],
  helpers: Helpers,
  visited: Set<string>,
  source: string,
  alias: string,
): WorkflowNode[] {
  const resolved = resolveRef(ref, helpers)
  if (!resolved || visited.has(resolved.key)) return []
  const { key, fn } = resolved
  let scope = fn.scope ?? helpers
  if (fn.recv) scope = new Map(scope).set(fn.recv[0], { kind: 'value', type: fn.recv[1] })
  visited.add(key)
  const nodes = extractNodes(fn.body, contextNames, scope, visited, source, fn.offset, alias)
  visited.delete(key)
  return nodes
}

/**
 * Extract the durable operations inside the function literal whose `func`
 * keyword is at `funcIdx` in `text`. `text` starts on line `lineOffset`.
 */
function extractCallbackNodes(
  text: string,
  mask: string,
  funcIdx: number,
  contextNames: string[],
  helpers: Helpers,
  visited: Set<string>,
  source: string,
  lineOffset: number,
  alias: string,
): WorkflowNode[] {
  const braceIdx = findSignatureBrace(mask, funcIdx + 'func'.length)
  if (braceIdx === -1) return []
  const body = extractBlock(text, mask, braceIdx)

  const childContextNames = new Set(contextNames)
  const paramMatch = mask.slice(funcIdx, braceIdx).match(/(\w+)\s+\w+\.Context\b/)
  if (paramMatch) childContextNames.add(paramMatch[1])

  // The body text starts on the brace line.
  const bodyOffset = lineOffset + text.slice(0, braceIdx).split('\n').length - 1
  return extractNodes(body, [...childContextNames], helpers, visited, source, bodyOffset, alias)
}

/** Whether a block's last statement is a `return`. */
function endsWithReturn(block: string): boolean {
  return /^return\b/.test(block.trim().split('\n').at(-1)?.trim() ?? '')
}

/**
 * Scan an if header from just after `if`: the block's `{` is the first one
 * outside brackets (Go needs parentheses around composite literals there),
 * and `semi` the last top-level `;`, which ends the init statement.
 */
function ifHeader(mask: string, from: number): { brace: number; semi: number } {
  let depth = 0
  let semi = -1
  for (let k = from; k < mask.length; k++) {
    const ch = mask[k]
    if (ch === '{' && depth === 0) return { brace: k, semi }
    if ('([{'.includes(ch)) depth++
    else if (')]}'.includes(ch)) depth--
    else if (ch === ';' && depth === 0) semi = k
  }
  return { brace: -1, semi }
}

/** Index of the closing brace of the whole `if ... {} else if ... {} else {}` chain starting at `ifIdx`. */
function ifChainEnd(mask: string, ifIdx: number): number {
  let k = ifIdx
  for (;;) {
    const close = matchClose(mask, ifHeader(mask, k + 2).brace)
    const next = mask.slice(close + 1).match(/^[ \t]*else\s*/)
    if (!next) return close
    k = close + 1 + next[0].length
    if (mask[k] === '{') return matchClose(mask, k)
  }
}

/** Index of the bracket closing the one at `open` (in masked code). */
function matchClose(mask: string, open: number): number {
  let depth = 0
  for (let i = open; i < mask.length; i++) {
    if ('([{'.includes(mask[i])) depth++
    else if (')]}'.includes(mask[i]) && --depth === 0) return i
  }
  return mask.length
}

/** `[start, end)` ranges of the comma-separated items in `mask[from, to)`. */
function topLevelItems(mask: string, from: number, to: number): Array<[number, number]> {
  const items: Array<[number, number]> = []
  let depth = 0
  let itemStart = from
  for (let i = from; i <= to; i++) {
    const ch = mask[i]
    if (i === to || (ch === ',' && depth === 0)) {
      let s = itemStart
      let e = i
      while (s < e && /\s/.test(mask[s])) s++
      while (e > s && /\s/.test(mask[e - 1])) e--
      if (e > s) items.push([s, e])
      itemStart = i + 1
    } else if ('([{'.includes(ch)) depth++
    else if (')]}'.includes(ch)) depth--
  }
  return items
}

/**
 * Extract parallel/select branches from a branch list: the first `{...}` in
 * `text` (a slice literal, or the slice argument of a Parallel call), or the
 * added items of an `append(s, ...)` call. Each item is a branch literal,
 * `NewTypedBranch(name, fn)`, a branch variable, or a call to a local
 * branch-returning func. Items appended inside a loop become one dynamic branch.
 */
function extractBranches(
  text: string,
  contextNames: string[],
  helpers: Helpers,
  visited: Set<string>,
  source: string,
  lineOffset: number,
  alias: string,
  dynamic = false,
): WorkflowBranch[] {
  const mask = maskCode(text)
  const app = mask.match(/^\s*append\s*\(/)
  const open = app ? app[0].length - 1 : mask.indexOf('{')
  if (open === -1) return []
  const items = topLevelItems(mask, open + 1, matchClose(mask, open)).slice(app ? 1 : 0)
  const branches = items.flatMap(([s, e]) =>
    branchesFromItem(text, mask, s, e, contextNames, helpers, visited, source, lineOffset, alias))
  return dynamic ? branches.map((b) => ({ ...b, name: 'each item', dynamic: true })) : branches
}

function branchesFromItem(
  text: string,
  mask: string,
  s: number,
  e: number,
  contextNames: string[],
  helpers: Helpers,
  visited: Set<string>,
  source: string,
  lineOffset: number,
  alias: string,
): WorkflowBranch[] {
  const expr = mask.slice(s, e)
  const literalHead = new RegExp(`^&?(?:(?:${alias}\\.)?Branch\\s*(?:\\[[^{]*\\])?\\s*)?\\{`)

  // `{Name: ..., Func: ...}` or `durable.Branch[T]{...}`
  const literal = expr.match(literalHead)
  if (literal) {
    const open = s + literal[0].length - 1
    const branch = branchFromLiteral(text, mask, open, matchClose(mask, open), contextNames, helpers, visited, source, lineOffset, alias)
    return branch ? [branch] : []
  }

  // durable.NewTypedBranch("name", func(ctx durable.Context) (T, error) {...})
  if (new RegExp(`^${alias}\\.NewTypedBranch\\b`).test(expr)) {
    const args = splitTopLevelArgs(text.slice(s, e))
    const name = labelFromArg(args[0]?.trim(), source) ?? 'branch'
    const funcIdx = expr.search(/\bfunc\s*\(/)
    const nodes = funcIdx === -1
      ? nodesFromRef(args[1], contextNames, helpers, visited, source, alias)
      : extractCallbackNodes(text, mask, s + funcIdx, contextNames, helpers, visited, source, lineOffset, alias)
    return [{ name, dynamic: false, nodes: nodes.length > 0 ? nodes : [{ id: nextId('step'), kind: 'step', label: name }] }]
  }

  // A branch variable, or `others...` spread into an append
  const ident = expr.match(/^(\w+)\s*(\.\.\.)?$/)
  if (ident) {
    const bound = helpers.get(ident[1])
    if (bound?.kind === 'branch') {
      return branchesFromItem(bound.text, maskCode(bound.text), 0, bound.text.length, contextNames, helpers, visited, source, bound.offset, alias)
    }
    if (bound?.kind === 'branches' && ident[2]) {
      return bound.parts.flatMap((p) => extractBranches(p.text, contextNames, helpers, visited, source, p.offset, alias, p.dynamic))
    }
    return []
  }

  // branch("a", ...) where `branch := func(name string, ...) durable.Branch[T] { return durable.Branch[T]{...} }`
  const call = expr.match(/^(\w+)\s*\(/)
  const factory = call ? resolveRef(call[1], helpers) : undefined
  if (factory) {
    const { fn } = factory
    const bodyMask = maskCode(fn.body)
    const ret = new RegExp(`\\breturn\\s+${literalHead.source.slice(1)}`).exec(bodyMask)
    if (!ret) return []
    const open = ret.index + ret[0].length - 1
    const args = splitTopLevelArgs(text.slice(s, e))
    const subst = new Map((fn.params ?? []).map((p, i) => [p, args[i]?.trim() ?? p]))
    const branch = branchFromLiteral(fn.body, bodyMask, open, matchClose(bodyMask, open), contextNames, fn.scope ?? helpers, visited, source, fn.offset, alias, subst)
    return branch ? [branch] : []
  }
  return []
}

function branchFromLiteral(
  callText: string,
  mask: string,
  start: number,
  end: number,
  contextNames: string[],
  helpers: Helpers,
  visited: Set<string>,
  source: string,
  callLineOffset: number,
  alias: string,
  // Factory parameter → call argument, for `Name: name` inside a factory.
  subst?: Map<string, string>,
): WorkflowBranch | null {
  // Blank everything nested inside the literal so only its own fields match.
  let nest = 0
  let top = ''
  for (let i = start + 1; i < end; i++) {
    const ch = mask[i]
    if ('({['.includes(ch)) nest++
    top += nest > 0 && ch !== '\n' ? ' ' : ch
    if (')}]'.includes(ch)) nest--
  }
  // No trailing \s*: string values are blanked in the mask and would be eaten.
  const nameMatch = /\bName\s*:/.exec(top)
  const funcMatch = /\bFunc\s*:/.exec(top)
  if (!nameMatch && !funcMatch) return null

  let name = 'branch'
  if (nameMatch) {
    const valueIdx = start + 1 + nameMatch.index + nameMatch[0].length
    const raw = callText.slice(valueIdx).match(/^\s*("(?:[^"\\]|\\.)*"|`[^`]*`|[A-Za-z_][\w.]*)/)?.[1]
    const value = (raw && subst?.get(raw)) ?? raw
    name = labelFromArg(value, source) ?? 'branch'
  }

  let nodes: WorkflowNode[] = []
  if (funcMatch) {
    let valueIdx = start + 1 + funcMatch.index + funcMatch[0].length
    while (/\s/.test(mask[valueIdx])) valueIdx++
    if (/^func\b/.test(mask.slice(valueIdx))) {
      nodes = extractCallbackNodes(callText, mask, valueIdx, contextNames, helpers, visited, source, callLineOffset, alias)
    } else {
      nodes = nodesFromRef(mask.slice(valueIdx).match(/^[\w.]+/)?.[0], contextNames, helpers, visited, source, alias)
    }
  }

  return {
    name,
    dynamic: false,
    nodes: nodes.length > 0 ? nodes : [{ id: nextId('step'), kind: 'step', label: name }],
  }
}

/**
 * Map has no named branches; extract the durable operations inside its
 * per-item callback into a single representative branch.
 */
function extractMapBranch(
  callText: string,
  contextNames: string[],
  helpers: Helpers,
  visited: Set<string>,
  source: string,
  callLineOffset: number,
  alias: string,
): WorkflowBranch[] {
  const mask = maskCode(callText)
  const funcIdx = mask.search(/\bfunc\s*\(/)
  // Map(ctx, name, items, fn): the callback may be a variable or function name.
  const inner = funcIdx === -1
    ? nodesFromRef(splitTopLevelArgs(callText)[3], contextNames, helpers, visited, source, alias)
    : extractCallbackNodes(callText, mask, funcIdx, contextNames, helpers, visited, source, callLineOffset, alias)
  if (funcIdx === -1 && inner.length === 0) return []

  return [{
    name: 'each item',
    dynamic: false,
    nodes: inner.length > 0
      ? inner
      : [{ id: nextId('step'), kind: 'step', label: 'process item' }],
  }]
}

// ---------------------------------------------------------------------------
// Core extraction logic
// ---------------------------------------------------------------------------

/**
 * Count iterations for Go loops with literal bounds:
 * `for i := 0; i < 3; i++`, `for range 3` and `for i := range 3`.
 */
function goLoopIterations(header: string): number | undefined {
  const counted = header.match(/^(\w+)\s*:?=\s*(\d+)\s*;\s*(\w+)\s*(<=|<)\s*(\d+)\s*;\s*(?:(\w+)\+\+|(\w+)\s*\+=\s*1)$/)
  if (counted) {
    const [, variable, start, conditionVariable, operator, limit, incrementA, incrementB] = counted
    if (conditionVariable !== variable || (incrementA ?? incrementB) !== variable) return undefined
    const count = Number(limit) - Number(start) + (operator === '<=' ? 1 : 0)
    return count > 0 ? count : undefined
  }
  const ranged = header.match(/^(?:\w+\s*:?=\s*)?range\s+(\d+)$/)
  if (ranged) {
    const count = Number(ranged[1])
    return count > 0 ? count : undefined
  }
  return undefined
}

function extractNodes(
  body: string,
  contextNames: string[],
  helpers: Helpers,
  visited: Set<string>,
  source: string,
  baseLineOffset: number,
  alias = 'durable',
  loopDepth = 0,
): WorkflowNode[] {
  const nodes: WorkflowNode[] = []
  // Local declarations are added to a copy, so they stay scoped to this block
  // (and visible to the blocks and func literals nested in it).
  helpers = new Map(helpers)
  const declPattern = new RegExp(`^(?:var\\s+(\\w+)[^=]*=(?!=)|(\\w+)\\s*:?=(?!=))\\s*(func\\s*\\(|\\[\\]\\s*${alias}\\.(?:Any)?Branch\\b|${alias}\\.(?:Branch|NewTypedBranch)\\b)`)
  const emptyBranchesPattern = new RegExp(`^(?:var\\s+(\\w+)\\s+\\[\\]\\s*${alias}\\.(?:Any)?Branch\\b[^=]*$|(\\w+)\\s*:=\\s*make\\s*\\(\\s*\\[\\]\\s*${alias}\\.(?:Any)?Branch\\b)`)
  const valuePattern = /^(?:var\s+(\w+)\s+\*?(\w+)\s*(?:=.*)?$|(\w+)\s*:?=\s*(?:&?(\w+)\s*\{|new\s*\(\s*(\w+)\s*\)))/
  const appendPattern = /^(\w+)\s*=\s*append\s*\(\s*(\w+)\s*,/
  const lines = body.split('\n')
  const bodyMask = maskCode(body)
  const maskLines = bodyMask.split('\n')

  // Character offset of each line within `body`, for locating braces.
  const lineStarts: number[] = []
  let acc = 0
  for (const line of lines) {
    lineStarts.push(acc)
    acc += line.length + 1
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const maskLine = maskLines[i]
    const trimmed = line.trim()
    const maskTrimmed = maskLine.trim()
    const absLine = baseLineOffset + i

    if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed === '') continue
    if (maskTrimmed === '') continue

    // `fn := func(...) {...}` / `branches := []durable.Branch[T]{...}`: record
    // the declaration for later use (Parallel/Map args, `Func: fn`, `fn(ctx)`)
    // and skip its lines so its durable calls are not emitted here.
    const decl = maskTrimmed.match(declPattern)
    if (decl) {
      const indent = line.length - line.trimStart().length
      const valueIdx = lineStarts[i] + indent + decl[0].length - decl[3].length
      const name = decl[1] ?? decl[2]
      if (decl[3].startsWith('func')) {
        const braceIdx = findSignatureBrace(bodyMask, valueIdx + 4)
        const block = braceIdx === -1 ? '' : extractBlock(body, bodyMask, braceIdx)
        // `x := func() T {...}()` runs in place: scan its body like normal code.
        const invoked = braceIdx !== -1 && /^\s*\(/.test(bodyMask.slice(braceIdx + block.length + 2))
        if (braceIdx !== -1 && !invoked) {
          const braceLine = baseLineOffset + body.slice(0, braceIdx).split('\n').length - 1
          const paramOpen = bodyMask.indexOf('(', valueIdx)
          const params = bodyMask.slice(paramOpen + 1, matchClose(bodyMask, paramOpen))
            .split(',').map((p) => p.trim().match(/^\w+/)?.[0]).filter((p): p is string => !!p)
          // A func literal sees the variables declared before it.
          helpers.set(name, { kind: 'func', body: block, offset: braceLine, scope: new Map(helpers), params })
          // Land on the closing brace line; the for loop's i++ moves past it.
          i = body.slice(0, braceIdx + block.length + 1).split('\n').length - 1
          continue
        }
      } else {
        // The value ends where its first `(` or `{` closes.
        const open = bodyMask.slice(valueIdx).search(/[({]/)
        if (open !== -1) {
          const close = matchClose(bodyMask, valueIdx + open)
          const text = body.slice(valueIdx, close + 1)
          helpers.set(name, decl[3].startsWith('[]')
            ? { kind: 'branches', parts: [{ text, offset: absLine, dynamic: false }], loopDepth }
            : { kind: 'branch', text, offset: absLine })
          i = body.slice(0, close).split('\n').length - 1
          continue
        }
      }
    }

    // `var bs []durable.Branch[T]` / `bs := make([]durable.Branch[T], ...)`
    const empty = maskTrimmed.match(emptyBranchesPattern)
    if (empty) {
      helpers.set(empty[1] ?? empty[2], { kind: 'branches', parts: [], loopDepth })
      continue
    }

    // `bs = append(bs, durable.Branch[T]{...}, ...)`: add to the slice in order.
    const appended = maskTrimmed.match(appendPattern)
    const target = appended && helpers.get(appended[2])
    if (appended && target?.kind === 'branches') {
      const indent = line.length - line.trimStart().length
      const { text, endLine } = collectCallText(lines, maskLines, i, indent + maskTrimmed.indexOf('append'))
      const part = { text, offset: absLine, dynamic: loopDepth > target.loopDepth }
      if (appended[1] === appended[2]) target.parts.push(part)
      else helpers.set(appended[1], { kind: 'branches', parts: [...target.parts, part], loopDepth })
      i = endLine
      continue
    }

    // Remember receiver types (`s := &Shipper{}`) to resolve `s.method`.
    const value = maskTrimmed.match(valuePattern)
    if (value) {
      const type = value[2] ?? value[4] ?? value[5]
      if (type) helpers.set(value[1] ?? value[3], { kind: 'value', type })
    }

    // if <condition> { ... } → condition node
    // `if init; cond {`: the init statement runs first, so its durable calls
    // come before the condition, which is labelled with `cond` only.
    if (/^if\b/.test(maskTrimmed)) {
      const ifIdx = lineStarts[i] + line.length - line.trimStart().length
      const { brace: braceIdx, semi } = ifHeader(bodyMask, ifIdx + 2)
      if (braceIdx !== -1) {
        const lineAt = (idx: number) => body.slice(0, idx).split('\n').length - 1
        const condition = body.slice(semi === -1 ? ifIdx + 2 : semi + 1, braceIdx).trim()
        if (semi !== -1) {
          nodes.push(...extractNodes(body.slice(ifIdx + 2, semi), contextNames, helpers, visited, source, absLine, alias, loopDepth))
        }
        const ifBody = extractBlock(body, bodyMask, braceIdx)
        // The body text starts on the brace line.
        const thenNodes = extractNodes(ifBody, contextNames, helpers, visited, source, baseLineOffset + lineAt(braceIdx), alias, loopDepth)

        // `} else {...}` or `} else if ... {...}`: an else-if chain is an else
        // block holding another if, so extract it as one.
        let end = braceIdx + ifBody.length + 1
        let elseNodes: WorkflowNode[] = []
        let elseReturns = false
        const elseHead = bodyMask.slice(end + 1).match(/^[ \t]*else\s*(?=\{|if\b)/)
        if (elseHead) {
          const elseStart = end + 1 + elseHead[0].length
          const isBlock = bodyMask[elseStart] === '{'
          end = isBlock ? matchClose(bodyMask, elseStart) : ifChainEnd(bodyMask, elseStart)
          const elseBody = body.slice(isBlock ? elseStart + 1 : elseStart, isBlock ? end : end + 1)
          elseNodes = extractNodes(elseBody, contextNames, helpers, visited, source, baseLineOffset + lineAt(elseStart), alias, loopDepth)
          elseReturns = isBlock && endsWithReturn(elseBody)
        }
        // Land on the closing brace line; the for loop's i++ moves past it.
        const ifEnd = lineAt(end)

        if (thenNodes.length > 0 || elseNodes.length > 0) {
          // Only the else side does durable work: draw it as the negated condition's then side.
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
          nodes.push(...(flipped ? elseNodes : [...thenNodes, ...elseNodes]))
        }
        // Skip the block even when empty: its appends were already recorded.
        i = ifEnd
        continue
      }
    }

    // for ... { ... } → loop node followed by the loop body. The block opens at
    // the trailing brace, since range headers can contain composite literals.
    if (/^for(?=[\s{])/.test(maskTrimmed) && maskTrimmed.endsWith('{')) {
      const header = trimmed.slice(3, trimmed.length - 1).trim()
      const indent = line.length - line.trimStart().length
      const braceIdx = lineStarts[i] + indent + maskTrimmed.length - 1
      const loopBody = extractBlock(body, bodyMask, braceIdx)
      const bodyNodes = extractNodes(loopBody, contextNames, helpers, visited, source, absLine, alias, loopDepth + 1)
      // Land on the closing brace line; the for loop's i++ moves past it.
      const loopEnd = i + loopBody.split('\n').length - 1

      if (bodyNodes.length > 0) {
        const iterations = goLoopIterations(header)
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
      }
      // Skip the block even when empty: its appends were already recorded.
      i = loopEnd
      continue
    }

    // Durable primitive calls
    const call = findCallOnLine(maskTrimmed, alias)
    if (call) {
      const info = PRIMITIVES[call.method]
      const indent = line.length - line.trimStart().length
      const { text: callText, endLine } = collectCallText(lines, maskLines, i, indent + call.index)
      const args = splitTopLevelArgs(callText)
      const config = extractGoConfig(callText, alias)

      const node: WorkflowNode = {
        id: nextId(info.idPrefix),
        kind: info.kind,
        label: labelFromArg(args[1], source) ?? defaultLabel(call.method),
        sourceLine: absLine,
      }

      if (info.kind === 'invoke') {
        node.target = unquote(args[2])
        if (config.tenantId) node.tenantId = config.tenantId
      }

      if (info.kind === 'wait' && args[2]) {
        node.timeout = args[2]
      }

      if (info.kind === 'waitForCallback' || info.kind === 'createCallback') {
        if (config.timeout) node.timeout = config.timeout
      }

      if (info.kind === 'parallel' || call.method === 'Select') {
        // Parallel/Select(ctx, name, branches): the slice may be a local variable.
        const slice = helpers.get(args[2]?.trim() ?? '')
        node.branches = slice?.kind === 'branches'
          ? slice.parts.flatMap((p) =>
              extractBranches(p.text, contextNames, helpers, visited, source, p.offset, alias, p.dynamic))
          : args[2]?.includes('{')
            ? extractBranches(callText, contextNames, helpers, visited, source, absLine, alias)
            : []
        if (node.branches.length === 0) delete node.branches
      }

      if (info.kind === 'parallel') {
        if (config.nestingType) node.nestingType = config.nestingType
        if (config.completionConfig) node.completionConfig = config.completionConfig
        if (config.maxConcurrency != null) node.maxConcurrency = config.maxConcurrency
      }

      if (info.kind === 'map') {
        node.branches = extractMapBranch(callText, contextNames, helpers, visited, source, absLine, alias)
        if (config.nestingType) node.nestingType = config.nestingType
        if (config.completionConfig) node.completionConfig = config.completionConfig
        if (config.maxConcurrency != null) node.maxConcurrency = config.maxConcurrency
      }

      // RunInChildContext/Go/Retry(ctx, name, fn, ...): draw fn's operations inside.
      if (info.kind === 'runInChildContext' || info.kind === 'withRetry') {
        const funcIdx = maskCode(callText).search(/\bfunc\s*\(/)
        const inner = funcIdx === -1
          ? nodesFromRef(args[2], contextNames, helpers, visited, source, alias)
          : extractCallbackNodes(callText, maskCode(callText), funcIdx, contextNames, helpers, visited, source, absLine, alias)
        if (inner.length > 0) node.branches = [{ name: node.label, dynamic: false, nodes: inner }]
      }

      if (info.kind === 'runInChildContext' && config.nestingType) {
        node.nestingType = config.nestingType
      }

      if (info.kind === 'step') {
        if (config.stepSemantics) node.stepSemantics = config.stepSemantics
        if (config.retryStrategy) node.retryStrategy = config.retryStrategy
      }

      if (info.kind === 'withRetry') {
        const strategyExpr = args[3]?.trim()
        if (strategyExpr) {
          const named = strategyExpr.match(new RegExp(`(?:${alias}\\.)?(\\w+)`))
          node.retryStrategy = named?.[1]
        }
      }

      nodes.push(node)

      // Skip lines consumed by this (possibly multi-line) call.
      i = Math.max(i, endLine)
      continue
    }

    // Helper function following: inline calls to same-file functions that
    // accept a durable Context and contain durable operations.
    for (const [, ref] of maskLine.matchAll(/\b((?:\w+\.)?\w+)\s*\(/g)) {
      const resolved = resolveRef(ref, helpers)
      if (!resolved || visited.has(resolved.key)) continue
      nodes.push(...nodesFromRef(ref, contextNames, helpers, visited, source, alias))
      break
    }
  }

  return nodes
}

/** Strip surrounding quotes from an argument expression. */
function unquote(arg: string | undefined): string | undefined {
  if (!arg) return undefined
  const match = arg.match(/^"((?:[^"\\]|\\.)*)"$/) ?? arg.match(/^`([^`]*)`$/)
  return match ? match[1] : arg.trim() || undefined
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export class GoParser implements Parser {
  extensions = ['.go']

  parseFile(filePath: string, options?: ParseOptions): WorkflowGraph {
    resetIds()

    const source = readFileSync(filePath, 'utf-8')
    const fileName = basename(filePath, '.go')
    const name = options?.name ?? fileName

    const alias = findPackageAlias(source)
    const handler = extractHandlerBody(source, alias)
    if (!handler) {
      throw new Error(`No ${alias}.Start() entry point found in ${filePath}`)
    }

    const contextNames = findContextParams(source, alias)
    const helpers = findHelperFunctions(source, alias, handler.name)
    const workflowNodes = extractNodes(
      handler.body,
      contextNames,
      helpers,
      new Set(),
      source,
      handler.offset,
      alias,
    )

    const startNode: WorkflowNode = { id: 'node_start', kind: 'start', label: 'Start' }
    const endNode: WorkflowNode = { id: 'node_end', kind: 'end', label: 'End' }
    const allNodes = [startNode, ...workflowNodes, endNode]
    const edges = buildEdges(allNodes)

    return { name, nodes: allNodes, edges }
  }
}

/** Find durable Context parameter names from `<name> durable.Context` signatures. */
function findContextParams(source: string, alias: string): string[] {
  const names = new Set<string>()
  const pattern = new RegExp(`(\\w+)\\s+(?:\\w+\\.)?${alias}\\.Context\\b`, 'g')
  let match
  while ((match = pattern.exec(source)) !== null) {
    names.add(match[1])
  }
  if (names.size === 0) {
    names.add('ctx')
    names.add('context')
  }
  return [...names]
}
