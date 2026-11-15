import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { CSharpParser } from './csharp.js'
import type { WorkflowNode } from '../graph.js'

const parser = new CSharpParser()
const examplesDir = resolve(import.meta.dirname, '../../../..', 'examples')
const fixturesDir = resolve(import.meta.dirname, '../../../..', 'packages/core/test-fixtures')

describe('CSharpParser', () => {
  it('parses the OrderWorkflow example (executable model)', () => {
    const graph = parser.parseFile(resolve(examplesDir, 'OrderWorkflow.cs'))

    assert.equal(graph.name, 'OrderWorkflow')

    const kinds = graph.nodes.map((n) => n.kind)
    assert.ok(kinds.includes('start'))
    assert.ok(kinds.includes('end'))
    assert.ok(kinds.includes('step'))
    assert.ok(kinds.includes('parallel'))
    assert.ok(kinds.includes('wait'))
    assert.ok(kinds.includes('waitForCallback'))
    assert.ok(kinds.includes('condition'))
  })

  it('parses the OrderProcessor example (class-library model)', () => {
    const graph = parser.parseFile(resolve(examplesDir, 'OrderProcessor.cs'))

    assert.equal(graph.name, 'OrderProcessor')

    const kinds = graph.nodes.map((n) => n.kind)
    assert.ok(kinds.includes('start'))
    assert.ok(kinds.includes('end'))
    assert.ok(kinds.includes('step'))
    assert.ok(kinds.includes('parallel'))
    assert.ok(kinds.includes('wait'))
    assert.ok(kinds.includes('waitForCallback'))
    assert.ok(kinds.includes('invoke'))
    assert.ok(kinds.includes('condition'))
  })

  it('extracts step names from named arguments', () => {
    const graph = parser.parseFile(resolve(examplesDir, 'OrderWorkflow.cs'))

    const stepLabels = graph.nodes
      .filter((n) => n.kind === 'step')
      .map((n) => n.label)

    assert.ok(stepLabels.includes('validate-order'))
    assert.ok(stepLabels.includes('fulfill-order'))
  })

  it('extracts parallel branch names', () => {
    const graph = parser.parseFile(resolve(examplesDir, 'OrderWorkflow.cs'))

    const parallel = graph.nodes.find((n) => n.kind === 'parallel')
    assert.ok(parallel)
    assert.equal(parallel.label, 'prepare-order')
    assert.ok(parallel.branches)
    assert.equal(parallel.branches.length, 2)

    const branchNames = parallel.branches.map((b) => b.name)
    assert.ok(branchNames.includes('check-inventory'))
    assert.ok(branchNames.includes('reserve-payment'))
  })

  it('extracts wait name', () => {
    const graph = parser.parseFile(resolve(examplesDir, 'OrderWorkflow.cs'))

    const wait = graph.nodes.find((n) => n.kind === 'wait')
    assert.ok(wait)
    assert.equal(wait.label, 'warehouse-processing')
  })

  it('detects condition nodes', () => {
    const graph = parser.parseFile(resolve(examplesDir, 'OrderWorkflow.cs'))

    const condition = graph.nodes.find((n) => n.kind === 'condition')
    assert.ok(condition)
    assert.ok(condition.condition?.includes('Total > 5000'))
    assert.ok(condition.thenCount)
  })

  it('extracts waitForCallback name', () => {
    const graph = parser.parseFile(resolve(examplesDir, 'OrderWorkflow.cs'))

    const callback = graph.nodes.find((n) => n.kind === 'waitForCallback')
    assert.ok(callback)
    assert.equal(callback.label, 'manager-approval')
  })

  it('extracts invoke target', () => {
    const graph = parser.parseFile(resolve(examplesDir, 'OrderProcessor.cs'))

    const invoke = graph.nodes.find((n) => n.kind === 'invoke')
    assert.ok(invoke)
    assert.equal(invoke.label, 'fulfillment-service')
    assert.equal(invoke.target, 'fulfillment-service')
  })

  it('includes source line numbers', () => {
    const graph = parser.parseFile(resolve(examplesDir, 'OrderProcessor.cs'))

    const nodesWithLines = graph.nodes.filter((n) => n.sourceLine != null)
    assert.ok(nodesWithLines.length >= 5, `Expected at least 5 nodes with source lines, got ${nodesWithLines.length}`)
  })

  it('generates valid edges', () => {
    const graph = parser.parseFile(resolve(examplesDir, 'OrderProcessor.cs'))

    assert.ok(graph.edges.length > 0)

    const startEdges = graph.edges.filter((e) => e.from === 'node_start')
    assert.equal(startEdges.length, 1)

    const endEdges = graph.edges.filter((e) => e.to === 'node_end')
    assert.ok(endEdges.length >= 1)
  })

  it('parses the Lambda Annotations model ([DurableExecution] attribute)', () => {
    const graph = parser.parseFile(resolve(fixturesDir, 'DurableExecutionAnnotations.cs'))

    assert.equal(graph.name, 'DurableExecutionAnnotations')

    const kinds = graph.nodes.map((n) => n.kind)
    assert.ok(kinds.includes('step'))
    assert.ok(kinds.includes('parallel'))

    const step = graph.nodes.find((n) => n.kind === 'step')
    assert.ok(step)
    assert.equal(step.label, 'step-1')
  })

  it('extracts MaxConcurrency from the annotations model', () => {
    const graph = parser.parseFile(resolve(fixturesDir, 'DurableExecutionAnnotations.cs'))

    const parallel = graph.nodes.find((n) => n.kind === 'parallel')
    assert.ok(parallel)
    assert.equal(parallel.maxConcurrency, 2)
  })

  it('throws for non-durable files', () => {
    assert.throws(
      () => parser.parseFile(resolve(examplesDir, 'order_processor.py')),
      /No DurableFunction\.WrapAsync/
    )
  })

  it('parses WaitAsync with TimeSpan argument', () => {
    const graph = parser.parseFile(resolve(examplesDir, 'OrderProcessor.cs'))

    const wait = graph.nodes.find((n) => n.kind === 'wait')
    assert.ok(wait)
    assert.equal(wait.label, 'shipping-delay')
  })

  it('parses CreateCallbackAsync with generic type arg', () => {
    const graph = parser.parseFile(resolve(fixturesDir, 'CreateCallback.cs'))

    const cb = graph.nodes.find((n) => n.kind === 'createCallback')
    assert.ok(cb, 'Should detect CreateCallbackAsync')
  })

  it('parses WaitForConditionAsync with named args', () => {
    const graph = parser.parseFile(resolve(fixturesDir, 'WaitForCondition.cs'))

    const wfc = graph.nodes.find((n) => n.kind === 'waitForCondition')
    assert.ok(wfc, 'Should detect WaitForConditionAsync')
    assert.equal(wfc.label, 'happy_poll')
  })

  it('parses RunInChildContextAsync', () => {
    const graph = parser.parseFile(resolve(fixturesDir, 'ChildContext.cs'))

    const child = graph.nodes.find((n) => n.kind === 'runInChildContext')
    assert.ok(child, 'Should detect RunInChildContextAsync')
    // The inner step is drawn inside the child context
    assert.deepEqual(child.branches!.map((b) => [b.name, b.nodes.map((n) => n.label)]), [['validate', ['inner-step']]])
    assert.ok(!graph.nodes.some((n) => n.label === 'inner-step'))
  })

  it('parses MapAsync', () => {
    const graph = parser.parseFile(resolve(fixturesDir, 'MapFunction.cs'))

    const map = graph.nodes.find((n) => n.kind === 'map')
    assert.ok(map, 'Should detect MapAsync')
    assert.equal(map.label, 'process')
  })

  it('extracts stepSemantics from StepConfig', () => {
    const graph = parser.parseFile(resolve(fixturesDir, 'StepConfig.cs'))

    const step = graph.nodes.find((n) => n.label === 'idempotent-step')
    assert.ok(step, 'Should find step node')
    assert.equal(step.stepSemantics, 'AtMostOncePerRetry')
  })

  it('extracts tenantId from InvokeConfig', () => {
    const graph = parser.parseFile(resolve(fixturesDir, 'StepConfig.cs'))

    const invoke = graph.nodes.find((n) => n.label === 'tenant-invoke')
    assert.ok(invoke, 'Should find invoke node')
    assert.equal(invoke.tenantId, 'tenant-abc-123')
  })

  describe('loops', () => {
    const graph = parser.parseFile(resolve(fixturesDir, 'Loops.cs'))
    const loops = graph.nodes.filter((n) => n.kind === 'loop')

    it('should emit a loop node for foreach, for, while and do-while loops', () => {
      assert.deepEqual(loops.map((n) => n.loopHeader), [
        'var order in input.Orders',
        'int attempt = 0; attempt < 3; attempt++',
        'var region in GetRegions(input.Id)',
        '!IsDone()',
        'HasMore(input)',
      ])
    })

    it('should not emit a loop node when the body has no durable calls', () => {
      assert.ok(!graph.nodes.some((n) => n.loopHeader?.includes('ignored')))
    })

    it('should include a nested condition, its branch and the step after it in the body count', () => {
      const orderLoop = loops[0]
      const index = graph.nodes.indexOf(orderLoop)
      const body = graph.nodes.slice(index + 1, index + 1 + (orderLoop.bodyCount ?? 0))

      assert.deepEqual(body.map((n) => n.label), ['validate', 'order.IsVip', 'vip-perk', 'charge'])
    })

    it('should support a same-line brace and detect the literal count', () => {
      assert.equal(loops[1].iterations, 3)
      assert.equal(loops[1].bodyCount, 1)
      assert.equal(loops[0].iterations, undefined)
    })

    it('should keep a header that contains a call intact', () => {
      assert.equal(loops[2].label, 'loop: var region in GetRegions(input.Id)')
      assert.equal(loops[2].bodyCount, 1)
    })

    it('should report source lines for the loop and the steps inside it', () => {
      const lines = Object.fromEntries(graph.nodes.map((n) => [n.label, n.sourceLine]))

      assert.equal(loops[0].sourceLine, 16)
      assert.equal(lines['validate'], 18)
      assert.equal(lines['vip-perk'], 21)
      assert.equal(lines['charge'], 23)
    })

    it('should keep steps after the loops', () => {
      const steps = graph.nodes.filter((n) => n.kind === 'step').map((n) => n.label)
      assert.equal(steps[steps.length - 1], 'finish')
    })

    it('should connect each loop with a back-edge and a done edge', () => {
      for (const loop of loops) {
        assert.ok(graph.edges.some((e) => e.to === loop.id && e.style === 'back'))
        assert.equal(graph.edges.filter((e) => e.from === loop.id && e.label === 'done').length, 1)
      }
    })
  })

  it('keeps the structure of inline branch lambdas', () => {
    const graph = parser.parseFile(resolve(fixturesDir, 'NestedParallel.cs'))
    const outer = graph.nodes.find((n) => n.label === 'outer')!
    assert.deepEqual(graph.nodes.map((n) => n.label), ['Start', 'outer', 'after', 'End'])
    const [first, gated] = outer.branches!

    // A nested parallel stays a parallel with its own branches, followed by the step after it
    assert.equal(first.name, 'first')
    assert.deepEqual(first.nodes.map((n) => [n.kind, n.label]), [['parallel', 'inner'], ['step', 'tail']])
    assert.deepEqual(first.nodes[0].branches!.map((b) => [b.name, b.nodes.map((n) => n.label)]), [['inner-a', ['a']], ['inner-b', ['b']]])
    assert.equal(gated.name, 'gated')
    assert.deepEqual(gated.nodes.map((n) => [n.kind, n.label]), [['invoke', 'first-invoke'], ['condition', 'input.Vip'], ['step', 'vip']])
    assert.deepEqual(gated.nodes.map((n) => n.sourceLine), [36, 37, 39])
    assert.equal(first.nodes[0].branches![1].nodes[0].sourceLine, 28)

    const all = (nodes: WorkflowNode[]): WorkflowNode[] =>
      nodes.flatMap((n) => [n, ...all((n.branches ?? []).flatMap((b) => b.nodes))])
    const id = (label: string) => all(graph.nodes).find((n) => n.label === label)!.id
    const edge = (from: string, to: string) => graph.edges.some((e) => e.from === from && e.to === to)
    assert.ok(edge(id('a'), id('tail')), 'inner branches join at tail')
    assert.ok(edge(id('b'), id('tail')), 'inner branches join at tail')
    assert.ok(edge(id('tail'), id('after')), 'outer branch joins at after')
    assert.ok(edge(id('input.Vip'), id('after')), 'skipped condition leaves the branch')
  })

  it('extracts MapAsync item functions as one dynamic branch', () => {
    const graph = parser.parseFile(resolve(fixturesDir, 'MapItems.cs'))
    // Item-function calls stay inside the map, not at the top level
    assert.deepEqual(graph.nodes.map((n) => n.label), ['Start', 'charge-all', 'ship-all', 'done', 'End'])

    const [charge, ship] = graph.nodes.filter((n) => n.kind === 'map')
    assert.deepEqual(charge.branches!.map((b) => [b.name, b.dynamic]), [['each item', true]])
    assert.deepEqual(charge.branches![0].nodes.map((n) => [n.label, n.sourceLine]), [['charge', 23], ['cool-down', 24]])
    // Method group resolves to the helper method's body
    assert.deepEqual(ship.branches![0].nodes.map((n) => [n.label, n.sourceLine]), [['ship', 37]])

    const all = graph.nodes.flatMap((n) => [n, ...(n.branches ?? []).flatMap((b) => b.nodes)])
    const id = (label: string) => all.find((n) => n.label === label)!.id
    const edge = (from: string, to: string) => graph.edges.some((e) => e.from === from && e.to === to)
    assert.ok(edge(id('charge'), id('cool-down')), 'item body keeps its order')
    assert.ok(edge(id('cool-down'), id('ship-all')), 'map body joins the next node')
  })

  it('keeps MapAsync without durable item calls branchless', () => {
    const graph = parser.parseFile(resolve(fixturesDir, 'MapFunction.cs'))
    assert.deepEqual(graph.nodes.find((n) => n.kind === 'map')!.branches, [])
  })

  it('resolves branches built in a local collection before ParallelAsync', () => {
    const graph = parser.parseFile(resolve(fixturesDir, 'BranchesVariable.cs'))
    // Declarations of branches and branch lambdas add nothing at the top level
    assert.deepEqual(graph.nodes.map((n) => n.label), ['Start', 'prepare', 'verify', 'End'])

    const [prepare, verify] = graph.nodes.filter((n) => n.kind === 'parallel')
    assert.deepEqual(prepare.branches!.map((b) => [b.name, b.nodes.map((n) => [n.label, n.sourceLine])]), [
      ['reserve', [['reserve-stock', 29]]],
      ['audit', [['write-audit', 21]]], // lambda held in a variable
    ])
    // new List<DurableBranch<T>> { new("x", fn) } with target-typed constructors
    assert.deepEqual(verify.branches!.map((b) => [b.name, b.nodes.map((n) => [n.kind, n.label])]), [
      ['fraud', [['invoke', 'fraud-check']]],
      ['noop', [['step', 'noop']]],
    ])
    assert.equal(verify.branches![0].nodes[0].sourceLine, 39)
  })

  it('resolves branches from .Add/.AddRange, fields and LINQ, scoped to the method', () => {
    const graph = parser.parseFile(resolve(fixturesDir, 'BranchSources.cs'))
    // Statements that build branches add nothing at the top level
    assert.deepEqual(graph.nodes.map((n) => n.label), ['Start', 'built', 'from-field', 'orphan', 'per-region', 'tight', 'End'])
    const branchesOf = (label: string) => graph.nodes.find((n) => n.label === label)!.branches!
      .map((b) => [b.name, b.dynamic, b.nodes.map((n) => [n.label, n.sourceLine])])

    // Empty initializer, then .Add, .AddRange and a target-typed .Add inside an if, in order
    assert.deepEqual(branchesOf('built'), [
      ['first', false, [['first-step', 34]]],
      ['second', false, [['second-step', 39]]],
      ['third', false, [['third-step', 43]]],
    ])
    // Class field with target-typed elements
    assert.deepEqual(branchesOf('from-field'), [['shared', false, [['shared-step', 15]]]])
    // `orphan` and `branches` exist only as locals of another method: never used
    assert.deepEqual(branchesOf('orphan'), [])
    // items.Select(x => new DurableBranch(...)) is one dynamic branch
    assert.deepEqual(branchesOf('per-region'), [['each item', true, [['sync', 54]]]])
    // Target-typed new(...) outside the branches argument is not a branch
    assert.deepEqual(branchesOf('tight').map(([name]) => name), ['only'])
  })

  it('draws else and else-if branches', () => {
    const graph = parser.parseFile(resolve(fixturesDir, 'IfElse.cs'))
    const id = (label: string) => graph.nodes.find((n) => n.label === label)!.id
    const edges = new Set(graph.edges.map((e) => `${e.from}>${e.to}${e.label ? ':' + e.label : ''}`))
    const has = (from: string, to: string, label?: string) =>
      assert.ok(edges.has(`${id(from)}>${id(to)}${label ? ':' + label : ''}`), `${from} -> ${to} ${label ?? ''}`)

    // if / else: both sides join at the next condition
    has('input.Vip', 'fast-track', 'yes')
    has('input.Vip', 'queue', 'no')
    has('fast-track', 'input.Tier == "gold"')
    has('notify-wait', 'input.Tier == "gold"')
    assert.ok(!edges.has(`${id('fast-track')}>${id('queue')}`), 'then side skips the else side')
    // else-if chain (Allman + braceless): the last else returns, so it ends the workflow
    has('input.Tier == "gold"', 'input.Tier == "silver"', 'no')
    has('gold', '!(input.Skip)')
    has('silver', '!(input.Skip)')
    has('bronze', 'End')
    // only the else side is durable: the condition is negated
    has('!(input.Skip)', 'only-else', 'yes')
    has('!(input.Skip)', 'finish', 'no')

    const vip = graph.nodes.find((n) => n.label === 'input.Vip')!
    assert.deepEqual([vip.thenCount, vip.elseCount, vip.sourceLine], [1, 2, 19])
    assert.equal(graph.nodes.find((n) => n.label === 'silver')!.sourceLine, 31)
  })

  it('finds WrapAsync workflows with nested generics, qualified names and expression bodies', () => {
    const graph = parser.parseFile(resolve(fixturesDir, 'EntryShapes.cs'))
    // Child-context contents live inside the child node, not at the top level
    assert.deepEqual(graph.nodes.map((n) => n.label), ['Start', 'process', 'End'])
    const process = graph.nodes[1]
    assert.equal(process.kind, 'runInChildContext')
    assert.deepEqual(process.branches!.map((b) => [b.name, b.dynamic]), [['process', false]])
    const inner = process.branches![0].nodes
    assert.deepEqual(inner.map((n) => [n.kind, n.label, n.sourceLine]), [
      ['step', 'inner-a', 23], ['wait', 'inner-wait', 24],
      ['runInChildContext', 'helper', 25], ['runInChildContext', 'empty', 26],
    ])
    // Method-group child context → helper body; nothing durable inside → no branches
    assert.deepEqual(inner[2].branches!.map((b) => [b.name, b.nodes.map((n) => [n.label, n.sourceLine])]), [['helper', [['helper-step', 33]]]])
    assert.equal(inner[3].branches, undefined)

    const all = (nodes: WorkflowNode[]): WorkflowNode[] =>
      nodes.flatMap((n) => [n, ...all((n.branches ?? []).flatMap((b) => b.nodes))])
    const id = (label: string) => all(graph.nodes).find((n) => n.label === label)!.id
    assert.ok(graph.edges.some((e) => e.from === id('inner-a') && e.to === id('inner-wait')))
  })

  it('parses a lambda passed to WrapAsync as the workflow', () => {
    const graph = parser.parseFile(resolve(fixturesDir, 'LambdaWorkflow.cs'))
    assert.deepEqual(graph.nodes.map((n) => [n.label, n.sourceLine]), [
      ['Start', undefined], ['lambda-step', 14], ['lambda-wait', 15], ['End', undefined],
    ])
  })
})
