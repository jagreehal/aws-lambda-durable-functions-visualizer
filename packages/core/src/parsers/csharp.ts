/**
 * C# parser for AWS Lambda Durable Execution SDK (.NET).
 *
 * Uses regex-based parsing to find durable workflow functions and extract
 * primitives. The .NET SDK (v1.0.0, GA) uses Async-suffixed
 * methods on IDurableContext:
 *
 *   ctx.StepAsync(...)              → step
 *   ctx.WaitAsync(...)              → wait
 *   ctx.CreateCallbackAsync(...)    → createCallback
 *   ctx.WaitForCallbackAsync(...)   → waitForCallback
 *   ctx.WaitForConditionAsync(...)  → waitForCondition
 *   ctx.RunInChildContextAsync(...) → runInChildContext
 *   ctx.InvokeAsync(...)            → invoke
 *   ctx.ParallelAsync(...)          → parallel
 *   ctx.MapAsync(...)               → map
 *
 * Entry points — two programming models:
 *   Executable:  HandlerWrapper.GetHandlerWrapper + LambdaBootstrap
 *   Class-library: [assembly: LambdaSerializer(...)] + plain Handler
 *
 * Both delegate to DurableFunction.WrapAsync<TInput, TOutput>(Workflow, ...)
 */

import { readFileSync } from 'node:fs'
import type { WorkflowNode, WorkflowBranch, WorkflowGraph } from '../graph.js'
import { buildEdges, loopLabel } from '../graph.js'
import { parseCStyleLoopHead, cStyleLoopIterations, doWhileCondition } from './c-style-loops.js'
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
// Primitive mapping: C# method name → graph NodeKind
// ---------------------------------------------------------------------------

interface PrimitiveInfo {
  kind: WorkflowNode['kind']
  idPrefix: string
}

const PRIMITIVES: Record<string, PrimitiveInfo> = {
  'StepAsync': { kind: 'step', idPrefix: 'step' },
  'WaitAsync': { kind: 'wait', idPrefix: 'wait' },
  'CreateCallbackAsync': { kind: 'createCallback', idPrefix: 'createcb' },
  'WaitForCallbackAsync': { kind: 'waitForCallback', idPrefix: 'callback' },
  'WaitForConditionAsync': { kind: 'waitForCondition', idPrefix: 'waitcond' },
  'RunInChildContextAsync': { kind: 'runInChildContext', idPrefix: 'child' },
  'InvokeAsync': { kind: 'invoke', idPrefix: 'invoke' },
  'ParallelAsync': { kind: 'parallel', idPrefix: 'parallel' },
  'MapAsync': { kind: 'map', idPrefix: 'map' },
}

// ---------------------------------------------------------------------------
// C#-specific parsing
// ---------------------------------------------------------------------------

/**
 * Find the IDurableContext parameter name from all method signatures.
 * Pattern: IDurableContext ctx  or  IDurableContext context
 */
function findContextParam(source: string): string[] {
  const paramPattern = /IDurableContext\s+(\w+)/g
  const names = new Set<string>()
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
 * The workflow argument of DurableFunction.WrapAsync[<TIn, TOut>](workflow, input, context):
 * a method group (`Workflow`, `Workflows.RunAsync`) or a lambda. Generic
 * arguments may nest (`<object, IReadOnlyList<Item>>`).
 */
function findWrapAsyncWorkflowArg(source: string): { start: number; end: number } | null {
  const pattern = /DurableFunction\s*\.\s*WrapAsync\b\s*/g
  let m
  while ((m = pattern.exec(source)) !== null) {
    let i = m.index + m[0].length
    if (source[i] === '<') {
      for (let depth = 0; i < source.length; i++) {
        if (source[i] === '<') depth++
        else if (source[i] === '>' && --depth === 0) break
      }
      i++
      while (/\s/.test(source[i] ?? '')) i++
    }
    if (source[i] !== '(') continue
    const first = splitArgs(source, i, matchParen(source, i))[0]
    if (first) return first
  }
  return null
}

/**
 * Find the workflow method name from the Lambda Annotations model.
 * Pattern: [DurableExecution(...)] decorating a method whose signature
 * contains an IDurableContext parameter. Attributes may appear above in any
 * order (e.g. [LambdaFunction] then [DurableExecution]).
 */
function findAnnotatedWorkflowFunction(source: string): string | null {
  const lines = source.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('[DurableExecution')) continue
    for (let j = i; j < Math.min(i + 4, lines.length); j++) {
      const sigMatch = lines[j].match(/\b([A-Za-z_]\w*)\s*\([^)]*IDurableContext[^)]*\)/)
      if (sigMatch) return sigMatch[1]
    }
  }
  return null
}

/**
 * Find the body of a named method: a `{ ... }` block, or the expression of an
 * expression-bodied member (`=> expr;`). Returns the body and its index in source.
 */
function findMethodBody(source: string, methodName: string): { body: string; start: number } | null {
  const escaped = methodName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(
    `(?:private|protected|public|internal|static|async|\\s)+` +
    `[\\w<>,.?\\[\\]\\s]+\\s+${escaped}\\s*\\([^)]*\\)\\s*(\\{|=>)`
  )
  const match = pattern.exec(source)
  if (!match) return null

  const start = match.index + match[0].length
  const body = match[1] === '{' ? extractBlock(source, start) : source.slice(start, statementEnd(source, start))
  return { body, start }
}

/**
 * Extract a brace-delimited block.
 */
function extractBlock(source: string, startIdx: number): string {
  let depth = 1
  let i = startIdx

  while (i < source.length && depth > 0) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') depth--
    i++
  }

  return source.slice(startIdx, i - 1)
}

/** Count newline characters in body[from, to). */
function countNewlines(body: string, from: number, to: number): number {
  return body.slice(from, to).split('\n').length - 1
}

/**
 * Extract durable primitives from a block of C# code.
 */
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

    // if (condition) { ... } or Allman-style if (condition)\n{ → condition node
    // if / else if / else (K&R or Allman braces, or a braceless single statement).
    // Flat layout: [cond, ...then, ...else]; an else-if is an else holding another condition.
    if (/^if\s*\(/.test(line)) {
      const chain = parseIf(body, lineStarts[i] + (lines[i].length - lines[i].trimStart().length))
      const sideNodes = (side: IfSide | undefined) =>
        side ? extractNodes(side.text, contextNames, source, baseLineOffset + countNewlines(body, 0, side.start)) : []
      const thenNodes = sideNodes(chain.then)
      const elseNodes = sideNodes(chain.else)

      if (thenNodes.length > 0 || elseNodes.length > 0) {
        // Only the else side does durable work: draw it as the then side of the negated condition
        const flipped = thenNodes.length === 0
        const label = flipped ? `!(${chain.condition})` : chain.condition
        nodes.push({
          id: nextId('cond'),
          kind: 'condition',
          label,
          condition: label,
          thenCount: flipped ? elseNodes.length : thenNodes.length,
          thenReturns: endsWithReturn(flipped ? chain.else!.text : chain.then.text),
          ...(!flipped && elseNodes.length > 0
            ? { elseCount: elseNodes.length, elseReturns: endsWithReturn(chain.else!.text) }
            : {}),
          sourceLine: absLine,
        })
        nodes.push(...(flipped ? elseNodes : [...thenNodes, ...elseNodes]))

        // Land on the line holding the chain's last character; the for loop's i++ moves past it.
        i = countNewlines(body, 0, chain.end - 1)
        continue
      }
    }

    // for / foreach / while / do-while → loop node followed by the loop body.
    // The opening brace is either at the end of the line or alone on the next one.
    const loopHead = parseCStyleLoopHead(line)
    if (loopHead && (loopHead.rest === '{' || loopHead.rest === '')) {
      let braceLine = i
      let braceIdx = -1
      if (loopHead.rest === '{') {
        braceIdx = lineStarts[i] + lines[i].replace(/\s*\/\/.*$/, '').trimEnd().length - 1
      } else {
        let next = i + 1
        while (next < lines.length && lines[next].trim() === '') next++
        if (next < lines.length && lines[next].trim() === '{') {
          braceLine = next
          braceIdx = lineStarts[next] + lines[next].indexOf('{')
        }
      }

      if (braceIdx >= 0) {
        const loopBody = extractBlock(body, braceIdx + 1)
        const bodyNodes = extractNodes(loopBody, contextNames, source, baseLineOffset + braceLine)

        if (bodyNodes.length > 0) {
          const header = loopHead.keyword === 'do'
            ? doWhileCondition(body, braceIdx + 1 + loopBody.length)
            : loopHead.header
          const iterations = cStyleLoopIterations(loopHead)
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
          i = braceLine + loopBody.split('\n').length - 1
          continue
        }
      }
    }

    // Statements that only build branches (a collection, `.Add`/`.AddRange`) or a
    // branch/map lambda: their calls belong to the parallel/map that uses them.
    const decl = line.match(/^(?:[\w<>\[\],.?\s]+?\s+)?(\w+)\s*=(?![=>])\s*(.*)$/)
    const add = line.match(/^(\w+)\s*\.\s*Add(?:Range)?\s*\(/)
    if ((decl && !/^(?:await\s+)?\w+\.\w+Async\b/.test(decl[2])) || add) {
      const start = lineStarts[i]
      const end = statementEnd(body, start)
      const builds = BRANCH_TYPE.test(body.slice(start, end)) ||
        (add != null && resolveVariable(source, add[1], sourceIndexOfLine(source, absLine))?.isBranchCollection === true)
      const usedAsFunc = decl != null && LAMBDA_HEAD.test(decl[2]) && new RegExp(
        `(?:${BRANCH_CTOR.source}|MapAsync\\s*(?:<[^>]*>+)?\\s*\\([^;]*?,\\s*(?:\\w+\\s*:\\s*)?)${decl[1]}\\s*[,)]`,
      ).test(body)
      if (builds || usedAsFunc) {
        i += countNewlines(body, start, end)
        continue
      }
    }

    // Durable primitives
    let matched = false
    for (const method of Object.keys(PRIMITIVES)) {
      if (matched) break
      for (const ctxName of contextNames) {
        const callPattern = new RegExp(`${ctxName}\\.${method}\\s*(?:<[^>]+>)?\\s*\\(`)
        if (!callPattern.test(line)) continue

        matched = true
        const info = PRIMITIVES[method]
        const nameArg = extractNameArg(lines, i)

        const node: WorkflowNode = {
          id: nextId(info.idPrefix),
          kind: info.kind,
          label: nameArg ?? method.replace(/Async$/, '').replace(/([A-Z])/g, ' $1').toLowerCase().trim(),
          sourceLine: absLine,
        }

        if (info.kind === 'invoke') {
          const invokeText = joinCallLines(lines, i)
          const fnMatch = invokeText.match(/InvokeAsync\s*<\s*[\w,\s]+\s*>\s*\(\s*(?:functionName:\s*)?\s*"([^"]+)"/)
          if (fnMatch) node.target = fnMatch[1]
          const invokeConfig = extractCSharpConfig(lines, i)
          if (invokeConfig.tenantId) node.tenantId = invokeConfig.tenantId
        }

        let callEndLine = -1
        if (info.kind === 'parallel' || info.kind === 'map' || info.kind === 'runInChildContext') {
          const { branches, endLine } = extractCSharpBranches(lines, i, method, contextNames, source, baseLineOffset)
          if (info.kind !== 'runInChildContext') node.branches = branches
          else if (branches.length > 0) node.branches = branches.map((b) => ({ ...b, name: node.label }))
          callEndLine = endLine
        }

        if (info.kind === 'parallel' || info.kind === 'map') {
          const config = extractCSharpConfig(lines, i)
          if (config.nestingType) node.nestingType = config.nestingType
          if (config.completionConfig) node.completionConfig = config.completionConfig
          if (config.stepSemantics) node.stepSemantics = config.stepSemantics
          if (config.maxConcurrency != null) node.maxConcurrency = config.maxConcurrency
        }

        if (info.kind === 'runInChildContext') {
          const config = extractCSharpConfig(lines, i)
          if (config.nestingType) node.nestingType = config.nestingType
        }

        if (info.kind === 'step') {
          const config = extractCSharpConfig(lines, i)
          if (config.stepSemantics) node.stepSemantics = config.stepSemantics
        }

        nodes.push(node)
        // Branch bodies were parsed above; don't re-read them as top-level calls.
        if (callEndLine > i) i = callEndLine
        break
      }
    }
  }

  return nodes
}

/**
 * Join multiple lines of a method call until parentheses balance.
 */
function joinCallLines(lines: string[], startIdx: number): string {
  let depth = 0
  let started = false
  const parts: string[] = []
  for (let i = startIdx; i < lines.length; i++) {
    parts.push(lines[i])
    for (const ch of lines[i]) {
      if (ch === '(') { started = true; depth++ }
      else if (ch === ')') depth--
    }
    if (started && depth === 0) break
  }
  return parts.join(' ')
}

/**
 * Extract the label from a durable call.
 * Looks for `name: "label"` named argument pattern common in C#.
 */
function extractNameArg(lines: string[], lineIdx: number): string | undefined {
  const callText = joinCallLines(lines, lineIdx)

  // name: "label"  or  name:"label" — only among the call's own arguments,
  // not inside nested calls (e.g. a step in a parallel branch lambda).
  let depth = 0
  let ownArgs = ''
  for (const ch of callText) {
    if (ch === '(') depth++
    if (depth <= 1) ownArgs += ch
    if (ch === ')') depth--
  }
  const nameMatch = ownArgs.match(/name:\s*"([^"]+)"/)
  if (nameMatch) return nameMatch[1]

  // First string argument: ctx.MethodAsync("label"
  const strMatch = callText.match(/\.\w+Async\s*<\s*[\w,\s]+\s*>\s*\(\s*"([^"]+)"/)
  if (strMatch) return strMatch[1]

  // No generics: ctx.MethodAsync("label"
  const simpleStr = callText.match(/\.\w+Async\s*\(\s*"([^"]+)"/)
  if (simpleStr) return simpleStr[1]

  // Function call as first arg: ctx.MethodAsync(FuncName
  const fnMatch = callText.match(/\.\w+Async\s*<\s*[\w,\s]+\s*>\s*\(\s*(\w+)\s*\(/)
  if (fnMatch) return fnMatch[1]

  // Non-generic function arg
  const fnSimple = callText.match(/\.\w+Async\s*\(\s*(\w+)\s*\(/)
  if (fnSimple) return fnSimple[1]

  // Dotted identifier: ctx.MethodAsync(something.Name
  const dottedMatch = callText.match(/\.\w+Async\s*\(\s*(\w+\.\w+)/)
  if (dottedMatch) return dottedMatch[1]

  // Variable reference
  const varMatch = callText.match(/\.\w+Async[\s<][^(]*\(\s*(\w+)\s*[,)]/)
  if (varMatch && !['null', 'true', 'false', 'this'].includes(varMatch[1])) return varMatch[1]

  return undefined
}

/** One side of an if statement: its statements and where they start in the text. */
interface IfSide {
  text: string
  start: number
}

/** Skip whitespace and comments from `idx`. */
function skipTrivia(text: string, idx: number): number {
  for (;;) {
    while (idx < text.length && /\s/.test(text[idx])) idx++
    if (text.startsWith('//', idx)) idx = text.indexOf('\n', idx) < 0 ? text.length : text.indexOf('\n', idx)
    else if (text.startsWith('/*', idx)) idx = text.indexOf('*/', idx) < 0 ? text.length : text.indexOf('*/', idx) + 2
    else return idx
  }
}

/** The statement at `idx`: a `{ block }` (contents only), an if chain, or one statement. */
function parseStatement(text: string, idx: number): IfSide & { end: number } {
  const at = skipTrivia(text, idx)
  if (text[at] === '{') {
    const close = matchBrace(text, at)
    return { text: text.slice(at + 1, close), start: at + 1, end: close + 1 }
  }
  if (/^if\s*\(/.test(text.slice(at, at + 4))) {
    const chain = parseIf(text, at)
    return { text: text.slice(at, chain.end), start: at, end: chain.end }
  }
  const end = Math.min(statementEnd(text, at) + 1, text.length)
  return { text: text.slice(at, end), start: at, end }
}

/** Parse `if (cond) then [else else]` starting at the `if` at `ifIdx`. */
function parseIf(text: string, ifIdx: number): { condition: string; then: IfSide; else?: IfSide; end: number } {
  const open = text.indexOf('(', ifIdx)
  const close = matchParen(text, open)
  const condition = text.slice(open + 1, close).replace(/\s+/g, ' ').trim()
  const thenSide = parseStatement(text, close + 1)
  const after = skipTrivia(text, thenSide.end)
  if (!/^else\b/.test(text.slice(after, after + 5))) return { condition, then: thenSide, end: thenSide.end }
  const elseSide = parseStatement(text, after + 4)
  return { condition, then: thenSide, else: elseSide, end: elseSide.end }
}

/** Does this block's last statement return? */
function endsWithReturn(block: string): boolean {
  return /^return\b/.test(block.trim().split('\n').pop()?.trim() ?? '')
}

/** Index of the `)` matching the `(` at openIdx (or text.length if unbalanced). */
function matchParen(text: string, openIdx: number): number {
  let depth = 0
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === '(') depth++
    else if (text[i] === ')' && --depth === 0) return i
  }
  return text.length
}

/** Index of the `;` ending the statement that starts at `from` (brackets nested), or text.length. */
function statementEnd(text: string, from: number): number {
  let depth = 0
  for (let i = from; i < text.length; i++) {
    const ch = text[i]
    if (ch === '(' || ch === '{' || ch === '[') depth++
    else if (ch === ')' || ch === '}' || ch === ']') depth--
    else if (ch === ';' && depth <= 0) return i
  }
  return text.length
}

/** Top-level argument ranges of the call whose parentheses are at open..close. */
function splitArgs(text: string, open: number, close: number): Array<{ start: number; end: number }> {
  const args: Array<{ start: number; end: number }> = []
  let depth = 0
  let angles = 0 // generic arguments: `Func<A, B>` (a `<` right after an identifier)
  let start = open + 1
  for (let i = open + 1; i <= close; i++) {
    const ch = text[i]
    if (ch === '(' || ch === '{' || ch === '[') depth++
    else if ((ch === ')' || ch === '}' || ch === ']') && i < close) depth--
    else if (ch === '<' && depth === 0 && /\w/.test(text[i - 1] ?? '')) angles++
    else if (ch === '>' && depth === 0 && angles > 0 && text[i - 1] !== '=') angles--
    else if ((ch === ',' && depth === 0 && angles === 0) || i === close) {
      let s = start
      while (s < i && /\s/.test(text[s])) s++
      if (s < i) args.push({ start: s, end: i })
      start = i + 1
    }
  }
  return args
}

/** 1-based source line of a character index in `source`. */
function sourceLineAt(source: string, idx: number): number {
  return countNewlines(source, 0, idx) + 1
}

/** Character index in `source` where 1-based line `line` starts. */
function sourceIndexOfLine(source: string, line: number): number {
  let idx = 0
  for (let n = 1; n < line && idx >= 0; n++) idx = source.indexOf('\n', idx) + 1
  return Math.max(idx, 0)
}

/** Opening braces of the blocks that enclose `idx`, innermost first. */
function enclosingBlocks(source: string, idx: number): number[] {
  const opens: number[] = []
  let depth = 0
  for (let i = idx - 1; i >= 0; i--) {
    if (source[i] === '}') depth++
    else if (source[i] === '{') {
      if (depth === 0) opens.push(i)
      else depth--
    }
  }
  return opens
}

/** Start of the statement/member containing `idx` (just after the previous `;`, `{` or `}`). */
function statementStart(source: string, idx: number): number {
  let i = idx - 1
  while (i >= 0 && !';{}'.includes(source[i])) i--
  return i + 1
}

/** Does the brace depth stay >= 0 from `from` to `to`, i.e. is `from` still in scope at `to`? */
function inScopeAt(source: string, from: number, to: number): boolean {
  let depth = 0
  for (let i = from; i < to; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}' && --depth < 0) return false
  }
  return true
}

interface Declaration {
  /** Start/end of the initializer (end is the `;`). */
  start: number
  end: number
  /** Element type is DurableBranch or a branch Func (declared type or initializer says so). */
  isBranchCollection: boolean
  /** Where to start looking for `.Add` calls: after a local's declaration, or the using method's start for a field. */
  addsFrom: number
}

/**
 * Resolve variable `name` used at `useIdx`: the nearest local assignment before
 * it that is still in scope (walking outward through blocks of the enclosing
 * method), else a field or property of the enclosing class.
 */
function resolveVariable(source: string, name: string, useIdx: number): Declaration | null {
  const blocks = enclosingBlocks(source, useIdx)
  const classPos = blocks.findIndex((o) =>
    /\b(?:class|record|struct)\b/.test(source.slice(statementStart(source, o), o)))
  if (classPos < 0) return null
  const classOpen = blocks[classPos]
  const methodOpen = classPos > 0 ? blocks[classPos - 1] : -1

  const make = (m: RegExpExecArray, isField: boolean): Declaration => {
    const start = m.index + m[0].length
    const end = statementEnd(source, start)
    const isBranchCollection = BRANCH_TYPE.test(source.slice(statementStart(source, m.index), end))
    return { start, end, isBranchCollection, addsFrom: isField ? Math.max(methodOpen, 0) : end }
  }

  if (methodOpen >= 0) {
    const local = new RegExp(`(?<![\\w.])${name}\\s*=(?![=>])\\s*`, 'g')
    local.lastIndex = methodOpen + 1
    let found: Declaration | null = null
    let m
    while ((m = local.exec(source)) !== null && m.index < useIdx) {
      if (inScopeAt(source, m.index, useIdx)) found = make(m, false)
    }
    if (found) return found
  }

  // Field `X = ...;`, property `X => ...;` or auto-property `X { get; } = ...;`
  const classEnd = matchBrace(source, classOpen)
  const member = new RegExp(`(?<![\\w.])${name}\\s*(?:\\{[^{}]*\\}\\s*)?(?:=>|=(?![=>]))\\s*`, 'g')
  member.lastIndex = classOpen + 1
  let m
  while ((m = member.exec(source)) !== null && m.index < classEnd) {
    if (enclosingBlocks(source, m.index)[0] === classOpen) return make(m, true)
  }
  return null
}

/** Index of the `}` matching the `{` at openIdx (or text.length). */
function matchBrace(text: string, openIdx: number): number {
  return openIdx + 1 + extractBlock(text, openIdx + 1).length
}

// Types whose collections hold parallel branches.
const BRANCH_TYPE = /DurableBranch|Func\s*<\s*IDurableContext\b/
// Lambda head: `async (ctx, _) =>`, `(IDurableContext c, CancellationToken _) =>`, `c =>`.
const LAMBDA_HEAD = /^(?:async\s+)?(?:\(\s*(?:[\w.<>?\[\]]+\s+)?(\w+)[^)]*\)|(\w+))\s*=>\s*/
// `new DurableBranch<T>("name", ` (group 1) or target-typed `new("name", `; name may be `$"..."`.
const BRANCH_CTOR = /new\s*(DurableBranch\s*<[^>]*>+\s*)?\(\s*\$?"([^"]*)"\s*,\s*/g
// Text just before a branch constructor built per item: `.Select(x => ` / `.Select((x, i) => `
const SELECT_LAMBDA = /\.Select\s*\(\s*(?:\w+|\([^)]*\))\s*=>\s*$/

/** Helper methods / lambda variables currently being expanded, to stop self-recursion. */
const expanding = new Set<string>()

/**
 * Nodes of the function expression at text[at, end): an inline lambda (block or
 * expression body), a variable or field holding a lambda, or a method group.
 * `lineAt` maps a text index to a source line; `sourceIdx` is where in `source`
 * the expression is used, so variables resolve in that scope.
 */
function funcNodes(
  text: string, at: number, end: number, lineAt: (idx: number) => number,
  contextNames: string[], source: string, sourceIdx: number,
): WorkflowNode[] {
  const fn = text.slice(at, end)
  const lambda = fn.match(LAMBDA_HEAD)
  if (lambda) {
    const param = lambda[1] ?? lambda[2]
    const names = param && param !== '_' ? [...new Set([...contextNames, param])] : contextNames
    const bodyIdx = at + lambda[0].length
    const isBlock = text[bodyIdx] === '{'
    const body = isBlock ? extractBlock(text, bodyIdx + 1) : text.slice(bodyIdx, end)
    return extractNodes(body, names, source, lineAt(isBlock ? bodyIdx + 1 : bodyIdx))
  }

  const ident = fn.match(/^(\w+)\s*$/)?.[1]
  if (!ident || expanding.has(ident)) return []
  expanding.add(ident)
  try {
    const decl = resolveVariable(source, ident, sourceIdx)
    if (decl && LAMBDA_HEAD.test(source.slice(decl.start, decl.end))) {
      return funcNodes(source, decl.start, decl.end, (idx) => sourceLineAt(source, idx), contextNames, source, decl.start)
    }
    const method = findMethodBody(source, ident)
    return method ? extractNodes(method.body, contextNames, source, sourceLineAt(source, method.start)) : []
  } finally {
    expanding.delete(ident)
  }
}

/**
 * Branch constructors in text[from, to). Each constructor is skipped as a whole,
 * so a nested parallel's branches stay with the nested parallel. Target-typed
 * `new("x", fn)` only counts inside `targetTyped` (a range known to hold
 * DurableBranch elements). A constructor inside `.Select(x => ...)` is one
 * dynamic 'each item' branch.
 */
function scanBranches(
  text: string, from: number, to: number, lineAt: (idx: number) => number,
  contextNames: string[], source: string, sourceIdx: number,
  targetTyped: [number, number] | null,
): WorkflowBranch[] {
  const branches: WorkflowBranch[] = []
  const pattern = new RegExp(BRANCH_CTOR.source, 'g')
  pattern.lastIndex = from
  let match
  while ((match = pattern.exec(text)) !== null && match.index < to) {
    const ctorEnd = matchParen(text, text.indexOf('(', match.index + 3))
    if (!match[1] && !(targetTyped && match.index >= targetTyped[0] && match.index < targetTyped[1])) {
      pattern.lastIndex = match.index + 3
      continue
    }
    pattern.lastIndex = ctorEnd
    const perItem = SELECT_LAMBDA.test(text.slice(Math.max(from, match.index - 200), match.index))
    const name = perItem ? 'each item' : match[2]
    let nodes = funcNodes(text, match.index + match[0].length, ctorEnd, lineAt, contextNames, source, sourceIdx)
    if (nodes.length === 0) nodes = [{ id: nextId('step'), kind: 'step', label: name }]
    branches.push({ name, dynamic: perItem, nodes })
  }
  return branches
}

/**
 * Unnamed branch functions (`Func<IDurableContext, CancellationToken, Task<T>>`)
 * as the elements of the collection initializer in text[from, to):
 * `new Func<...>[] { ... }`, `new List<Func<...>> { ... }`, `{ ... }` or `[ ... ]`.
 * With `single`, text[from, to) is one call's parentheses holding one function.
 * Each element is a lambda or a method group; named 'branch' or the method name.
 */
function funcElementBranches(
  text: string, from: number, to: number, lineAt: (idx: number) => number,
  contextNames: string[], source: string, sourceIdx: number, single = false,
): WorkflowBranch[] {
  let elements: Array<{ start: number; end: number }>
  if (single) {
    elements = splitArgs(text, from, to).slice(0, 1)
  } else {
    const head = text.slice(from, to).match(/^\s*(?:branches\s*:\s*)?(?:new\b[^{]*)?([{[])/)
    if (!head) return []
    const open = from + head[0].length - 1
    const close = head[1] === '{' ? matchBrace(text, open) : matchBracket(text, open)
    elements = splitArgs(text, open, close)
  }
  return elements.map(({ start, end }) => {
    const ident = text.slice(start, end).trim().match(/^\w+$/)?.[0]
    const name = ident ?? 'branch'
    const nodes = funcNodes(text, start, end, lineAt, contextNames, source, sourceIdx)
    return { name, dynamic: false, nodes: nodes.length > 0 ? nodes : [{ id: nextId('step'), kind: 'step' as const, label: name }] }
  })
}

/** Index of the `]` matching the `[` at openIdx (or text.length). */
function matchBracket(text: string, openIdx: number): number {
  let depth = 0
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === '[') depth++
    else if (text[i] === ']' && --depth === 0) return i
  }
  return text.length
}

/**
 * Branches held in collection variable `name` at `useIdx`: its initializer, then
 * any `name.Add(...)` / `name.AddRange(...)` in the method before the use.
 */
function collectionBranches(source: string, name: string, useIdx: number, contextNames: string[]): WorkflowBranch[] {
  const decl = resolveVariable(source, name, useIdx)
  if (!decl) return []
  const lineAt = (idx: number) => sourceLineAt(source, idx)
  const typed = (from: number, to: number): [number, number] | null => decl.isBranchCollection ? [from, to] : null
  const scan = (from: number, to: number, at: number) => {
    const found = scanBranches(source, from, to, lineAt, contextNames, source, at, typed(from, to))
    return found.length > 0 ? found : funcElementBranches(source, from, to, lineAt, contextNames, source, at)
  }
  const branches = scan(decl.start, decl.end, decl.start)

  const adds = new RegExp(`(?<![\\w.])${name}\\s*\\.\\s*Add(?:Range)?\\s*\\(`, 'g')
  adds.lastIndex = decl.addsFrom
  let m
  while ((m = adds.exec(source)) !== null && m.index < useIdx) {
    const open = m.index + m[0].length - 1
    const close = matchParen(source, open)
    // `.Add(fn)` holds one element; `.AddRange(new[] { ... })` a collection
    const one = !/AddRange/.test(m[0]) && !/^\s*new\b/.test(source.slice(open + 1, close))
    branches.push(...(one ? funcElementBranches(source, open, close, lineAt, contextNames, source, m.index, true) : scan(open, close, m.index)))
    adds.lastIndex = close
  }
  return branches
}

/**
 * Extract branches from a ParallelAsync / MapAsync / RunInChildContextAsync call starting on lines[startLine].
 *   Parallel: branch constructors in the call, or in a collection variable/field
 *     passed as the branches argument (initializer plus `.Add` / `.AddRange`).
 *   Map: the item function (inline lambda, lambda variable or method group)
 *     becomes one dynamic 'each item' branch; none if it has no durable calls.
 * Returns the branches and the line the call ends on.
 */
function extractCSharpBranches(
  lines: string[],
  startLine: number,
  method: string,
  contextNames: string[],
  source: string,
  baseLineOffset: number,
): { branches: WorkflowBranch[]; endLine: number } {
  const text = lines.join('\n')
  const callStart = lines.slice(0, startLine).reduce((n, l) => n + l.length + 1, 0)
  const callOpen = text.indexOf('(', text.indexOf(method, callStart))
  const callEnd = matchParen(text, callOpen)
  const lineAt = (idx: number) => baseLineOffset + countNewlines(text, 0, idx)
  const sourceIdx = sourceIndexOfLine(source, baseLineOffset + startLine)
  const endLine = startLine + countNewlines(text, callStart, callEnd)
  const args = splitArgs(text, callOpen, callEnd)
  const argText = (a: { start: number; end: number }) => text.slice(a.start, a.end)

  // Map item function / child-context function: one branch, none if nothing durable inside.
  // (A child context's branch is renamed to the node's label by the caller.)
  if (method === 'MapAsync' || method === 'RunInChildContextAsync') {
    for (const arg of args) {
      const at = arg.start + (argText(arg).match(/^\w+\s*:\s*/)?.[0].length ?? 0)
      const nodes = funcNodes(text, at, arg.end, lineAt, contextNames, source, sourceIdx)
      if (nodes.length > 0) return { branches: [{ name: 'each item', dynamic: method === 'MapAsync', nodes }], endLine }
    }
    return { branches: [], endLine }
  }

  // The branches argument: named `branches:` or the first positional one.
  const branchArg = args.find((a) => /^branches\s*:/.test(argText(a))) ?? args.find((a) => !/^\w+\s*:/.test(argText(a)))
  let branches = scanBranches(text, callOpen, callEnd, lineAt, contextNames, source, sourceIdx,
    branchArg ? [branchArg.start, branchArg.end] : null)
  const ident = branchArg && argText(branchArg)
    .replace(/^branches\s*:\s*/, '').replace(/\s*\.\s*To(?:Array|List)\s*\(\s*\)$/, '').trim()
  if (branches.length === 0 && ident && /^\w+$/.test(ident)) {
    branches = collectionBranches(source, ident, sourceIdx, contextNames)
  } else if (branches.length === 0 && branchArg) {
    branches = funcElementBranches(text, branchArg.start, branchArg.end, lineAt, contextNames, source, sourceIdx)
  }
  return { branches, endLine }
}

/**
 * Extract config-level flags from surrounding lines.
 */
interface CSharpConfigFlags {
  nestingType?: string
  completionConfig?: string
  stepSemantics?: string
  tenantId?: string
  maxConcurrency?: number
}

function extractCSharpConfig(lines: string[], lineIdx: number): CSharpConfigFlags {
  const flags: CSharpConfigFlags = {}
  const searchText = lines.slice(lineIdx, lineIdx + 20).join(' ')

  const nesting = searchText.match(/\.NestingType\s*=\s*NestingType\.(\w+)/)
  if (nesting) flags.nestingType = nesting[1]

  const completion = searchText.match(/\.CompletionConfig\s*=\s*CompletionConfig\.(\w+)\(\s*\)/)
  if (completion) flags.completionConfig = completion[1].replace(/([A-Z])/g, ' $1').toLowerCase().trim()

  const semantics = searchText.match(/Semantics\s*=\s*StepSemantics\.(\w+)/)
  if (semantics) flags.stepSemantics = semantics[1]

  const tenant = searchText.match(/TenantId\s*=\s*"([^"]+)"/)
  if (tenant) flags.tenantId = tenant[1]

  const concurrency = searchText.match(/MaxConcurrency\s*=\s*(\d+)/)
  if (concurrency) flags.maxConcurrency = Number(concurrency[1])

  return flags
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export class CSharpParser implements Parser {
  extensions = ['.cs']

  parseFile(filePath: string, options?: ParseOptions): WorkflowGraph {
    resetIds()

    const source = readFileSync(filePath, 'utf-8')
    const fileName = basename(filePath, '.cs')
    const name = options?.name ?? fileName

    const contextNames = findContextParam(source)

    // The workflow passed to DurableFunction.WrapAsync (method group or lambda),
    // or the [DurableExecution] method of the annotations model.
    const wrapArg = findWrapAsyncWorkflowArg(source)
    const wrapText = wrapArg ? source.slice(wrapArg.start, wrapArg.end).trim() : ''
    const lambda = wrapText.match(/^(?:async\s+)?\(\s*\w+\s*,\s*(\w+)\s*\)\s*=>\s*/)
    let workflowNodes: WorkflowNode[]
    if (wrapArg && lambda) {
      contextNames.push(lambda[1])
      const bodyIdx = wrapArg.start + lambda[0].length
      const isBlock = source[bodyIdx] === '{'
      const body = isBlock ? extractBlock(source, bodyIdx + 1) : source.slice(bodyIdx, wrapArg.end)
      workflowNodes = extractNodes(body, contextNames, source, sourceLineAt(source, isBlock ? bodyIdx + 1 : bodyIdx))
    } else {
      // `Workflows.RunAsync` → the RunAsync method in this file
      const workflowName = (/^[\w.]+$/.test(wrapText) ? wrapText.split('.').pop() : null) ?? findAnnotatedWorkflowFunction(source)
      if (!workflowName) {
        throw new Error(`No DurableFunction.WrapAsync call or [DurableExecution] method found in ${filePath}`)
      }
      const workflow = findMethodBody(source, workflowName)
      if (!workflow) {
        throw new Error(`Workflow function '${wrapText || workflowName}' not found in ${filePath} (defined in another file?)`)
      }
      workflowNodes = extractNodes(workflow.body, contextNames, source, sourceLineAt(source, workflow.start))
    }

    const startNode: WorkflowNode = { id: 'node_start', kind: 'start', label: 'Start' }
    const endNode: WorkflowNode = { id: 'node_end', kind: 'end', label: 'End' }
    const allNodes = [startNode, ...workflowNodes, endNode]
    const edges = buildEdges(allNodes)

    return { name, nodes: allNodes, edges }
  }
}
