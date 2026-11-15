/**
 * Java parser for durable function handlers.
 *
 * Uses regex-based parsing to find classes extending DurableHandler
 * and extract durable primitives. Java SDK uses camelCase:
 *
 *   ctx.step()              → step
 *   ctx.invoke()            → invoke
 *   ctx.map()               → map
 *   ctx.wait()              → wait
 *   ctx.waitForCallback()   → waitForCallback
 *   ctx.createCallback()    → createCallback
 *   ctx.waitForCondition()  → waitForCondition
 *   ctx.runInChildContext()  → runInChildContext
 *
 * The Java SDK is GA as of April 2026.
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
// Primitive mapping: Java method name → graph NodeKind
// ---------------------------------------------------------------------------

interface PrimitiveInfo {
  kind: WorkflowNode['kind']
  idPrefix: string
}

const PRIMITIVES: Record<string, PrimitiveInfo> = {
  'step': { kind: 'step', idPrefix: 'step' },
  'invoke': { kind: 'invoke', idPrefix: 'invoke' },
  'map': { kind: 'map', idPrefix: 'map' },
  'wait': { kind: 'wait', idPrefix: 'wait' },
  'waitForCallback': { kind: 'waitForCallback', idPrefix: 'callback' },
  'createCallback': { kind: 'createCallback', idPrefix: 'createcb' },
  'waitForCondition': { kind: 'waitForCondition', idPrefix: 'waitcond' },
  'runInChildContext': { kind: 'runInChildContext', idPrefix: 'child' },
  'parallel': { kind: 'parallel', idPrefix: 'parallel' },
  'withRetry': { kind: 'withRetry', idPrefix: 'retry' },
}

// ---------------------------------------------------------------------------
// Java-specific parsing
// ---------------------------------------------------------------------------

/**
 * Find the DurableContext parameter name from the handleRequest method.
 * Pattern: protected OrderResult handleRequest(Order order, DurableContext ctx)
 */
function findContextParam(source: string): string[] {
  const paramPattern = /DurableContext\s+(\w+)/g
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
 * Find a DurableHandler subclass declaration, handling nested generics.
 * Returns the match index and length, or null.
 */
function findDurableHandlerClass(source: string): { index: number; length: number } | null {
  const pattern = /class\s+(\w+)\s+extends\s+DurableHandler\s*</g
  let match
  while ((match = pattern.exec(source)) !== null) {
    const startIdx = match.index
    let depth = 1
    let i = match.index + match[0].length
    while (i < source.length && depth > 0) {
      if (source[i] === '<') depth++
      else if (source[i] === '>') depth--
      i++
    }
    if (depth === 0) {
      return { index: startIdx, length: i - startIdx }
    }
  }
  return null
}

/**
 * Find a handleRequest method, handling nested generics in return type and params.
 */
function findHandleRequest(source: string, methodName = 'handleRequest'): { index: number; length: number } | null {
  const pattern = new RegExp(`(?:protected|public)\\s+[\\w<>,.\\s]+\\s+${methodName}\\s*\\(`, 'g')
  let match
  while ((match = pattern.exec(source)) !== null) {
    // Verify the parameter list contains DurableContext and find the opening brace
    let depth = 1
    let i = match.index + match[0].length
    let hasDurableContext = false
    while (i < source.length && depth > 0) {
      if (source[i] === '(') depth++
      else if (source[i] === ')') depth--
      else if (depth === 1 && source.slice(i, i + 14) === 'DurableContext') {
        hasDurableContext = true
      }
      i++
    }
    if (depth !== 0 || !hasDurableContext) continue
    // Find the opening brace after the closing paren
    while (i < source.length && source[i] !== '{') i++
    if (i < source.length) {
      return { index: match.index, length: i + 1 - match.index }
    }
  }
  return null
}

/**
 * Extract the handleRequest method body from a DurableHandler subclass.
 */
function extractHandlerBody(source: string): string | null {
  const classMatch = findDurableHandlerClass(source)
  if (!classMatch) return null

  // Some docs examples name the entry method differently (e.g. `handle`): take the first DurableContext method
  const methodMatch = findHandleRequest(source) ?? findHandleRequest(source, '\\w+')
  if (!methodMatch) return null

  const startIdx = methodMatch.index + methodMatch.length
  return extractJavaBlock(source, startIdx)
}

/**
 * Extract a Java block (brace-delimited) starting after an opening brace.
 */
function extractJavaBlock(source: string, startIdx: number): string {
  let depth = 1
  let i = startIdx

  while (i < source.length && depth > 0) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') depth--
    i++
  }

  return source.slice(startIdx, i - 1)
}

/**
 * Find helper methods that accept DurableContext and contain durable calls.
 */
function findHelperMethods(source: string, contextNames: string[]): Map<string, string> {
  const helpers = new Map<string, string>()
  // Match methods with DurableContext parameter (not handleRequest)
  const methodPattern = /(?:private|protected|public)\s+\w+\s+(\w+)\s*\(([^)]*DurableContext[^)]*)\)\s*(?:throws\s+\w+\s*)?\{/g
  let match

  while ((match = methodPattern.exec(source)) !== null) {
    const methodName = match[1]
    if (methodName === 'handleRequest') continue

    const startIdx = match.index + match[0].length
    const body = extractJavaBlock(source, startIdx)

    const hasContextCall = contextNames.some((name) =>
      Object.keys(PRIMITIVES).some((method) =>
        body.includes(`${name}.${method}(`)
      )
    )

    if (hasContextCall) {
      helpers.set(methodName, body)
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

/**
 * Extract durable primitive calls from a block of Java code.
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

  // Character offset of each line within `body`, for locating braces.
  const lineStarts: number[] = []
  let offset = 0
  for (const rawLine of lines) {
    lineStarts.push(offset)
    offset += rawLine.length + 1
  }

  // Lines inside a parallel's `.branch(...)` calls, already handled as branch content.
  const branchLines = new Set<number>()
  const lineAt = (idx: number) => body.slice(0, idx).split('\n').length - 1

  for (let i = 0; i < lines.length; i++) {
    if (branchLines.has(i)) continue
    const line = lines[i].trim()
    const absLine = baseLineOffset + i

    // Skip comments and empty lines
    if (line.startsWith('//') || line.startsWith('/*') || line === '') continue

    // A block (e.g. a loop) holding only `.branch(...)` calls already read as branches
    if (/\{\s*$/.test(line) && !line.includes('->')) {
      const blockStart = lineStarts[i] + lines[i].lastIndexOf('{') + 1
      const endLine = lineAt(blockStart + extractJavaBlock(body, blockStart).length)
      const inner = Array.from({ length: endLine - i - 1 }, (_, k) => i + 1 + k)
      if (inner.some((l) => branchLines.has(l)) && inner.every((l) => branchLines.has(l) || /^\s*\}?\s*$/.test(lines[l]))) {
        i = endLine
        continue
      }
    }

    // `fn = ctx -> { ... }` only declares a lambda; its calls run where it is passed (e.g. a branch)
    const lambdaDecl = line.match(/^[^=(]*\b\w+\s*=\s*(?=(?:\([^()]*\)|\w+)\s*->)/)
    if (lambdaDecl) {
      const lambda = lambdaAt(body, lineStarts[i] + lines[i].indexOf(line) + lambdaDecl[0].length)
      if (lambda) {
        i = lineAt(lambda.end)
        continue
      }
    }

    // if / else if / else wrapping durable calls → [cond, ...then, ...else]
    const ifStmt = /^if\s*\(/.test(line) ? parseIf(body, lineStarts[i] + lines[i].indexOf('if')) : null
    if (ifStmt) {
      const thenNodes = extractNodes(ifStmt.thenText, contextNames, helpers, visited, source, baseLineOffset + lineAt(ifStmt.thenStart))
      const elseNodes = ifStmt.elseText === undefined
        ? []
        : extractNodes(ifStmt.elseText, contextNames, helpers, visited, source, baseLineOffset + lineAt(ifStmt.elseStart!))
      const endsWithReturn = (text: string) => text.trim().split('\n').pop()?.trim().startsWith('return ') ?? false

      if (thenNodes.length > 0 || elseNodes.length > 0) {
        // Only the else side does durable work: draw it as the then side of the negated condition
        const flipped = thenNodes.length === 0
        const label = flipped ? `!(${ifStmt.condition})` : ifStmt.condition
        // An else-if chain is a nested condition, never a trailing return
        const elseReturns = !ifStmt.elseIsIf && endsWithReturn(ifStmt.elseText ?? '')
        nodes.push({
          id: nextId('cond'),
          kind: 'condition',
          label,
          condition: label,
          thenCount: flipped ? elseNodes.length : thenNodes.length,
          thenReturns: flipped ? elseReturns : endsWithReturn(ifStmt.thenText),
          elseCount: flipped ? undefined : elseNodes.length || undefined,
          elseReturns: flipped || elseNodes.length === 0 ? undefined : elseReturns,
          sourceLine: absLine,
        })
        nodes.push(...thenNodes, ...elseNodes)

        // Land on the line of the chain's last closing brace; the for loop's i++ moves past it.
        i = lineAt(ifStmt.end)
        continue
      }
    }

    // for / foreach / while / do-while → loop node followed by the loop body
    const loopHead = parseCStyleLoopHead(line)
    if (loopHead && loopHead.rest === '{') {
      const braceIdx = lineStarts[i] + lines[i].replace(/\s*\/\/.*$/, '').trimEnd().length
      const loopBody = extractJavaBlock(body, braceIdx)
      const bodyNodes = extractNodes(loopBody, contextNames, helpers, visited, source, absLine)

      if (bodyNodes.length > 0) {
        const header = loopHead.keyword === 'do'
          ? doWhileCondition(body, braceIdx + loopBody.length)
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
        i += loopBody.split('\n').length - 1
        continue
      }
    }

    // Check for durable primitive calls
    let matched = false
    for (const contextName of contextNames) {
      if (matched) break
      for (const [method, info] of Object.entries(PRIMITIVES)) {
        // The SDK's *Async variants (stepAsync, runInChildContextAsync, ...) return a DurableFuture: same node
        const callPattern = new RegExp(`\\b${contextName}\\.${method}(?:Async)?\\s*\\(`)
        if (!callPattern.test(line)) continue

        matched = true
        const nameArg = extractNameArg(line, lines, i)

        const node: WorkflowNode = {
          id: nextId(info.idPrefix),
          kind: info.kind,
          label: nameArg ?? method.replace(/([A-Z])/g, ' $1').toLowerCase().trim(),
          sourceLine: absLine,
        }

        if (info.kind === 'invoke') {
          const fnMatch = line.match(/invoke(?:Async)?\s*\(\s*"([^"]+)"/)
          if (fnMatch) node.target = fnMatch[1]
          const config = extractJavaConfig(lines, i)
          if (config.tenantId) node.tenantId = config.tenantId
        }

        if (info.kind === 'parallel' || info.kind === 'map') {
          node.branches = info.kind === 'parallel'
            ? extractJavaBranches(body, i, lineStarts, lineAt, branchLines, contextNames, helpers, visited, source, baseLineOffset)
            : extractCallbackBranch(body, lineStarts[i] + lines[i].search(callPattern), i, lineAt, branchLines, contextNames, helpers, visited, source, baseLineOffset, 'each item', true)
          const config = extractJavaConfig(lines, i)
          if (config.nestingType) node.nestingType = config.nestingType
          if (config.completionConfig) node.completionConfig = config.completionConfig
          if (config.maxConcurrency != null) node.maxConcurrency = config.maxConcurrency
        }

        // A child context or retry wrapper is drawn as a box holding its callback's calls
        if (info.kind === 'runInChildContext' || info.kind === 'withRetry') {
          const inner = extractCallbackBranch(body, lineStarts[i] + lines[i].search(callPattern), i, lineAt, branchLines, contextNames, helpers, visited, source, baseLineOffset, node.label, false)
          if (inner.length > 0) node.branches = inner
        }

        if (info.kind === 'runInChildContext') {
          const config = extractJavaConfig(lines, i)
          if (config.nestingType) node.nestingType = config.nestingType
        }

        if (info.kind === 'step') {
          const config = extractJavaConfig(lines, i)
          if (config.stepSemantics) node.stepSemantics = config.stepSemantics
        }

        nodes.push(node)
        break
      }
    }

    // Check for helper method calls
    if (!matched) {
      // Check for static withRetry(ctx, ...) or instance ctx.withRetry(...)
      const withRetryStatic = new RegExp(`withRetry\\s*\\(\\s*(${contextNames.join('|')})`)
      const withRetryInstance = new RegExp(`(${contextNames.join('|')})\\s*\\.\\s*withRetry\\s*\\(`)
      if (withRetryStatic.test(line) || withRetryInstance.test(line)) {
        matched = true
        const searchText = lines.slice(i, i + 5).join(' ')
        const nameMatch = searchText.match(/(?:withRetry|\.withRetry)\s*\([^,]*,\s*"([^"]+)"/)
        const config = extractJavaConfig(lines, i)
        nodes.push({
          id: nextId('retry'),
          kind: 'withRetry',
          label: nameMatch?.[1] ?? 'withRetry',
          nestingType: config.nestingType,
          sourceLine: absLine,
        })
      }
    }

    // Check for DurableFuture.allOf / anyOf static calls
    if (!matched) {
      const allOfPattern = /DurableFuture\.allOf\s*\(/
      if (allOfPattern.test(line)) {
        matched = true
        nodes.push({
          id: nextId('pall'),
          kind: 'promiseAll',
          label: 'allOf',
          sourceLine: absLine,
        })
      }
    }

    if (!matched) {
      const anyOfPattern = /DurableFuture\.anyOf\s*\(/
      if (anyOfPattern.test(line)) {
        matched = true
        nodes.push({
          id: nextId('pany'),
          kind: 'promiseAny',
          label: 'anyOf',
          sourceLine: absLine,
        })
      }
    }

    if (!matched) {
      for (const [methodName, helperBody] of helpers) {
        if (line.includes(`${methodName}(`) && !visited.has(methodName)) {
          visited.add(methodName)
          const helperOffset = lineOfSubstring(source, helperBody)
          const inlined = extractNodes(helperBody, contextNames, helpers, visited, source, helperOffset)
          nodes.push(...inlined)
          visited.delete(methodName)
        }
      }
    }
  }

  return nodes
}

/**
 * The if statement at body[ifIdx]: its condition, then block, optional else
 * (a block, or an `else if` chain kept as text starting at its `if`), and the
 * index of the statement's last closing brace. Braceless ifs are not handled.
 */
function parseIf(body: string, ifIdx: number): {
  condition: string; thenStart: number; thenText: string
  elseStart?: number; elseText?: string; elseIsIf?: boolean; end: number
} | null {
  const open = body.indexOf('(', ifIdx)
  let close = open + 1
  for (let d = 1; close < body.length; close++) {
    if (body[close] === '(') d++
    else if (body[close] === ')' && --d === 0) break
  }
  const brace = body.slice(close + 1).match(/^\s*\{/)
  if (!brace) return null
  const thenStart = close + 1 + brace[0].length
  const thenText = extractJavaBlock(body, thenStart)
  const stmt = { condition: body.slice(open + 1, close).replace(/\s+/g, ' ').trim(), thenStart, thenText, end: thenStart + thenText.length }
  const els = body.slice(stmt.end + 1).match(/^\s*else\s*/)
  if (!els) return stmt
  const elseAt = stmt.end + 1 + els[0].length
  if (/^if\s*\(/.test(body.slice(elseAt))) {
    const inner = parseIf(body, elseAt)
    return inner && { ...stmt, elseStart: elseAt, elseText: body.slice(elseAt, inner.end + 1), elseIsIf: true, end: inner.end }
  }
  if (body[elseAt] !== '{') return stmt
  const elseText = extractJavaBlock(body, elseAt + 1)
  return { ...stmt, elseStart: elseAt + 1, elseText, end: elseAt + 1 + elseText.length }
}

/**
 * Extract the first string or variable argument (step/invoke name) from a Java call.
 * Handles string literals, dotted identifiers, function calls, and variable references.
 */
function extractNameArg(line: string, lines: string[], lineIdx: number): string | undefined {
  // Build the full call text by matching parentheses from this line (handles multi-line)
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
  const callText = parts.join(' ')
  // String literal: ctx.method("name"
  const strMatch = callText.match(/\.\w+\s*\(\s*"([^"]+)"/)
  if (strMatch) return strMatch[1]
  // Function call as first arg: ctx.method(funcName(...)
  const fnMatch = callText.match(/\.\w+\s*\(\s*(\w+)\s*\(/)
  if (fnMatch) return fnMatch[1]
  // Dotted identifier: ctx.method(comp.name
  const dottedMatch = callText.match(/\.\w+\s*\(\s*(\w+\.\w+)/)
  if (dottedMatch) return dottedMatch[1]
  // Variable reference: ctx.method(varName,
  const varMatch = callText.match(/\.\w+\s*\(\s*(\w+)\s*[,)]/)
  if (varMatch && !['null', 'true', 'false', 'this'].includes(varMatch[1])) return varMatch[1]
  return undefined
}

/**
 * Extract config-level flags from a Java durable call's surrounding lines.
 */
interface JavaConfigFlags {
  nestingType?: string
  completionConfig?: string
  stepSemantics?: string
  tenantId?: string
  maxConcurrency?: number
}

function extractJavaConfig(lines: string[], lineIdx: number): JavaConfigFlags {
  const flags: JavaConfigFlags = {}
  const searchText = lines.slice(lineIdx, lineIdx + 15).join(' ')

  const nesting = searchText.match(/\.nestingType\s*\(\s*NestingType\.(\w+)\s*\)/)
    ?? searchText.match(/\.isVirtual\s*\(\s*true\s*\)/)
  if (nesting) {
    flags.nestingType = nesting[1] ?? 'FLAT'
  }

  const completion = searchText.match(/\.completionConfig\s*\(\s*CompletionConfig\.(\w+)\(\s*\)/)
  if (completion) flags.completionConfig = completion[1].replace(/([A-Z])/g, ' $1').toLowerCase().trim()

  const semantics = searchText.match(/\.semanticsPerRetry\s*\(\s*StepSemantics\.(\w+)\s*\)/)
  if (semantics) flags.stepSemantics = semantics[1].replace(/_/g, ' ')

  const tenant = searchText.match(/\.tenantId\s*\(\s*"([^"]+)"\s*\)/)
  if (tenant) flags.tenantId = tenant[1]

  const concurrency = searchText.match(/\.maxConcurrency\s*\(\s*(\d+)\s*\)/)
  if (concurrency) flags.maxConcurrency = Number(concurrency[1])

  return flags
}

/**
 * Extract the branches of a parallel() call. The Java SDK uses a builder:
 *   var p = ctx.parallel("name");
 *   p.branch("branchName", T.class, branchCtx -> { ... });
 * Only `.branch(` calls at the parallel statement's own nesting level count, so
 * branches of a parallel nested inside a branch lambda stay with that parallel.
 * Each branch's nodes come from extractNodes on its lambda body (or the helper a
 * method reference points at); recursion only ever sees smaller substrings, and
 * helpers are guarded by `visited`.
 */
function extractJavaBranches(
  body: string,
  lineIdx: number,
  lineStarts: number[],
  lineAt: (idx: number) => number,
  branchLines: Set<number>,
  contextNames: string[],
  helpers: Map<string, string>,
  visited: Set<string>,
  source: string,
  baseLineOffset: number,
): WorkflowBranch[] {
  const branches: WorkflowBranch[] = []
  // `var p = ctx.parallel(` or `try (var p = ctx.parallel(` → only `p.branch(` belongs to this parallel; otherwise chained `.branch(`
  const receiver = body.slice(lineStarts[lineIdx]).match(/^\s*(?:try\s*\(\s*)?(?:[\w<>,.]+\s+)?(\w+)\s*=\s*\w+\s*\.\s*(?:parallel|map)\s*\(/)?.[1]
  let depth = 0
  for (let p = lineStarts[lineIdx]; p < body.length; p++) {
    const ch = body[p]
    if (ch === '(' || ch === '{' || ch === '[') depth++
    else if (ch === ')' || ch === '}' || ch === ']') { if (--depth < 0) break }
    else if (ch === ';' && depth === 0 && !receiver) break
    // A named receiver can't be shadowed in Java, so `p.branch(` in a nested block (e.g. a loop) is still ours
    else if (ch === '.' && (depth === 0 || receiver)) {
      if (!/^\.\s*branch\s*\(/.test(body.slice(p, p + 40))) continue
      if (receiver && body.slice(0, p).match(/(\w+)\s*$/)?.[1] !== receiver) continue
      const open = body.indexOf('(', p)
      let close = open + 1
      for (let d = 1; close < body.length; close++) {
        if (body[close] === '(') d++
        else if (body[close] === ')' && --d === 0) break
      }
      const nodes = extractCallbackNodes(body, open + 1, close, lineAt, contextNames, helpers, visited, source, baseLineOffset)
      // A computed name (`"region-" + r`, usually in a loop) means one branch per item
      const name = body.slice(open + 1, close).match(/^\s*"([^"]+)"\s*,/)?.[1]
      branches.push({
        name: name ?? 'each item',
        dynamic: !name,
        nodes: nodes.length > 0 ? nodes : [{ id: nextId('step'), kind: 'step', label: name ?? 'each item' }],
      })
      for (let l = Math.max(lineAt(p), lineIdx + 1); l <= lineAt(close); l++) branchLines.add(l)
      p = close
    }
  }
  return branches
}

/** A lambda's parameter list at the start of a string: `x ->` or `(a, b, c) ->`. */
const LAMBDA_HEAD = /^(?:\(([^()]*)\)|(\w+))\s*->\s*/

/**
 * Code of the lambda starting at text[from], and the index where it ends.
 * A block lambda ends at its closing brace, an expression lambda at the first
 * `,` `)` or `;` outside brackets.
 */
function lambdaAt(text: string, from: number): { ctxName?: string; code: string; codeStart: number; end: number } | null {
  const m = text.slice(from).match(LAMBDA_HEAD)
  if (!m) return null
  // Map callbacks are (item, index, ctx), branches are (ctx): prefer a typed DurableContext param, else the last one
  const params = (m[1] ?? m[2]).split(',').map((p) => p.trim())
  const ctxName = (params.find((p) => /\bDurableContext\b/.test(p)) ?? params[params.length - 1]).match(/(\w+)$/)?.[1]
  const codeStart = from + m[0].length
  if (text[codeStart] === '{') {
    const code = extractJavaBlock(text, codeStart + 1)
    return { ctxName, code, codeStart, end: codeStart + code.length + 2 }
  }
  let end = codeStart
  for (let d = 0; end < text.length; end++) {
    const c = text[end]
    if (c === '(' || c === '{' || c === '[') d++
    else if (c === ')' || c === '}' || c === ']') { if (d-- === 0) break }
    else if ((c === ',' || c === ';') && d === 0) break
  }
  return { ctxName, code: text.slice(codeStart, end), codeStart, end }
}

/**
 * Durable nodes of the callback passed to a `.branch(...)` or `ctx.map(...)` call
 * whose arguments span body[argsStart, argsEnd): an inline lambda, a method
 * reference to a helper, or a variable holding a lambda declared earlier.
 */
function extractCallbackNodes(
  body: string,
  argsStart: number,
  argsEnd: number,
  lineAt: (idx: number) => number,
  contextNames: string[],
  helpers: Map<string, string>,
  visited: Set<string>,
  source: string,
  baseLineOffset: number,
): WorkflowNode[] {
  const fromLambda = (text: string, idx: number, lineOf: (i: number) => number): WorkflowNode[] => {
    const lambda = lambdaAt(text, idx)
    if (!lambda) return []
    const names = lambda.ctxName ? [...contextNames, lambda.ctxName] : contextNames
    return extractNodes(lambda.code, names, helpers, visited, source, lineOf(lambda.codeStart))
  }
  const bodyLine = (idx: number) => baseLineOffset + lineAt(idx)
  const args = body.slice(argsStart, argsEnd)

  const inline = args.search(/(?:\([^()]*\)|\b\w+)\s*->/)
  if (inline !== -1) return fromLambda(body, argsStart + inline, bodyLine)

  // Method reference (this::foo, Foo::foo) → inline the helper as if called
  const fromRef = (text: string, line: number): WorkflowNode[] | null => {
    const ref = text.match(/^[\w.]+\s*::\s*(\w+)/)
    return ref && extractNodes(`${ref[1]}()`, contextNames, helpers, visited, source, line)
  }
  const inlineRef = args.search(/[\w.]+\s*::\s*\w+/)
  if (inlineRef !== -1) return fromRef(args.slice(inlineRef), bodyLine(argsStart))!

  // Function variable: the argument after the result `T.class`
  const fnVar = args.match(/\.class\s*,\s*(\w+)\s*(?:,|$)/)?.[1]
  if (fnVar) {
    const declIdx = findDeclaration(source, sourceIndex(body, argsStart, bodyLine(argsStart), source), fnVar)
    if (declIdx !== -1) {
      const srcLine = (i: number) => source.slice(0, i).split('\n').length
      return fromRef(source.slice(declIdx), srcLine(declIdx)) ?? fromLambda(source, declIdx, srcLine)
    }
  }
  return []
}

/** Position in `source` of body[idx], whose 1-based source line is `line`. */
function sourceIndex(body: string, idx: number, line: number, source: string): number {
  let lineStart = 0
  for (let l = 1; l < line; l++) lineStart = source.indexOf('\n', lineStart) + 1
  const bodyLineStart = body.lastIndexOf('\n', idx - 1) + 1
  const lineEnd = body.indexOf('\n', idx)
  // A body's first line can start mid-line in the source, so locate the body's line text within it
  const col = source.slice(lineStart, source.indexOf('\n', lineStart)).indexOf(body.slice(bodyLineStart, lineEnd === -1 ? undefined : lineEnd))
  return lineStart + Math.max(col, 0) + (idx - bodyLineStart)
}

/**
 * Index of the value assigned to `name` (`name = <value>`) as seen from source[pos]:
 * the nearest declaration before pos in the enclosing blocks (walking outward, skipping
 * closed sibling blocks such as other methods), else a class field anywhere in the class.
 */
function findDeclaration(source: string, pos: number, name: string): number {
  const decl = new RegExp(`\\b${name}\\s*=\\s*(?=(?:\\([^()]*\\)|\\w+)\\s*->|[\\w.]+\\s*::)`, 'g')
  const search = (indices: number[], pickLast: boolean): number => {
    const text = indices.map((i) => source[i]).join('')
    const all = [...text.matchAll(decl)]
    const m = pickLast ? all.pop() : all[0]
    return m ? indices[m.index! + m[0].length] : -1
  }
  // Text visible from pos: everything before it that is not inside an already closed block
  const visible: number[] = []
  for (let i = pos - 1, depth = 0; i >= 0; i--) {
    const c = source[i]
    if (c === '}') depth++
    else if (c === '{') depth = Math.max(depth - 1, 0)
    else if (depth === 0) visible.push(i)
  }
  const local = search(visible.reverse(), true)
  if (local !== -1) return local
  // Fields declared after the method: class-body level (brace depth 1) anywhere in the file
  const classLevel: number[] = []
  for (let i = 0, depth = 0; i < source.length; i++) {
    const c = source[i]
    if (c === '{') depth++
    else if (c === '}') depth--
    else if (depth === 1) classLevel.push(i)
  }
  return search(classLevel, false)
}

/**
 * The call starting at body[callIdx] on body line `lineIdx` (map, child context, withRetry) →
 * one branch holding its callback's calls, or none when the callback has no durable calls.
 */
function extractCallbackBranch(
  body: string,
  callIdx: number,
  lineIdx: number,
  lineAt: (idx: number) => number,
  branchLines: Set<number>,
  contextNames: string[],
  helpers: Map<string, string>,
  visited: Set<string>,
  source: string,
  baseLineOffset: number,
  name: string,
  dynamic: boolean,
): WorkflowBranch[] {
  const open = body.indexOf('(', callIdx)
  let close = open + 1
  for (let d = 1; close < body.length; close++) {
    if (body[close] === '(') d++
    else if (body[close] === ')' && --d === 0) break
  }
  for (let l = lineIdx + 1; l <= lineAt(close); l++) branchLines.add(l)
  const nodes = extractCallbackNodes(body, open + 1, close, lineAt, contextNames, helpers, visited, source, baseLineOffset)
  return nodes.length > 0 ? [{ name, dynamic, nodes }] : []
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export class JavaParser implements Parser {
  extensions = ['.java']

  parseFile(filePath: string, options?: ParseOptions): WorkflowGraph {
    resetIds()

    const source = readFileSync(filePath, 'utf-8')
    const fileName = basename(filePath, '.java')
    const name = options?.name ?? fileName

    const handlerBody = extractHandlerBody(source)
    if (!handlerBody) {
      throw new Error(`No DurableHandler subclass found in ${filePath}`)
    }

    const contextNames = findContextParam(source)
    const helpers = findHelperMethods(source, contextNames)

    const handlerOffset = lineOfSubstring(source, handlerBody)
    const workflowNodes = extractNodes(handlerBody, contextNames, helpers, new Set(), source, handlerOffset)

    const startNode: WorkflowNode = { id: 'node_start', kind: 'start', label: 'Start' }
    const endNode: WorkflowNode = { id: 'node_end', kind: 'end', label: 'End' }
    const allNodes = [startNode, ...workflowNodes, endNode]
    const edges = buildEdges(allNodes)

    return { name, nodes: allNodes, edges }
  }
}
