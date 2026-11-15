import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { JavaParser } from './java.js'
import type { WorkflowNode } from '../graph.js'

const parser = new JavaParser()
const examplesDir = resolve(import.meta.dirname, '../../../..', 'examples')
const fixturesDir = resolve(import.meta.dirname, '../../../..', 'packages/core/test-fixtures')

describe('JavaParser', () => {
  it('parses the OrderProcessor example', () => {
    const graph = parser.parseFile(resolve(examplesDir, 'OrderProcessor.java'))

    assert.equal(graph.name, 'OrderProcessor')

    const kinds = graph.nodes.map((n) => n.kind)
    assert.ok(kinds.includes('start'))
    assert.ok(kinds.includes('end'))
    assert.ok(kinds.includes('step'))
    assert.ok(kinds.includes('parallel'))
    assert.ok(kinds.includes('wait'))
    assert.ok(kinds.includes('invoke'))
    assert.ok(kinds.includes('waitForCallback'))
    assert.ok(kinds.includes('condition'))
  })

  it('extracts step names from string literals', () => {
    const graph = parser.parseFile(resolve(examplesDir, 'OrderProcessor.java'))

    const stepLabels = graph.nodes
      .filter((n) => n.kind === 'step')
      .map((n) => n.label)

    assert.ok(stepLabels.includes('validate-order'))
    assert.ok(stepLabels.includes('send-confirmation'))
  })

  it('extracts invoke target', () => {
    const graph = parser.parseFile(resolve(examplesDir, 'OrderProcessor.java'))

    const invoke = graph.nodes.find((n) => n.kind === 'invoke')
    assert.ok(invoke)
    assert.equal(invoke.target, 'fulfillment-service')
  })

  it('extracts parallel branches', () => {
    const graph = parser.parseFile(resolve(examplesDir, 'OrderProcessor.java'))

    const parallel = graph.nodes.find((n) => n.kind === 'parallel')
    assert.ok(parallel)
    assert.equal(parallel.label, 'prepare')
    assert.ok(parallel.branches)
    assert.equal(parallel.branches.length, 2)

    const branchNames = parallel.branches.map((b) => b.name)
    assert.ok(branchNames.includes('reserve-inventory'))
    assert.ok(branchNames.includes('process-payment'))
  })

  it('detects condition with waitForCallback', () => {
    const graph = parser.parseFile(resolve(examplesDir, 'OrderProcessor.java'))

    const condition = graph.nodes.find((n) => n.kind === 'condition')
    assert.ok(condition)
    assert.ok(condition.thenCount)

    const callback = graph.nodes.find((n) => n.kind === 'waitForCallback')
    assert.ok(callback)
    assert.equal(callback.label, 'manager-approval')
  })

  it('includes source line numbers', () => {
    const graph = parser.parseFile(resolve(examplesDir, 'OrderProcessor.java'))

    const nodesWithLines = graph.nodes.filter((n) => n.sourceLine != null)
    assert.ok(nodesWithLines.length >= 5, `Expected at least 5 nodes with source lines, got ${nodesWithLines.length}`)
  })

  it('generates valid edges', () => {
    const graph = parser.parseFile(resolve(examplesDir, 'OrderProcessor.java'))

    assert.ok(graph.edges.length > 0)

    const startEdges = graph.edges.filter((e) => e.from === 'node_start')
    assert.equal(startEdges.length, 1)

    const endEdges = graph.edges.filter((e) => e.to === 'node_end')
    assert.ok(endEdges.length >= 1)
  })

  it('throws for non-durable files', () => {
    assert.throws(
      () => parser.parseFile(resolve(examplesDir, 'order_processor.py')),
      /No DurableHandler/
    )
  })

  it('detects DurableFuture.allOf', () => {
    const graph = parser.parseFile(resolve(examplesDir, 'OrderProcessorFutures.java'))

    const allOf = graph.nodes.find((n) => n.kind === 'promiseAll')
    assert.ok(allOf, 'Should detect DurableFuture.allOf')
  })

  it('detects DurableFuture.anyOf', () => {
    const graph = parser.parseFile(resolve(examplesDir, 'OrderProcessorFutures.java'))

    const anyOf = graph.nodes.find((n) => n.kind === 'promiseAny')
    assert.ok(anyOf, 'Should detect DurableFuture.anyOf')
  })

  it('extracts stepSemantics from StepConfig', () => {
    const graph = parser.parseFile(resolve(examplesDir, 'OrderProcessorFutures.java'))

    const step = graph.nodes.find((n) => n.kind === 'step' && n.label === 'validate-order')
    assert.ok(step, 'Should find validate-order step')
    assert.equal(step.stepSemantics, 'AT MOST ONCE PER RETRY')
  })

  it('extracts nestingType from parallel config', () => {
    const graph = parser.parseFile(resolve(examplesDir, 'OrderProcessorFutures.java'))

    const parallel = graph.nodes.find((n) => n.kind === 'parallel')
    assert.ok(parallel, 'Should find parallel node')
    assert.equal(parallel.nestingType, 'FLAT')
  })

  it('extracts completionConfig from parallel config', () => {
    const graph = parser.parseFile(resolve(examplesDir, 'OrderProcessorFutures.java'))

    const parallel = graph.nodes.find((n) => n.kind === 'parallel')
    assert.ok(parallel, 'Should find parallel node')
    assert.equal(parallel.completionConfig, 'first successful')
  })

  it('extracts tenantId from invoke config', () => {
    const graph = parser.parseFile(resolve(examplesDir, 'OrderProcessorFutures.java'))

    const invoke = graph.nodes.find((n) => n.kind === 'invoke' && n.target === 'fulfillment-service')
    assert.ok(invoke, 'Should find invoke node')
    assert.equal(invoke.tenantId, 'tenant-abc-123')
  })

  it('extracts nestingType from map config', () => {
    const graph = parser.parseFile(resolve(examplesDir, 'OrderProcessorFutures.java'))

    const map = graph.nodes.find((n) => n.kind === 'map')
    assert.ok(map, 'Should find map node')
    assert.equal(map.nestingType, 'FLAT')
    assert.equal(map.completionConfig, 'all completed')
  })

  it('extracts nestingType from runInChildContext with isVirtual', () => {
    const graph = parser.parseFile(resolve(examplesDir, 'OrderProcessorFutures.java'))

    const child = graph.nodes.find((n) => n.kind === 'runInChildContext' && n.label === 'isolated-logic')
    assert.ok(child, 'Should find runInChildContext node')
    assert.equal(child.nestingType, 'FLAT')
  })

  it('extracts step name from dotted identifier (comp.name)', () => {
    const graph = parser.parseFile(resolve(fixturesDir, 'DynamicNames.java'))
    const labels = graph.nodes.map((n) => n.label)
    assert.ok(labels.includes('comp.name'), 'Should extract dotted identifier comp.name')
  })

  it('extracts step name from function call (getName())', () => {
    const graph = parser.parseFile(resolve(fixturesDir, 'DynamicNames.java'))
    const labels = graph.nodes.map((n) => n.label)
    assert.ok(labels.includes('getCompName'), 'Should extract function name getCompName')
  })

  it('extracts step name from variable reference', () => {
    const graph = parser.parseFile(resolve(fixturesDir, 'DynamicNames.java'))
    const labels = graph.nodes.map((n) => n.label)
    assert.ok(labels.includes('compName'), 'Should extract variable compName')
  })

  it('extracts step names from multi-line calls', () => {
    const graph = parser.parseFile(resolve(fixturesDir, 'DynamicNames.java'))
    const labels = graph.nodes.map((n) => n.label)
    assert.ok(labels.includes('multi-line-name'), 'Should extract name from multi-line call')
  })

  it('parses files with nested generics in class declaration', () => {
    const graph = parser.parseFile(resolve(fixturesDir, 'NestedGenerics.java'))
    const labels = graph.nodes.map((n) => n.label)
    assert.ok(labels.includes('nested-generics-step'), 'Should parse nested generics file')
    const kinds = graph.nodes.map((n) => n.kind)
    assert.ok(kinds.includes('step'))
  })

  it('keeps the structure of parallel branch lambdas', () => {
    const graph = parser.parseFile(resolve(fixturesDir, 'NestedParallel.java'))
    const outer = graph.nodes.find((n) => n.label === 'outer')!
    const [first, gated] = outer.branches!
    assert.equal(outer.branches!.length, 2, 'inner branches are not counted as outer branches')

    // A nested parallel stays a parallel, followed by the step after it
    assert.deepEqual(first.nodes.map((n) => [n.kind, n.label]), [['parallel', 'inner'], ['step', 'tail']])
    assert.deepEqual(first.nodes[0].branches!.map((b) => b.nodes.map((n) => n.label)), [['a'], ['b']])
    assert.equal(gated.name, 'gated')
    assert.deepEqual(gated.nodes.map((n) => n.kind), ['invoke', 'condition', 'step'])

    const all = (nodes: WorkflowNode[]): WorkflowNode[] =>
      nodes.flatMap((n) => [n, ...all((n.branches ?? []).flatMap((b) => b.nodes))])
    const byLabel = (label: string) => all(graph.nodes).find((n) => n.label === label)!
    assert.deepEqual(['a', 'tail', 'vip', 'after'].map((l) => byLabel(l).sourceLine), [13, 16, 21, 27])
    // Branch lines are not re-read as top-level nodes
    assert.deepEqual(graph.nodes.map((n) => n.label), ['Start', 'outer', 'after', 'End'])

    const id = (label: string) => byLabel(label).id
    const edge = (from: string, to: string) => graph.edges.some((e) => e.from === from && e.to === to)
    assert.ok(edge(id('a'), id('tail')), 'inner branches join at tail')
    assert.ok(edge(id('b'), id('tail')), 'inner branches join at tail')
    assert.ok(edge(id('tail'), id('after')), 'outer branch joins at after')
    assert.ok(graph.edges.some((e) => e.from === id('order.isVip()') && e.to === id('after') && e.label === 'no'),
      'skipped condition leaves the branch')
  })

  it('reads branch contents from expression lambdas', () => {
    const graph = parser.parseFile(resolve(examplesDir, 'OrderProcessor.java'))
    const parallel = graph.nodes.find((n) => n.kind === 'parallel')!
    assert.deepEqual(parallel.branches!.map((b) => b.nodes.map((n) => [n.label, n.sourceLine])), [[['reserve', 23]], [['charge', 26]]])
  })

  describe('map callbacks and branch variables', () => {
    const graph = parser.parseFile(resolve(fixturesDir, 'MapAndBranchVars.java'))
    const byLabel = (label: string) => graph.nodes.find((n) => n.label === label)!
    const branchNodes = (label: string) =>
      byLabel(label).branches!.map((b) => [b.name, b.dynamic, b.nodes.map((n) => [n.kind, n.label, n.sourceLine])])

    it('keeps lambda variables, field lambdas and callbacks out of the top level', () => {
      assert.deepEqual(graph.nodes.map((n) => n.label),
        ['Start', 'fan-out', 'per-item', 'no-durable', 'by-ref', 'done', 'End'])
    })

    it('resolves branch functions held in variables, fields and method references', () => {
      assert.deepEqual(branchNodes('fan-out'), [
        ['audit', false, [['step', 'audit-step', 16], ['invoke', 'audit-fn', 17]]],
        ['field', false, [['step', 'from-field', 11]]],
        ['ref', false, [['step', 'notify', 42]]],
      ])
    })

    it('turns a map item callback into one dynamic branch', () => {
      assert.deepEqual(branchNodes('per-item'), [
        ['each item', true, [['step', 'validate-item', 26], ['condition', 'item.isFragile()', 27], ['wait', 'settle', 28]]],
      ])
      assert.equal(byLabel('per-item').maxConcurrency, 2)
      assert.deepEqual(branchNodes('by-ref'), [['each item', true, [['step', 'process', 46]]]])
    })

    it('gives a map without durable calls in its callback no branches', () => {
      assert.deepEqual(byLabel('no-durable').branches, [])
    })
  })

  describe('branch sources resolved by scope', () => {
    const graph = parser.parseFile(resolve(fixturesDir, 'BranchScopes.java'))
    const scoped = graph.nodes.find((n) => n.label === 'scoped')!

    it('resolves variables through enclosing blocks, method-reference variables and later fields', () => {
      assert.deepEqual(scoped.branches!.map((b) => [b.name, b.dynamic, b.nodes.map((n) => [n.label, n.sourceLine])]), [
        ['shared', false, [['outer-shared', 16]]],
        ['by-ref', false, [['via-ref-var', 37]]],
        ['late-field', false, [['right-field', 40]]],
        ['each item', true, [['deploy', 26]]],
      ])
    })

    it('never picks a same-named local from another method', () => {
      const labels = scoped.branches!.flatMap((b) => b.nodes.map((n) => n.label))
      assert.ok(!labels.includes('wrong-local') && !labels.includes('wrong-shared'))
    })

    it('keeps the branch loop and conditional branch out of the top level', () => {
      assert.deepEqual(graph.nodes.map((n) => n.label), ['Start', 'scoped', 'after', 'End'])
    })
  })

  describe('child contexts and retry wrappers', () => {
    const graph = parser.parseFile(resolve(fixturesDir, 'ChildContexts.java'))
    const byLabel = (label: string) => graph.nodes.find((n) => n.label === label)!
    const tree = (nodes: WorkflowNode[]): unknown[] => nodes.map((n) =>
      n.branches ? [n.kind, n.label, n.sourceLine, n.branches.map((b) => [b.name, b.dynamic, tree(b.nodes)])] : [n.kind, n.label, n.sourceLine])

    it('draws a child context, including *Async and nested ones, as a box of its calls', () => {
      assert.deepEqual(tree([byLabel('validation')]), [['runInChildContext', 'validation', 13, [['validation', false, [
        ['step', 'prepare', 14],
        ['wait', 'settle', 15],
        ['runInChildContext', 'nested', 16, [['nested', false, [['step', 'lookup', 19]]]]],
      ]]]]])
    })

    it('reads method references, withRetry lambdas, and leaves empty callbacks without branches', () => {
      assert.deepEqual(tree([byLabel('by-ref')]), [['runInChildContext', 'by-ref', 22, [['by-ref', false, [['step', 'ship', 33]]]]]])
      assert.deepEqual(tree([byLabel('charge')]), [['withRetry', 'charge', 24, [['charge', false, [['invoke', 'charge-', 26]]]]]])
      assert.equal(byLabel('plain').branches, undefined)
    })

    it('keeps the inner calls out of the top level', () => {
      assert.deepEqual(graph.nodes.map((n) => n.label),
        ['Start', 'validation', 'by-ref', 'plain', 'charge', 'allOf', 'finish', 'End'])
    })

    it('connects the box contents to the next node', () => {
      const lookup = byLabel('validation').branches![0].nodes[2].branches![0].nodes[0]
      assert.ok(graph.edges.some((e) => e.from === lookup.id && e.to === byLabel('by-ref').id))
    })
  })

  it('reads try-with-resources parallels, nested, and a handler method not named handleRequest', () => {
    const graph = parser.parseFile(resolve(fixturesDir, 'TryParallel.java'))
    const outer = graph.nodes.find((n) => n.label === 'outer')!
    assert.deepEqual(outer.branches!.map((b) => [b.name, b.nodes.map((n) => n.label)]), [['group-a', ['inner-a']], ['group-b', ['b']]])
    assert.deepEqual(outer.branches![0].nodes[0].branches!.map((b) => [b.name, b.nodes.map((n) => [n.label, n.sourceLine])]),
      [['a1', [['a1', 12]]], ['a2', [['a2', 13]]]])
    assert.deepEqual(graph.nodes.map((n) => n.label), ['Start', 'outer', 'inside-try', 'End'])
  })

  it('draws else and else-if branches', () => {
    const graph = parser.parseFile(resolve(fixturesDir, 'IfElse.java'))
    const id = (label: string) => graph.nodes.find((n) => n.label === label)!.id
    const edges = new Set(graph.edges.map((e) => `${e.from}>${e.to}${e.label ? ':' + e.label : ''}`))
    const has = (from: string, to: string, label?: string) =>
      assert.ok(edges.has(`${id(from)}>${id(to)}${label ? ':' + label : ''}`), `${from} -> ${to} ${label ?? ''}`)
    const gold = 'event.getTier().equals("gold")'

    // if / else: both sides join at the next condition
    has('event.isVip()', 'fast-track', 'yes')
    has('event.isVip()', 'queue', 'no')
    has('fast-track', gold)
    has('notify-wait', gold)
    // else-if chain: the last else returns, so it ends the workflow
    has(gold, 'event.getTier().equals("silver")', 'no')
    has('gold', '!(event.isSkip())')
    has('silver', '!(event.isSkip())')
    has('bronze', 'End')
    // only the else side is durable: the condition is negated
    has('!(event.isSkip())', 'only-else', 'yes')
    has('!(event.isSkip())', 'loop: var order : event.getOrders()', 'no')
    // inside a loop the body count covers both sides
    const loop = graph.nodes.find((n) => n.kind === 'loop')!
    assert.equal(loop.bodyCount, 3)
    has('order.isRush()', 'standard', 'no')
    has('rush', 'loop: var order : event.getOrders()', 'next')
    has('standard', 'loop: var order : event.getOrders()', 'next')
    assert.deepEqual(['queue', 'silver', 'bronze', 'standard'].map((l) => graph.nodes.find((n) => n.label === l)!.sourceLine), [13, 20, 22, 36])
  })

  it('reads the map item callback of the futures example', () => {
    const graph = parser.parseFile(resolve(examplesDir, 'OrderProcessorFutures.java'))
    const map = graph.nodes.find((n) => n.kind === 'map')!
    assert.deepEqual(map.branches!.map((b) => [b.name, b.nodes.map((n) => [n.label, n.sourceLine])]), [['each item', [['process-item', 46]]]])
    assert.equal(map.nestingType, 'FLAT')
  })

  describe('loops', () => {
    const graph = parser.parseFile(resolve(fixturesDir, 'Loops.java'))
    const loops = graph.nodes.filter((n) => n.kind === 'loop')

    it('should emit a loop node for for, enhanced for, while and do-while loops', () => {
      assert.deepEqual(loops.map((n) => n.loopHeader), [
        'Order order : input.getOrders()',
        'int attempt = 0; attempt < 3; attempt++',
        'String region : regions(input.getRegions())',
        '!isDone()',
        'hasMore(input)',
      ])
    })

    it('should not emit a loop node when the body has no durable calls', () => {
      assert.ok(!graph.nodes.some((n) => n.loopHeader?.includes('ignored')))
    })

    it('should include a nested condition, its branch and the step after it in the body count', () => {
      const orderLoop = loops[0]
      const index = graph.nodes.indexOf(orderLoop)
      const body = graph.nodes.slice(index + 1, index + 1 + (orderLoop.bodyCount ?? 0))

      assert.deepEqual(body.map((n) => n.label), ['validate', 'order.isVip()', 'vip-perk', 'charge'])
    })

    it('should keep a header that contains a call intact', () => {
      assert.equal(loops[2].bodyCount, 1)
      assert.equal(loops[2].label, 'loop: String region : regions(input.getRegions())')
    })

    it('should detect literal iteration counts', () => {
      assert.equal(loops[1].iterations, 3)
      assert.equal(loops[0].iterations, undefined)
    })

    it('should report source lines for the loop and the steps inside it', () => {
      const lines = Object.fromEntries(graph.nodes.map((n) => [n.label, n.sourceLine]))

      assert.equal(loops[0].sourceLine, 9)
      assert.equal(lines['validate'], 10)
      assert.equal(lines['vip-perk'], 12)
      assert.equal(lines['charge'], 14)
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
})
