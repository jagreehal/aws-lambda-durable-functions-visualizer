/**
 * TypeScript/JavaScript parser for durable function handlers.
 *
 * Uses ts-morph to find durable primitives and build a WorkflowGraph.
 * Follows function references: if the handler calls a helper function
 * that accepts a DurableContext and contains durable calls, those calls
 * are inlined at the call site in the graph.
 */

import {
  Project,
  SyntaxKind,
  type CallExpression,
  type Node,
  type Block,
  type IfStatement,
  type ForStatement,
  type ForOfStatement,
  type ForInStatement,
  type WhileStatement,
  type DoStatement,
  type SourceFile,
  type FunctionDeclaration,
  type ArrowFunction,
  type FunctionExpression,
} from 'ts-morph'
import type { WorkflowNode, WorkflowBranch, WorkflowGraph } from '../graph.js'
import { buildEdges, loopLabel } from '../graph.js'
import type { Parser, ParseOptions } from '../parser.js'

// ---------------------------------------------------------------------------
// ID generation (reset per parse call)
// ---------------------------------------------------------------------------

let nodeCounter = 0

function nextId(prefix: string): string {
  return `${prefix}_${++nodeCounter}`
}

function resetIds(): void {
  nodeCounter = 0
}

// ---------------------------------------------------------------------------
// AST helpers
// ---------------------------------------------------------------------------

/** Extract a string label from a call argument. Handles string literals, template literals, property access, identifiers, and function calls. */
function getStringArg(call: CallExpression, index: number): string | undefined {
  const arg = call.getArguments()[index]
  if (!arg) return undefined
  const kind = arg.getKind()
  if (kind === SyntaxKind.StringLiteral) {
    return arg.getText().replace(/^['"]|['"]$/g, '')
  }
  if (arg.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral) {
    return arg.getText().replace(/^`|`$/g, '')
  }
  if (kind === SyntaxKind.TemplateExpression) {
    return arg.getText().replace(/^`|`$/g, '').replace(/\$\{[^}]*\}/g, '?')
  }
  if (kind === SyntaxKind.CallExpression) {
    const callee = arg.asKind(SyntaxKind.CallExpression)?.getExpression()
    if (callee) return callee.getText()
  }
  if (kind === SyntaxKind.PropertyAccessExpression || kind === SyntaxKind.Identifier) {
    return arg.getText()
  }
  return undefined
}

/**
 * Check if a call expression targets <obj>.<method>() where obj
 * is any of the known context parameter names.
 */
function isDurableCall(node: Node, method: string, contextNames: Set<string>): boolean {
  if (node.getKind() !== SyntaxKind.CallExpression) return false
  const call = node as CallExpression
  const expr = call.getExpression()
  if (expr.getKind() === SyntaxKind.PropertyAccessExpression) {
    const text = expr.getText()
    for (const name of contextNames) {
      if (text === `${name}.${method}`) return true
    }
  }
  return false
}

/** Check if a call is <contextName>.promise.<method>(). */
function isPromiseCall(node: Node, method: string, contextNames: Set<string>): boolean {
  if (node.getKind() !== SyntaxKind.CallExpression) return false
  const call = node as CallExpression
  const expr = call.getExpression()
  if (expr.getKind() === SyntaxKind.PropertyAccessExpression) {
    const text = expr.getText()
    for (const name of contextNames) {
      if (text === `${name}.promise.${method}`) return true
    }
  }
  return false
}

/** Check if a call is withRetry(context, ...) — a top-level helper. */
function isWithRetryCall(node: Node, contextNames: Set<string>): boolean {
  if (node.getKind() !== SyntaxKind.CallExpression) return false
  const call = node as CallExpression
  const expr = call.getExpression()
  if (expr.getText() !== 'withRetry') return false
  const firstArg = call.getArguments()[0]
  if (!firstArg) return false
  return contextNames.has(firstArg.getText())
}

/** Extract retry strategy info from options argument. */
function getRetryStrategy(call: CallExpression): string | undefined {
  const args = call.getArguments()
  const lastArg = args[args.length - 1]
  if (!lastArg) return undefined
  const text = lastArg.getText()
  const match = text.match(/retryStrategy\s*:\s*(\w+)/)
  return match?.[1]
}

/** Extract timeout info from options argument. */
function getTimeoutInfo(call: CallExpression): string | undefined {
  const args = call.getArguments()
  for (const arg of args) {
    const text = arg.getText()
    const match = text.match(/timeout\s*:\s*\{([^}]+)\}/)
    if (match) return match[1].trim()
  }
  return undefined
}

/** Extract a property value from an object literal argument by property name. */
function getConfigProp(call: CallExpression, propName: string): string | undefined {
  const lastArg = call.getArguments()[call.getArguments().length - 1]
  if (!lastArg) return undefined
  const match = lastArg.getText().match(new RegExp(`${propName}\\s*:\\s*([^,\\n}]+)`))
  return match?.[1]?.trim().replace(/['"]/g, '')
}

/** Extract nesting type from a config object. Detects both `nestingType: NestingType.FLAT` and `isVirtual: true`. */
function getNestingType(call: CallExpression): string | undefined {
  const lastArg = call.getArguments()[call.getArguments().length - 1]
  if (!lastArg) return undefined
  const text = lastArg.getText()
  if (text.includes('NestingType.FLAT') || text.includes('nestingType\\s*:\\s*[\'"]FLAT[\'"]') || text.match(/nestingType\s*:\s*['"]FLAT['"]/)) return 'FLAT'
  if (text.match(/isVirtual\s*:\s*true/)) return 'FLAT'
  if (text.includes('virtualContext') && text.match(/virtualContext\s*:\s*true/)) return 'FLAT'
  return undefined
}

/** Extract completion config from a config object. */
function getCompletionConfig(call: CallExpression): string | undefined {
  const lastArg = call.getArguments()[call.getArguments().length - 1]
  if (!lastArg) return undefined
  const text = lastArg.getText()
  const methodMatch = text.match(/CompletionConfig\.(\w+)\(/)
  if (methodMatch) return methodMatch[1].replace(/([A-Z])/g, ' $1').toLowerCase().trim()
  const propMatch = text.match(/completionConfig\s*:\s*\{[^}]*?\}/)
  if (propMatch) return propMatch[0].replace(/\s+/g, ' ')
  return undefined
}

/** Extract maxConcurrency from a config object. */
function getMaxConcurrency(call: CallExpression): number | undefined {
  const lastArg = call.getArguments()[call.getArguments().length - 1]
  if (!lastArg) return undefined
  const match = lastArg.getText().match(/maxConcurrency\s*:\s*(\d+)/)
  return match ? Number(match[1]) : undefined
}

/** Get 1-based source line number for an AST node. */
function lineOf(node: Node): number {
  return node.getStartLineNumber()
}

/** Mark all descendant call expressions as consumed. */
function markDescendants(call: CallExpression, consumed: Set<number>): void {
  for (const desc of call.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    consumed.add(desc.getStart())
  }
}

/** Get child statements from a block or single statement. */
function getChildStatements(node: Node): Node[] {
  if (node.getKind() === SyntaxKind.Block) {
    return (node as Block).getStatements()
  }
  return [node]
}

// ---------------------------------------------------------------------------
// Loop helpers
// ---------------------------------------------------------------------------

type LoopStatement = ForStatement | ForOfStatement | ForInStatement | WhileStatement | DoStatement

const LOOP_KINDS = new Set<SyntaxKind>([
  SyntaxKind.ForStatement,
  SyntaxKind.ForOfStatement,
  SyntaxKind.ForInStatement,
  SyntaxKind.WhileStatement,
  SyntaxKind.DoStatement,
])

/** Count iterations for `for (let i = 0; i < 3; i++)` style loops with literal bounds. */
function getForIterations(loop: ForStatement): number | undefined {
  const init = loop.getInitializer()?.getText().match(/^(?:let|var)\s+(\w+)\s*=\s*(\d+)$/)
  const condition = loop.getCondition()?.getText().match(/^(\w+)\s*(<=|<)\s*(\d+)$/)
  const increment = loop.getIncrementor()?.getText().match(/^(?:(\w+)\+\+|\+\+(\w+)|(\w+)\s*\+=\s*1)$/)
  if (!init || !condition || !increment) return undefined
  const variable = init[1]
  if (condition[1] !== variable || ![increment[1], increment[2], increment[3]].includes(variable)) return undefined
  const count = Number(condition[3]) - Number(init[2]) + (condition[2] === '<=' ? 1 : 0)
  return count > 0 ? count : undefined
}

/** Describe a loop statement: its header text, iteration count, and the expression evaluated once before it starts. */
function describeLoop(loop: LoopStatement): { header: string; iterations?: number; iterable?: Node } {
  switch (loop.getKind()) {
    case SyntaxKind.ForStatement: {
      const forLoop = loop as ForStatement
      const header = [forLoop.getInitializer()?.getText(), forLoop.getCondition()?.getText(), forLoop.getIncrementor()?.getText()]
        .map((part) => part ?? '')
        .join('; ')
      return { header, iterations: getForIterations(forLoop) }
    }
    case SyntaxKind.ForOfStatement: {
      const forOf = loop as ForOfStatement
      const iterable = forOf.getExpression()
      const array = iterable.asKind(SyntaxKind.ArrayLiteralExpression)
      return {
        header: `${forOf.isAwaited() ? 'await ' : ''}${forOf.getInitializer().getText()} of ${iterable.getText()}`,
        iterations: array ? array.getElements().length || undefined : undefined,
        iterable,
      }
    }
    case SyntaxKind.ForInStatement: {
      const forIn = loop as ForInStatement
      return { header: `${forIn.getInitializer().getText()} in ${forIn.getExpression().getText()}`, iterable: forIn.getExpression() }
    }
    case SyntaxKind.WhileStatement:
      return { header: (loop as WhileStatement).getExpression().getText() }
    default:
      return { header: (loop as DoStatement).getExpression().getText() }
  }
}

// ---------------------------------------------------------------------------
// Function-reference resolution
// ---------------------------------------------------------------------------

type FunctionLike = FunctionDeclaration | ArrowFunction | FunctionExpression

/**
 * Build a map of function name → function body for all functions in the
 * source file that accept a DurableContext parameter.
 *
 * This enables following calls like `closeTicket(context, ...)` where
 * `closeTicket` is defined in the same file and uses context.parallel() etc.
 */
function buildDurableFunctionMap(sourceFile: SourceFile): Map<string, { body: Block; contextParam: string }> {
  const map = new Map<string, { body: Block; contextParam: string }>()

  // Named function declarations
  for (const fn of sourceFile.getFunctions()) {
    const entry = extractDurableFunction(fn)
    if (entry) {
      const name = fn.getName()
      if (name) map.set(name, entry)
    }
  }

  // Variable declarations: const foo = async (...) => { ... }
  for (const varDecl of sourceFile.getVariableDeclarations()) {
    const init = varDecl.getInitializer()
    if (!init) continue
    const fn = init.getKind() === SyntaxKind.ArrowFunction
      ? init as ArrowFunction
      : init.getKind() === SyntaxKind.FunctionExpression
        ? init as FunctionExpression
        : undefined
    if (!fn) continue
    const entry = extractDurableFunction(fn)
    if (entry) map.set(varDecl.getName(), entry)
  }

  return map
}

/** Check if a function-like node has a DurableContext parameter and a body. */
function extractDurableFunction(fn: FunctionLike): { body: Block; contextParam: string } | undefined {
  const params = fn.getParameters()
  for (const param of params) {
    const typeText = param.getTypeNode()?.getText() ?? ''
    if (typeText.includes('DurableContext')) {
      const body = fn.getBody()
      if (body && body.getKind() === SyntaxKind.Block) {
        return { body: body as Block, contextParam: param.getName() }
      }
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Registry resolution for dynamic parallel branches
// ---------------------------------------------------------------------------

/**
 * Try to resolve the keys of a registry object used inside a .map() callback.
 *
 * Looks for patterns like `REGISTRY[item.prop]` where REGISTRY is a
 * module-scope object literal, and returns its keys.
 */
function resolveRegistryKeys(mapArg: Node, sourceFile: SourceFile): string[] {
  // Find element access expressions like REGISTRY[spec.name]
  const elementAccesses = mapArg.getDescendantsOfKind(SyntaxKind.ElementAccessExpression)

  for (const access of elementAccesses) {
    const objName = access.getExpression().getText()
    // Skip if it's a complex expression (only want simple identifiers like SPECIALISTS)
    if (objName.includes('.') || objName.includes('(')) continue

    // Try to find a module-scope variable declaration with this name
    const varDecl = sourceFile.getVariableDeclaration(objName)
    if (!varDecl) continue

    const init = varDecl.getInitializer()
    if (!init) continue

    // Check if it's an object literal
    if (init.getKind() === SyntaxKind.ObjectLiteralExpression) {
      const objLiteral = init.asKind(SyntaxKind.ObjectLiteralExpression)
      if (!objLiteral) continue

      const keys: string[] = []
      for (const prop of objLiteral.getProperties()) {
        if (prop.getKind() === SyntaxKind.PropertyAssignment) {
          const propName = prop.asKind(SyntaxKind.PropertyAssignment)?.getName()
          if (propName) keys.push(propName.replace(/^['"]|['"]$/g, ''))
        }
      }
      if (keys.length > 0) return keys
    }
  }

  return []
}

// ---------------------------------------------------------------------------
// Parallel branch extraction
// ---------------------------------------------------------------------------

function extractParallelBranches(
  call: CallExpression,
  contextNames: Set<string>,
  durableFunctions: Map<string, { body: Block; contextParam: string }>,
  visited: Set<string>,
  sourceFile: SourceFile,
): WorkflowBranch[] {
  const branches: WorkflowBranch[] = []
  const branchesArg = call.getArguments()[hasNameArg(call, 'parallel') ? 1 : 0]
  if (!branchesArg) return branches
  // A list in a variable is read from where it was declared
  const secondArg = resolveIdentifier(branchesArg) ?? branchesArg

  // Pattern: items.map(...) — dynamic branches. Only the list itself counts: a
  // `.map(` inside an inline branch's body is ordinary code.
  const mapped = secondArg.isKind(SyntaxKind.CallExpression) && /\.map$/.test(secondArg.getExpression().getText())
  if (mapped) {
    const invokeCalls = secondArg.getDescendantsOfKind(SyntaxKind.CallExpression)
      .filter((c) => {
        const expr = c.getExpression().getText()
        return expr.endsWith('.invoke')
      })

    if (invokeCalls.length > 0) {
      // Try to resolve the registry object that the .map() iterates over.
      // Pattern: REGISTRY[item.key] inside the .map() callback, where
      // REGISTRY is a module-scope object with known keys.
      const registryKeys = resolveRegistryKeys(secondArg, sourceFile)

      if (registryKeys.length > 0) {
        // We know all possible branches — enumerate them
        for (const key of registryKeys) {
          branches.push({
            name: key,
            dynamic: true,
            nodes: [{
              id: nextId('invoke'),
              kind: 'invoke',
              label: key,
            }],
          })
        }
      } else {
        // Fallback: single representative branch
        const seen = new Set<string>()
        for (const invokeCall of invokeCalls) {
          const stepName = getStringArg(invokeCall, 0)
          const functionRef = getStringArg(invokeCall, 1) ?? invokeCall.getArguments()[1]?.getText()
          const key = `${stepName}:${functionRef}`
          if (seen.has(key)) continue
          seen.add(key)
          branches.push({
            name: stepName ?? 'specialist',
            dynamic: true,
            nodes: [{
              id: nextId('invoke'),
              kind: 'invoke',
              label: stepName ?? 'invoke',
              target: functionRef,
            }],
          })
        }
      }
    }

    const stepCalls = secondArg.getDescendantsOfKind(SyntaxKind.CallExpression)
      .filter((c) => {
        const expr = c.getExpression().getText()
        return expr.endsWith('.step')
      })

    if (stepCalls.length > 0 && invokeCalls.length === 0) {
      for (const stepCall of stepCalls) {
        const stepName = getStringArg(stepCall, 0)
        branches.push({
          name: stepName ?? 'step',
          dynamic: true,
          nodes: [{
            id: nextId('step'),
            kind: 'step',
            label: stepName ?? 'step',
          }],
        })
      }
    }

    return branches
  }

  // Pattern: static array of branch objects
  const arrayLiteral = secondArg.getKind() === SyntaxKind.ArrayLiteralExpression
    ? secondArg
    : secondArg.getFirstDescendantByKind(SyntaxKind.ArrayLiteralExpression)

  if (arrayLiteral) {
    const elements = [
      ...(arrayLiteral.asKind(SyntaxKind.ArrayLiteralExpression)?.getElements() ?? []),
      ...pushedElements(branchesArg, call),
    ]
    for (const element of elements) {
      // Plain values (a map's items) are not branches
      if (element.isKind(SyntaxKind.NumericLiteral) || element.isKind(SyntaxKind.StringLiteral) || element.isKind(SyntaxKind.TrueKeyword) || element.isKind(SyntaxKind.FalseKeyword) || element.isKind(SyntaxKind.NullKeyword)) continue
      const nameMatch = element.getText().match(/name\s*:\s*['"]([^'"]+)['"]/)
      const branchName = nameMatch?.[1] ?? (element.isKind(SyntaxKind.Identifier) ? element.getText() : 'branch')
      const branchNodes = extractBranchCallback(element, contextNames, durableFunctions, visited, sourceFile)

      // Fallback for branches that are not inline callbacks: any .invoke/.step inside them
      const invokeCalls = branchNodes.length > 0 ? [] : element.getDescendantsOfKind(SyntaxKind.CallExpression)
        .filter((c) => c.getExpression().getText().endsWith('.invoke'))

      for (const invokeCall of invokeCalls) {
        const invStepName = getStringArg(invokeCall, 0)
        const functionRef = getStringArg(invokeCall, 1) ?? invokeCall.getArguments()[1]?.getText()
        branchNodes.push({
          id: nextId('invoke'),
          kind: 'invoke',
          label: invStepName ?? branchName,
          target: functionRef,
        })
      }

      const stepCalls = branchNodes.length > 0 ? [] : element.getDescendantsOfKind(SyntaxKind.CallExpression)
        .filter((c) => c.getExpression().getText().endsWith('.step'))

      for (const stepCall of stepCalls) {
        const stepName = getStringArg(stepCall, 0)
        branchNodes.push({
          id: nextId('step'),
          kind: 'step',
          label: stepName ?? 'step',
          retryStrategy: getRetryStrategy(stepCall),
        })
      }

      if (branchNodes.length === 0) {
        branchNodes.push({
          id: nextId('branch'),
          kind: 'step',
          label: branchName,
        })
      }

      branches.push({ name: branchName, dynamic: false, nodes: branchNodes })
    }
  }

  return branches
}

/**
 * Extract a branch written as an inline callback (`async (ctx) => { ... }`,
 * on its own or as `func` of a branch object) with the full extractor, so
 * order, conditions, loops and nested parallels inside it are kept.
 */
function extractBranchCallback(
  element: Node,
  contextNames: Set<string>,
  durableFunctions: Map<string, { body: Block; contextParam: string }>,
  visited: Set<string>,
  sourceFile: SourceFile,
): WorkflowNode[] {
  const target = resolveIdentifier(element) ?? element
  const fn = isFunctionNode(target) ? target : target.getFirstDescendant(isFunctionNode)
  if (!fn || !isFunctionNode(fn)) return []
  const body = fn.getBody()
  if (!body) return []
  const names = new Set(contextNames)
  const param = fn.getParameters()[0]?.getName()
  if (param) names.add(param)
  // An expression body has no statements: scan the function itself, whose descendants hold the call.
  const statements = body.isKind(SyntaxKind.Block) ? body.getStatements() : [fn]
  return extractFromBlock(statements, names, durableFunctions, visited, sourceFile)
}

const isFunctionNode = (n: Node): n is ArrowFunction | FunctionExpression | FunctionDeclaration =>
  n.isKind(SyntaxKind.ArrowFunction) || n.isKind(SyntaxKind.FunctionExpression) || n.isKind(SyntaxKind.FunctionDeclaration)

/**
 * Whether a parallel/map/runInChildContext call starts with its optional name:
 * `parallel("x", branches)` vs `parallel(branches)`, `map("x", items, fn)` vs
 * `map(items, fn)`, `runInChildContext("x", fn)` vs `runInChildContext(fn)`.
 */
function hasNameArg(call: CallExpression, kind: 'parallel' | 'map' | 'child'): boolean {
  const args = call.getArguments().map((a) => resolveIdentifier(a) ?? a)
  const isFn = (i: number) => args[i] !== undefined && isFunctionNode(args[i])
  if (kind === 'map') return !isFn(1)
  if (kind === 'child') return !isFn(0)
  const first = args[0]
  return first !== undefined && !first.isKind(SyntaxKind.ArrayLiteralExpression) && !/\.map\s*\(/.test(first.getText())
}

/** Nodes inside the first function argument of a child context or retry block, as its one branch. */
function callbackBranch(
  call: CallExpression,
  label: string,
  contextNames: Set<string>,
  durableFunctions: Map<string, { body: Block; contextParam: string }>,
  visited: Set<string>,
  sourceFile: SourceFile,
): WorkflowBranch[] | undefined {
  const fn = call.getArguments().find((a) => isFunctionNode(resolveIdentifier(a) ?? a))
  const nodes = fn ? extractBranchCallback(fn, contextNames, durableFunctions, visited, sourceFile) : []
  return nodes.length > 0 ? [{ name: label, dynamic: false, nodes }] : undefined
}

/** The variable or function declaration an identifier refers to, honouring scope and shadowing. */
function declarationOf(node: Node): Node | undefined {
  if (!node.isKind(SyntaxKind.Identifier)) return undefined
  return node.getSymbol()?.getDeclarations()[0]
}

/**
 * What an identifier passed as branches or a callback stands for: a variable's
 * initializer, or a function declaration.
 */
function resolveIdentifier(node: Node): Node | undefined {
  const declaration = declarationOf(node)
  if (declaration?.isKind(SyntaxKind.VariableDeclaration)) return declaration.getInitializer()
  return declaration?.isKind(SyntaxKind.FunctionDeclaration) ? declaration : undefined
}

/** Arguments of `list.push(...)` calls on the same variable between its declaration and `use`. */
function pushedElements(list: Node, use: Node): Node[] {
  const declaration = declarationOf(list)
  if (!declaration) return []
  return use.getSourceFile().getDescendantsOfKind(SyntaxKind.CallExpression).flatMap((c) => {
    const target = c.getExpression().asKind(SyntaxKind.PropertyAccessExpression)
    if (target?.getName() !== 'push' || c.getStart() > use.getStart() || c.getStart() < declaration.getStart()) return []
    return declarationOf(target.getExpression()) === declaration ? c.getArguments() : []
  })
}

/** Declarations that parallel/map calls in `statements` use as branches, so their calls aren't also drawn where declared. */
function branchSources(statements: Node[], contextNames: Set<string>): Set<Node> {
  const sources = new Set<Node>()
  for (const stmt of statements) {
    for (const call of stmt.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      if (!isDurableCall(call, 'parallel', contextNames) && !isDurableCall(call, 'map', contextNames)) continue
      for (const arg of call.getArguments()) {
        const source = resolveIdentifier(arg)
        if (source) sources.add(source)
        for (const pushed of pushedElements(arg, call)) sources.add(pushed)
      }
    }
  }
  return sources
}

// ---------------------------------------------------------------------------
// Core extraction logic
// ---------------------------------------------------------------------------

/**
 * Walk statements and extract durable primitives in order.
 *
 * @param statements - AST statements to scan
 * @param contextNames - parameter names that refer to the DurableContext
 * @param durableFunctions - map of helper function names → bodies
 * @param visited - prevents infinite recursion for recursive helpers
 * @param sourceFile - the source file (for resolving registry objects)
 */
function extractFromBlock(
  statements: Node[],
  contextNames: Set<string>,
  durableFunctions: Map<string, { body: Block; contextParam: string }>,
  visited: Set<string>,
  sourceFile: SourceFile,
): WorkflowNode[] {
  const nodes: WorkflowNode[] = []
  const sources = branchSources(statements, contextNames)

  for (const stmt of statements) {
    // Check for if-statements that wrap durable calls
    if (stmt.getKind() === SyntaxKind.IfStatement) {
      const ifStmt = stmt as IfStatement
      const thenBlock = ifStmt.getThenStatement()
      const conditionText = ifStmt.getExpression().getText()

      const thenNodes = extractFromBlock(
        getChildStatements(thenBlock),
        contextNames,
        durableFunctions,
        visited,
        sourceFile,
      )

      const elseBlock = ifStmt.getElseStatement()
      const elseNodes = elseBlock
        ? extractFromBlock(getChildStatements(elseBlock), contextNames, durableFunctions, visited, sourceFile)
        : []
      const endsWithReturn = (block: Node | undefined) =>
        block !== undefined && getChildStatements(block).at(-1)?.getKind() === SyntaxKind.ReturnStatement

      if (thenNodes.length > 0 || elseNodes.length > 0) {
        // Only the else-branch does durable work: draw it as the then-branch of the negated condition
        const flipped = thenNodes.length === 0
        const label = flipped ? `!(${conditionText})` : conditionText
        nodes.push({
          id: nextId('cond'),
          kind: 'condition',
          label,
          condition: label,
          thenCount: flipped ? elseNodes.length : thenNodes.length,
          thenReturns: endsWithReturn(flipped ? elseBlock : thenBlock),
          elseCount: flipped ? undefined : elseNodes.length || undefined,
          elseReturns: flipped || elseNodes.length === 0 ? undefined : endsWithReturn(elseBlock),
          sourceLine: lineOf(ifStmt),
        })
        nodes.push(...(flipped ? elseNodes : [...thenNodes, ...elseNodes]))
        continue
      }
    }

    // Loops that wrap durable calls become a loop node followed by the body
    if (LOOP_KINDS.has(stmt.getKind())) {
      const loop = stmt as LoopStatement
      const { header, iterations, iterable } = describeLoop(loop)

      const bodyNodes = extractFromBlock(
        getChildStatements(loop.getStatement()),
        contextNames,
        durableFunctions,
        visited,
        sourceFile,
      )

      if (bodyNodes.length > 0) {
        // A durable call in the iterable (for await ... of await ctx.step(...)) runs once, before the loop
        if (iterable) {
          nodes.push(...extractFromBlock([iterable], contextNames, durableFunctions, visited, sourceFile))
        }
        nodes.push({
          id: nextId('loop'),
          kind: 'loop',
          label: loopLabel(header, iterations),
          loopHeader: header,
          bodyCount: bodyNodes.length,
          iterations,
          sourceLine: lineOf(loop),
        })
        nodes.push(...bodyNodes)
        continue
      }
    }

    // Find all call expressions in this statement
    const calls = stmt.getDescendantsOfKind(SyntaxKind.CallExpression)
    const consumed = new Set<number>()

    for (const call of calls) {
      if (consumed.has(call.getStart())) continue
      // Drawn inside the parallel/map that uses them, not where they are declared
      if (sources.size > 0 && call.getAncestors().some((a) => sources.has(a))) continue

      // --- Durable primitives ---

      if (isDurableCall(call, 'step', contextNames)) {
        markDescendants(call, consumed)
        const name = getStringArg(call, 0)
        const semantics = getConfigProp(call, 'semantics')
        nodes.push({
          id: nextId('step'),
          kind: 'step',
          label: name ?? 'step',
          retryStrategy: getRetryStrategy(call),
          stepSemantics: semantics?.includes('AtMostOnce') ? 'AtMostOncePerRetry' : undefined,
          sourceLine: lineOf(call),
        })
      } else if (isDurableCall(call, 'parallel', contextNames)) {
        markDescendants(call, consumed)
        const name = hasNameArg(call, 'parallel') ? getStringArg(call, 0) : undefined
        const branches = extractParallelBranches(call, contextNames, durableFunctions, visited, sourceFile)
        nodes.push({
          id: nextId('parallel'),
          kind: 'parallel',
          label: name ?? 'parallel',
          branches,
          nestingType: getNestingType(call),
          completionConfig: getCompletionConfig(call),
          maxConcurrency: getMaxConcurrency(call),
          sourceLine: lineOf(call),
        })
      } else if (isDurableCall(call, 'waitForCallback', contextNames)) {
        markDescendants(call, consumed)
        const name = getStringArg(call, 0)
        nodes.push({
          id: nextId('callback'),
          kind: 'waitForCallback',
          label: name ?? 'waitForCallback',
          timeout: getTimeoutInfo(call),
          sourceLine: lineOf(call),
        })
      } else if (isDurableCall(call, 'wait', contextNames)) {
        markDescendants(call, consumed)
        const name = getStringArg(call, 0)
        const hasDuration = call.getArguments()[0]?.getKind() === SyntaxKind.ObjectLiteralExpression
        const durationArg = hasDuration ? call.getArguments()[0] : call.getArguments()[1]
        nodes.push({
          id: nextId('wait'),
          kind: 'wait',
          label: name && !hasDuration ? `wait: ${name}` : 'wait',
          timeout: durationArg?.getText(),
          sourceLine: lineOf(call),
        })
      } else if (isDurableCall(call, 'waitForCondition', contextNames)) {
        markDescendants(call, consumed)
        const name = getStringArg(call, 0)
        nodes.push({
          id: nextId('waitcond'),
          kind: 'waitForCondition',
          label: name ?? 'waitForCondition',
          timeout: getTimeoutInfo(call),
          sourceLine: lineOf(call),
        })
      } else if (isDurableCall(call, 'createCallback', contextNames)) {
        markDescendants(call, consumed)
        const name = getStringArg(call, 0)
        nodes.push({
          id: nextId('createcb'),
          kind: 'createCallback',
          label: name ?? 'createCallback',
          timeout: getTimeoutInfo(call),
          sourceLine: lineOf(call),
        })
      } else if (isDurableCall(call, 'runInChildContext', contextNames)) {
        markDescendants(call, consumed)
        const label = (hasNameArg(call, 'child') ? getStringArg(call, 0) : undefined) ?? 'childContext'
        nodes.push({
          id: nextId('child'),
          kind: 'runInChildContext',
          label,
          branches: callbackBranch(call, label, contextNames, durableFunctions, visited, sourceFile),
          nestingType: getNestingType(call),
          sourceLine: lineOf(call),
        })
      } else if (isDurableCall(call, 'map', contextNames)) {
        markDescendants(call, consumed)
        const named = hasNameArg(call, 'map')
        const name = named ? getStringArg(call, 0) : undefined
        // map(name?, items, async (ctx, item) => { ... }): the item callback is one branch run per item
        const itemFn = call.getArguments()[named ? 2 : 1]
        const itemNodes = itemFn ? extractBranchCallback(itemFn, contextNames, durableFunctions, visited, sourceFile) : []
        const branches = itemNodes.length > 0
          ? [{ name: 'each item', dynamic: true, nodes: itemNodes }]
          : extractParallelBranches(call, contextNames, durableFunctions, visited, sourceFile)
        nodes.push({
          id: nextId('map'),
          kind: 'map',
          label: name ?? 'map',
          branches,
          nestingType: getNestingType(call),
          completionConfig: getCompletionConfig(call),
          maxConcurrency: getMaxConcurrency(call),
          sourceLine: lineOf(call),
        })
      } else if (isDurableCall(call, 'invoke', contextNames)) {
        markDescendants(call, consumed)
        const name = getStringArg(call, 0)
        const functionRef = getStringArg(call, 1) ?? call.getArguments()[1]?.getText()
        const tenantId = getConfigProp(call, 'tenantId')
        nodes.push({
          id: nextId('invoke'),
          kind: 'invoke',
          label: name ?? 'invoke',
          target: functionRef,
          tenantId,
          sourceLine: lineOf(call),
        })
      } else if (isPromiseCall(call, 'all', contextNames)) {
        markDescendants(call, consumed)
        const name = getStringArg(call, 0)
        nodes.push({ id: nextId('pall'), kind: 'promiseAll', label: name ?? 'promise.all', sourceLine: lineOf(call) })
      } else if (isPromiseCall(call, 'any', contextNames)) {
        markDescendants(call, consumed)
        const name = getStringArg(call, 0)
        nodes.push({ id: nextId('pany'), kind: 'promiseAny', label: name ?? 'promise.any', sourceLine: lineOf(call) })
      } else if (isPromiseCall(call, 'race', contextNames)) {
        markDescendants(call, consumed)
        const name = getStringArg(call, 0)
        nodes.push({ id: nextId('prace'), kind: 'promiseRace', label: name ?? 'promise.race', sourceLine: lineOf(call) })
      } else if (isPromiseCall(call, 'allSettled', contextNames)) {
        markDescendants(call, consumed)
        const name = getStringArg(call, 0)
        nodes.push({ id: nextId('psettled'), kind: 'promiseAllSettled', label: name ?? 'promise.allSettled', sourceLine: lineOf(call) })
      } else if (isWithRetryCall(call, contextNames)) {
        markDescendants(call, consumed)
        // withRetry(context, "name", fn, config) or withRetry(context, fn, config)
        const label = getStringArg(call, 1) ?? 'withRetry'
        nodes.push({
          id: nextId('retry'),
          kind: 'withRetry',
          label,
          branches: callbackBranch(call, label, contextNames, durableFunctions, visited, sourceFile),
          retryStrategy: getRetryStrategy(call),
          nestingType: getNestingType(call),
          sourceLine: lineOf(call),
        })
      } else {
        // --- Function-reference following ---
        // Check if this is a call to a helper function that uses DurableContext.
        const calledName = resolveCalledFunctionName(call)
        if (calledName && durableFunctions.has(calledName) && !visited.has(calledName)) {
          markDescendants(call, consumed)
          const entry = durableFunctions.get(calledName)!
          visited.add(calledName)

          // The helper's context parameter name becomes a valid context name
          const childContextNames = new Set(contextNames)
          childContextNames.add(entry.contextParam)

          const inlinedNodes = extractFromBlock(
            entry.body.getStatements(),
            childContextNames,
            durableFunctions,
            visited,
            sourceFile,
          )
          nodes.push(...inlinedNodes)

          visited.delete(calledName)
        }
      }
    }
  }

  return nodes
}

/** Resolve the function name from a simple call expression (e.g. `closeTicket(...)` → "closeTicket"). */
function resolveCalledFunctionName(call: CallExpression): string | undefined {
  const expr = call.getExpression()
  // Simple identifier: closeTicket(...)
  if (expr.getKind() === SyntaxKind.Identifier) {
    return expr.getText()
  }
  // Could add: this.method(), imported.function(), etc.
  return undefined
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export class TypeScriptParser implements Parser {
  extensions = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs']

  parseFile(filePath: string, options?: ParseOptions): WorkflowGraph {
    resetIds()

    const project = new Project({
      compilerOptions: { allowJs: true },
      skipAddingFilesFromTsConfig: true,
    })

    const sourceFile = project.addSourceFileAtPath(filePath)
    const fileName = sourceFile.getBaseNameWithoutExtension()
    const name = options?.name ?? fileName

    // Build map of helper functions that accept DurableContext
    const durableFunctions = buildDurableFunctionMap(sourceFile)

    // Find withDurableExecution() calls
    const durableCalls = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)
      .filter((call) => call.getExpression().getText() === 'withDurableExecution')

    if (durableCalls.length === 0) {
      throw new Error(`No withDurableExecution() call found in ${filePath}`)
    }

    // A file with several handlers (e.g. a "wrong" and a "right" docs example): prefer the one exported as `handler`
    const durableCall = durableCalls.find((c) => c.getParentIfKind(SyntaxKind.VariableDeclaration)?.getName() === 'handler') ?? durableCalls[0]
    const handlerArg = durableCall.getArguments()[0]
    if (!handlerArg) {
      throw new Error('withDurableExecution() has no handler argument')
    }

    // withDurableExecution(run): the handler is a function declared elsewhere in the file
    const handlerFn = resolveIdentifier(handlerArg) ?? handlerArg
    const body = isFunctionNode(handlerFn) && handlerFn.getBody()?.isKind(SyntaxKind.Block)
      ? handlerFn.getBody() as Block
      : handlerFn.getFirstDescendantByKind(SyntaxKind.Block)
    if (!body) {
      throw new Error('Handler function has no body')
    }

    // Determine the context parameter name from the handler signature
    const contextNames = new Set<string>()
    const handlerParams = handlerFn.getDescendantsOfKind(SyntaxKind.Parameter)
    for (const param of handlerParams) {
      const typeText = param.getTypeNode()?.getText() ?? ''
      if (typeText.includes('DurableContext')) {
        contextNames.add(param.getName())
      }
    }
    // Fallback: assume common names if no typed parameter found
    if (contextNames.size === 0) {
      contextNames.add('context')
      contextNames.add('ctx')
    }

    const workflowNodes = extractFromBlock(
      body.getStatements(),
      contextNames,
      durableFunctions,
      new Set(),
      sourceFile,
    )

    const startNode: WorkflowNode = { id: 'node_start', kind: 'start', label: 'Start' }
    const endNode: WorkflowNode = { id: 'node_end', kind: 'end', label: 'End' }
    const allNodes = [startNode, ...workflowNodes, endNode]
    const edges = buildEdges(allNodes)

    return { name, nodes: allNodes, edges }
  }
}
