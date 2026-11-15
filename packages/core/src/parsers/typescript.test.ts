import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { TypeScriptParser } from './typescript.js'
import type { WorkflowNode } from '../graph.js'

const parser = new TypeScriptParser()
const examplesDir = resolve(import.meta.dirname, '../../../..', 'examples')
const fixturesDir = resolve(import.meta.dirname, '../../../..', 'packages/core/test-fixtures')

describe('TypeScriptParser', () => {
  it('parses the order workflow example', () => {
    const graph = parser.parseFile(resolve(examplesDir, 'order-workflow.ts'))

    assert.equal(graph.name, 'order-workflow')

    const kinds = graph.nodes.map((n) => n.kind)
    assert.ok(kinds.includes('start'))
    assert.ok(kinds.includes('end'))
    assert.ok(kinds.includes('step'))
    assert.ok(kinds.includes('parallel'))
    assert.ok(kinds.includes('waitForCallback'))
    assert.ok(kinds.includes('condition'))
  })

  it('extracts step names', () => {
    const graph = parser.parseFile(resolve(examplesDir, 'order-workflow.ts'))

    const stepLabels = graph.nodes
      .filter((n) => n.kind === 'step')
      .map((n) => n.label)

    assert.ok(stepLabels.includes('validate-order'))
    assert.ok(stepLabels.includes('review-results'))
    assert.ok(stepLabels.includes('fulfill-order'))
  })

  it('extracts parallel branches with invoke targets', () => {
    const graph = parser.parseFile(resolve(examplesDir, 'order-workflow.ts'))

    const parallel = graph.nodes.find((n) => n.kind === 'parallel')
    assert.ok(parallel)
    assert.equal(parallel.label, 'prepare-order')
    assert.ok(parallel.branches)
    assert.equal(parallel.branches.length, 2)

    const branchNames = parallel.branches.map((b) => b.name)
    assert.ok(branchNames.includes('check-inventory'))
    assert.ok(branchNames.includes('reserve-payment'))
  })

  it('detects condition with waitForCallback', () => {
    const graph = parser.parseFile(resolve(examplesDir, 'order-workflow.ts'))

    const condition = graph.nodes.find((n) => n.kind === 'condition')
    assert.ok(condition)
    assert.ok(condition.thenCount)
    assert.ok(condition.thenCount >= 1)

    const callback = graph.nodes.find((n) => n.kind === 'waitForCallback')
    assert.ok(callback)
    assert.equal(callback.label, 'manager-approval')
  })

  it('includes source line numbers', () => {
    const graph = parser.parseFile(resolve(examplesDir, 'order-workflow.ts'))

    const nodesWithLines = graph.nodes.filter((n) => n.sourceLine != null)
    assert.ok(nodesWithLines.length >= 5, `Expected at least 5 nodes with source lines, got ${nodesWithLines.length}`)

    for (const node of nodesWithLines) {
      assert.ok(node.sourceLine! > 0, `Source line should be positive, got ${node.sourceLine}`)
    }
  })

  it('generates edges connecting all nodes', () => {
    const graph = parser.parseFile(resolve(examplesDir, 'order-workflow.ts'))

    assert.ok(graph.edges.length > 0)

    // Start should have an outgoing edge
    const startEdges = graph.edges.filter((e) => e.from === 'node_start')
    assert.equal(startEdges.length, 1)

    // End should have incoming edges
    const endEdges = graph.edges.filter((e) => e.to === 'node_end')
    assert.ok(endEdges.length >= 1)
  })

  it('condition yes/no edges exist', () => {
    const graph = parser.parseFile(resolve(examplesDir, 'order-workflow.ts'))

    const yesEdge = graph.edges.find((e) => e.label === 'yes')
    const noEdge = graph.edges.find((e) => e.label === 'no')
    assert.ok(yesEdge, 'Should have a yes edge')
    assert.ok(noEdge, 'Should have a no edge')
  })

  it('allows name override', () => {
    const graph = parser.parseFile(resolve(examplesDir, 'order-workflow.ts'), { name: 'custom-name' })
    assert.equal(graph.name, 'custom-name')
  })

  it('throws for non-durable files', () => {
    // The examples directory has a Python file with no withDurableExecution
    assert.throws(
      () => parser.parseFile(resolve(examplesDir, 'order_processor.py')),
      /No withDurableExecution/
    )
  })

  it('detects stepSemantics from StepConfig', () => {
    const graph = parser.parseFile(resolve(examplesDir, 'order-workflow-config.ts'))

    const step = graph.nodes.find((n) => n.kind === 'step' && n.label === 'validate-order')
    assert.ok(step, 'Should find validate-order step')
    assert.equal(step.stepSemantics, 'AtMostOncePerRetry')
  })

  it('detects nestingType on parallel node', () => {
    const graph = parser.parseFile(resolve(examplesDir, 'order-workflow-config.ts'))

    const parallel = graph.nodes.find((n) => n.kind === 'parallel')
    assert.ok(parallel, 'Should find parallel node')
    assert.equal(parallel.nestingType, 'FLAT')
  })

  it('detects completionConfig on parallel node', () => {
    const graph = parser.parseFile(resolve(examplesDir, 'order-workflow-config.ts'))

    const parallel = graph.nodes.find((n) => n.kind === 'parallel')
    assert.ok(parallel, 'Should find parallel node')
    assert.equal(parallel.completionConfig, 'first successful')
  })

  it('detects nestingType on map node', () => {
    const graph = parser.parseFile(resolve(examplesDir, 'order-workflow-config.ts'))

    const map = graph.nodes.find((n) => n.kind === 'map')
    assert.ok(map, 'Should find map node')
    assert.equal(map.nestingType, 'FLAT')
    assert.equal(map.completionConfig, 'all completed')
  })

  it('detects tenantId on invoke node', () => {
    const graph = parser.parseFile(resolve(examplesDir, 'order-workflow-config.ts'))

    const invoke = graph.nodes.find((n) => n.kind === 'invoke' && n.target === 'fulfillment-service')
    assert.ok(invoke, 'Should find invoke node')
    assert.equal(invoke.tenantId, 'tenant-abc-123')
  })

  it('detects nestingType on runInChildContext with isVirtual', () => {
    const graph = parser.parseFile(resolve(examplesDir, 'order-workflow-config.ts'))

    const child = graph.nodes.find((n) => n.kind === 'runInChildContext' && n.label === 'isolated-logic')
    assert.ok(child, 'Should find runInChildContext node')
    assert.equal(child.nestingType, 'FLAT')
  })

  it('detects nestingType on withRetry with virtualContext', () => {
    const graph = parser.parseFile(resolve(examplesDir, 'order-workflow-config.ts'))

    const retry = graph.nodes.find((n) => n.kind === 'withRetry')
    assert.ok(retry, 'Should find withRetry node')
    assert.equal(retry.nestingType, 'FLAT')
  })

  it('extracts step names from PropertyAccessExpression (obj.name)', () => {
    const graph = parser.parseFile(resolve(fixturesDir, 'dynamic-names.ts'))
    const labels = graph.nodes.map((n) => n.label)
    assert.ok(labels.includes('obj.name'), 'Should extract obj.name')
  })

  it('extracts step names from Identifier (variable)', () => {
    const graph = parser.parseFile(resolve(fixturesDir, 'dynamic-names.ts'))
    const labels = graph.nodes.map((n) => n.label)
    assert.ok(labels.includes('STEP_NAME'), 'Should extract STEP_NAME const')
    assert.ok(labels.includes('varName'), 'Should extract varName variable')
  })

  it('extracts step names from TemplateExpression', () => {
    const graph = parser.parseFile(resolve(fixturesDir, 'dynamic-names.ts'))
    const labels = graph.nodes.map((n) => n.label)
    assert.ok(labels.includes('template-?'), 'Should extract template with ? placeholder')
  })

  it('extracts step names from CallExpression (function ref)', () => {
    const graph = parser.parseFile(resolve(fixturesDir, 'dynamic-names.ts'))
    const labels = graph.nodes.map((n) => n.label)
    assert.ok(labels.includes('getStepName'), 'Should extract function name')
  })

  it('prevents duplicate nodes from try/catch inside if-block', () => {
    const graph = parser.parseFile(resolve(fixturesDir, 'no-duplicates.ts'))
    const condition = graph.nodes.find((n) => n.kind === 'condition')
    assert.ok(condition, 'Should have condition node')
    assert.equal(condition.thenCount, 3, 'Should have 3 nodes, not 6 (no duplicates)')
    const labels = graph.nodes.map((n) => n.label)
    assert.equal(labels.filter((l) => l === 'callback-ok').length, 1, 'Should have exactly one callback-ok')
    assert.equal(labels.filter((l) => l === 'finalize-ok').length, 1, 'Should have exactly one finalize-ok')
    assert.equal(labels.filter((l) => l === 'finalize-err').length, 1, 'Should have exactly one finalize-err')
  })

  describe('loops', () => {
    const graph = parser.parseFile(resolve(fixturesDir, 'loops.ts'))
    const loops = graph.nodes.filter((n) => n.kind === 'loop')

    it('should emit a loop node for each loop that wraps durable calls', () => {
      assert.deepEqual(loops.map((n) => n.loopHeader), [
        'const order of event.orders',
        'let attempt = 0; attempt < 3; attempt++',
        'true',
        "const region of ['us', 'eu']",
      ])
    })

    it('should not emit a loop node when the body has no durable calls', () => {
      assert.ok(!graph.nodes.some((n) => n.loopHeader?.includes('skipped')))
    })

    it('should count the body nodes including a nested condition and its branch', () => {
      const orderLoop = loops[0]
      const index = graph.nodes.indexOf(orderLoop)
      const body = graph.nodes.slice(index + 1, index + 1 + (orderLoop.bodyCount ?? 0))

      assert.deepEqual(body.map((n) => n.label), ['validate', 'order.startsWith(\'vip\')', 'vip-perk', 'charge'])
      assert.equal(orderLoop.bodyCount, 4)
    })

    it('should detect literal iteration counts', () => {
      assert.equal(loops[1].iterations, 3)
      assert.equal(loops[1].label, 'loop: let attempt = 0; attempt < 3; attempt++ x3')
      assert.equal(loops[3].iterations, 2)
      assert.equal(loops[0].iterations, undefined)
      assert.equal(loops[2].iterations, undefined)
    })

    it('should record the source line of the loop statement', () => {
      assert.equal(loops[0].sourceLine, 6)
    })

    it('should treat a parallel node inside a loop as one body node', () => {
      const regionLoop = loops[3]
      const index = graph.nodes.indexOf(regionLoop)

      assert.equal(regionLoop.bodyCount, 1)
      assert.equal(graph.nodes[index + 1].kind, 'parallel')
    })

    it('should connect each loop with a back-edge and a done edge', () => {
      for (const loop of loops) {
        const back = graph.edges.filter((e) => e.to === loop.id && e.style === 'back')
        const done = graph.edges.filter((e) => e.from === loop.id && e.label === 'done')
        assert.ok(back.length >= 1, `${loop.label} has a back-edge`)
        assert.equal(done.length, 1, `${loop.label} has one done edge`)
      }
    })

    it('should route the no edge of a condition inside a loop to the next body node', () => {
      const cond = graph.nodes.find((n) => n.kind === 'condition' && n.label.includes('startsWith'))!
      const noEdge = graph.edges.find((e) => e.from === cond.id && e.label === 'no')!
      const target = graph.nodes.find((n) => n.id === noEdge.to)!

      assert.equal(target.label, 'charge')
    })

    it('should place a durable call in a for-of iterable before the loop and handle nested loops', () => {
      const nested = parser.parseFile(resolve(fixturesDir, 'loops-nested.ts'))
      const labels = nested.nodes.map((n) => n.label)

      assert.deepEqual(labels.slice(1, -1), [
        'load',
        'list',
        'loop: const name of await context.step(\'list\', async () => names)',
        'loop: const batch of event.batches',
        'process',
        'summarize',
      ])

      const outer = nested.nodes.find((n) => n.loopHeader?.startsWith('const name'))!
      const inner = nested.nodes.find((n) => n.loopHeader?.startsWith('const batch'))!
      assert.equal(outer.bodyCount, 3)
      assert.equal(inner.bodyCount, 1)
      assert.ok(nested.edges.some((e) => e.from === inner.id && e.label === 'done' && e.to !== outer.id))
    })
  })

  it('keeps the structure of inline branch callbacks', () => {
    const graph = parser.parseFile(resolve(fixturesDir, 'nested-parallel.ts'))
    const outer = graph.nodes.find((n) => n.label === 'outer')!
    const [first, gated] = outer.branches!

    // A nested parallel stays a parallel, followed by the step after it
    assert.deepEqual(first.nodes.map((n) => [n.kind, n.label]), [['parallel', 'inner'], ['step', 'tail']])
    assert.deepEqual(first.nodes[0].branches!.map((b) => b.nodes.map((n) => n.label)), [['a'], ['b']])
    // Source order and conditions are kept inside a branch object's func
    assert.equal(gated.name, 'gated')
    assert.deepEqual(gated.nodes.map((n) => n.kind), ['invoke', 'condition', 'step'])

    const all = (nodes: WorkflowNode[]): WorkflowNode[] =>
      nodes.flatMap((n) => [n, ...all((n.branches ?? []).flatMap((b) => b.nodes))])
    const id = (label: string) => all(graph.nodes).find((n) => n.label === label)!.id
    const edge = (from: string, to: string) => graph.edges.some((e) => e.from === from && e.to === to)
    assert.ok(edge(id('a'), id('tail')), 'inner branches join at tail')
    assert.ok(edge(id('tail'), id('after')), 'outer branch joins at after')
    assert.ok(edge(id('event.vip'), id('after')), 'skipped condition leaves the branch')
  })

  it('reads a map item callback as one branch per item', () => {
    const graph = parser.parseFile(resolve(fixturesDir, 'map-callback.ts'))
    const map = graph.nodes.find((n) => n.kind === 'map')!

    assert.deepEqual(map.branches!.map((b) => [b.name, b.dynamic, b.nodes.map((n) => n.label)]), [['each item', true, ['charge']]])
    assert.ok(!graph.nodes.some((n) => n.label === 'charge'), 'item steps stay inside the map')
  })

  it('reads branches and map callbacks held in variables', () => {
    const graph = parser.parseFile(resolve(fixturesDir, 'branch-variables.ts'))

    // Declared steps are drawn inside the parallel/map, not where they are declared
    assert.deepEqual(graph.nodes.map((n) => n.label), ['Start', 'prepare', 'ship-all', 'notify', 'End'])
    const prepare = graph.nodes[1]
    assert.deepEqual(prepare.branches!.map((b) => [b.name, b.nodes.map((n) => n.label)]), [['branch', ['charge']], ['reserveStock', ['reserve']]])
    assert.deepEqual(graph.nodes[2].branches!.map((b) => [b.name, b.dynamic, b.nodes.map((n) => n.label)]), [['each item', true, ['ship']]])
  })

  it('resolves branch variables by scope and follows push and generated lists', () => {
    const graph = parser.parseFile(resolve(fixturesDir, 'branch-scopes.ts'))
    const labels = graph.nodes.map((n) => n.label)

    // Nothing leaks to the top level, and the other function's `branches` is ignored
    assert.deepEqual(labels, ['Start', 'event.vip', 'fan-out', 'regions', 'End'])
    const fanOut = graph.nodes[2]
    assert.deepEqual(fanOut.branches!.map((b) => b.nodes.map((n) => n.label)), [['first'], ['pushed']])
    const regions = graph.nodes[3]
    assert.ok(regions.branches!.length > 0 && regions.branches!.every((b) => b.dynamic))
  })

  it('draws else and else-if branches', () => {
    const graph = parser.parseFile(resolve(fixturesDir, 'if-else.ts'))
    const id = (label: string) => graph.nodes.find((n) => n.label === label)!.id
    const edges = new Set(graph.edges.map((e) => `${e.from}>${e.to}${e.label ? ':' + e.label : ''}`))
    const has = (from: string, to: string, label?: string) =>
      assert.ok(edges.has(`${id(from)}>${id(to)}${label ? ':' + label : ''}`), `${from} -> ${to} ${label ?? ''}`)

    // if / else: both sides join at the next condition
    has('event.vip', 'fast-track', 'yes')
    has('event.vip', 'queue', 'no')
    has('fast-track', "event.tier === 'gold'")
    has('notify-wait', "event.tier === 'gold'")
    // else-if chain: the last else returns, so it ends the workflow
    has("event.tier === 'gold'", "event.tier === 'silver'", 'no')
    has('gold', '!(event.skip)')
    has('silver', '!(event.skip)')
    has('bronze', 'End')
    // only the else side is durable: the condition is negated
    has('!(event.skip)', 'only-else', 'yes')
    has('!(event.skip)', 'finish', 'no')
  })
})
