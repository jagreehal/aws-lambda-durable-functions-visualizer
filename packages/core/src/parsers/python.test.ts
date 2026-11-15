import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { PythonParser } from './python.js'
import type { WorkflowNode } from '../graph.js'

const parser = new PythonParser()
const examplesDir = resolve(import.meta.dirname, '../../../..', 'examples')
const fixturesDir = resolve(import.meta.dirname, '../../../..', 'packages/core/test-fixtures')

describe('PythonParser', () => {
  it('parses the order processor example', () => {
    const graph = parser.parseFile(resolve(examplesDir, 'order_processor.py'))

    assert.equal(graph.name, 'order_processor')

    const kinds = graph.nodes.map((n) => n.kind)
    assert.ok(kinds.includes('start'))
    assert.ok(kinds.includes('end'))
    assert.ok(kinds.includes('step'))
    assert.ok(kinds.includes('wait'))
    assert.ok(kinds.includes('createCallback'))
    assert.ok(kinds.includes('condition'))
  })

  it('extracts step names from name= arguments', () => {
    const graph = parser.parseFile(resolve(examplesDir, 'order_processor.py'))

    const stepLabels = graph.nodes
      .filter((n) => n.kind === 'step')
      .map((n) => n.label)

    assert.ok(stepLabels.includes('validate_order'))
    assert.ok(stepLabels.includes('process_payment'))
    assert.ok(stepLabels.includes('send_confirmation'))
  })

  it('follows helper functions with DurableContext', () => {
    const graph = parser.parseFile(resolve(examplesDir, 'order_processor.py'))

    const invoke = graph.nodes.find((n) => n.kind === 'invoke')
    assert.ok(invoke, 'Should find invoke from fulfill_order helper')
    // The invoke label comes from function_name= or name= argument
    assert.ok(invoke.label.length > 0)
  })

  it('detects condition with create_callback', () => {
    const graph = parser.parseFile(resolve(examplesDir, 'order_processor.py'))

    const condition = graph.nodes.find((n) => n.kind === 'condition')
    assert.ok(condition)

    const callback = graph.nodes.find((n) => n.kind === 'createCallback')
    assert.ok(callback)
    assert.equal(callback.label, 'manager_approval')
  })

  it('includes source line numbers', () => {
    const graph = parser.parseFile(resolve(examplesDir, 'order_processor.py'))

    const nodesWithLines = graph.nodes.filter((n) => n.sourceLine != null)
    assert.ok(nodesWithLines.length >= 4, `Expected at least 4 nodes with source lines, got ${nodesWithLines.length}`)
  })

  it('generates valid edges', () => {
    const graph = parser.parseFile(resolve(examplesDir, 'order_processor.py'))

    assert.ok(graph.edges.length > 0)

    const startEdges = graph.edges.filter((e) => e.from === 'node_start')
    assert.equal(startEdges.length, 1)

    const endEdges = graph.edges.filter((e) => e.to === 'node_end')
    assert.ok(endEdges.length >= 1)
  })

  it('throws for non-durable files', () => {
    assert.throws(
      () => parser.parseFile(resolve(examplesDir, 'OrderProcessor.java')),
      /No @durable_execution/
    )
  })

  it('detects with_retry', () => {
    const graph = parser.parseFile(resolve(examplesDir, 'order_processor_with_retry.py'))

    const withRetry = graph.nodes.find((n) => n.kind === 'withRetry')
    assert.ok(withRetry, 'Should detect with_retry')
    assert.equal(withRetry.label, 'retry-fulfillment')
  })

  it('extracts step_semantics from StepConfig', () => {
    const graph = parser.parseFile(resolve(examplesDir, 'order_processor_with_retry.py'))

    const step = graph.nodes.find((n) => n.kind === 'step' && n.label === 'validate_order')
    assert.ok(step, 'Should find validate_order step')
    assert.equal(step.stepSemantics, 'AtMostOncePerRetry')
  })

  it('extracts nesting_type from parallel config', () => {
    const graph = parser.parseFile(resolve(examplesDir, 'order_processor_with_retry.py'))

    const parallel = graph.nodes.find((n) => n.kind === 'parallel')
    assert.ok(parallel, 'Should find parallel node')
    assert.equal(parallel.nestingType, 'FLAT')
  })

  it('extracts completion_config from parallel config', () => {
    const graph = parser.parseFile(resolve(examplesDir, 'order_processor_with_retry.py'))

    const parallel = graph.nodes.find((n) => n.kind === 'parallel')
    assert.ok(parallel, 'Should find parallel node')
    assert.equal(parallel.completionConfig, 'first successful')
  })

  it('extracts tenant_id from invoke config', () => {
    const graph = parser.parseFile(resolve(examplesDir, 'order_processor_with_retry.py'))

    const invoke = graph.nodes.find((n) => n.kind === 'invoke')
    assert.ok(invoke, 'Should find invoke node')
    assert.equal(invoke.tenantId, 'tenant-abc-123')
  })

  it('extracts nesting_type from map config', () => {
    const graph = parser.parseFile(resolve(examplesDir, 'order_processor_with_retry.py'))

    const map = graph.nodes.find((n) => n.kind === 'map')
    assert.ok(map, 'Should find map node')
    assert.equal(map.nestingType, 'FLAT')
    assert.equal(map.completionConfig, 'all completed')
  })

  it('extracts step name from function reference (no name=)', () => {
    const graph = parser.parseFile(resolve(fixturesDir, 'dynamic-names.py'))
    const labels = graph.nodes.map((n) => n.label)
    assert.ok(labels.includes('do_work'), 'Should extract function name do_work')
  })

  it('prefers explicit name= over function reference', () => {
    const graph = parser.parseFile(resolve(fixturesDir, 'dynamic-names.py'))
    const labels = graph.nodes.map((n) => n.label)
    assert.ok(labels.includes('explicit-name'), 'Should use explicit-name when name= is a string')
  })

  it('prefers function reference over unresolved variable name=', () => {
    const graph = parser.parseFile(resolve(fixturesDir, 'dynamic-names.py'))
    const labels = graph.nodes.map((n) => n.label)
    // context.step(do_work(...), name=comp_name) → function ref do_work beats unresolved variable comp_name
    assert.ok(labels.includes('do_work'), 'Function ref should take priority over variable name=')
  })

  it('extracts step names from multi-line calls', () => {
    const graph = parser.parseFile(resolve(fixturesDir, 'multiline-names.py'))
    const labels = graph.nodes.map((n) => n.label)
    assert.ok(labels.includes('validate_order'), 'Should extract name from multi-line call')
    assert.ok(labels.includes('process_payment'), 'Should extract name from multi-line call')
  })

  describe('loops', () => {
    const graph = parser.parseFile(resolve(fixturesDir, 'loops.py'))
    const loops = graph.nodes.filter((n) => n.kind === 'loop')

    it('should emit a loop node for for, while and async for loops', () => {
      assert.deepEqual(loops.map((n) => n.loopHeader), [
        'order in event["orders"]',
        'attempt in range(3)',
        'not is_done()',
        'item in stream(event)',
      ])
    })

    it('should not emit a loop node when the body has no durable calls', () => {
      assert.ok(!graph.nodes.some((n) => n.loopHeader?.includes('ignored')))
    })

    it('should include a nested condition, its branch and the step after it in the body count', () => {
      const orderLoop = loops[0]
      const index = graph.nodes.indexOf(orderLoop)
      const body = graph.nodes.slice(index + 1, index + 1 + (orderLoop.bodyCount ?? 0))

      assert.deepEqual(body.map((n) => n.label), ['validate', 'order["vip"]', 'vip-perk', 'charge'])
    })

    it('should detect range counts and ignore a trailing comment on the header', () => {
      assert.equal(loops[1].iterations, 3)
      assert.equal(loops[1].label, 'loop: attempt in range(3) x3')
      assert.equal(loops[0].iterations, undefined)
    })

    it('should report source lines, including after a blank line at the start of a block', () => {
      const lines = Object.fromEntries(graph.nodes.map((n) => [n.label, n.sourceLine]))

      assert.equal(loops[0].sourceLine, 7)
      assert.equal(lines['validate'], 8)
      assert.equal(lines['vip-perk'], 10)
      assert.equal(lines['charge'], 11)
      assert.equal(lines['poll'], 18)
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

  it('parses the body of each parallel branch function', () => {
    const graph = parser.parseFile(resolve(fixturesDir, 'nested-parallel.py'))
    const outer = graph.nodes.find((n) => n.label === 'fulfil-order')!
    const [inventory, charge] = outer.branches!

    assert.equal(inventory.name, 'prepare_inventory')
    assert.deepEqual(inventory.nodes.map((n) => [n.kind, n.label]), [['parallel', 'inventory-checks'], ['step', 'tail']])
    assert.deepEqual(inventory.nodes[0].branches!.map((b) => b.nodes.map((n) => n.label)), [['check-stock'], ['reserve-items']])
    assert.equal(charge.name, 'charge_customer')
    assert.deepEqual(charge.nodes.map((n) => n.kind), ['invoke', 'condition', 'step'])
    assert.equal(charge.nodes[0].sourceLine, 22)
    // Branch contents don't leak into the top level
    assert.deepEqual(graph.nodes.map((n) => n.kind), ['start', 'parallel', 'step', 'end'])

    const all = (nodes: WorkflowNode[]): WorkflowNode[] =>
      nodes.flatMap((n) => [n, ...all((n.branches ?? []).flatMap((b) => b.nodes))])
    const id = (label: string) => all(graph.nodes).find((n) => n.label === label)!.id
    const edge = (from: string, to: string) => graph.edges.some((e) => e.from === from && e.to === to)
    assert.ok(edge(id('check-stock'), id('tail')), 'inner branches join at tail')
    assert.ok(edge(id('reserve-items'), id('tail')), 'inner branches join at tail')
    assert.ok(edge(id('tail'), id('after')), 'outer branch joins at after')
    assert.ok(graph.edges.some((e) => e.from === id('VIP_ENABLED') && e.to === id('after') && e.label === 'no'),
      'skipped condition leaves the branch')
  })

  it('reads lambda and ParallelBranch branches from the SDK example', () => {
    const graph = parser.parseFile(resolve(examplesDir, 'order_processor_with_retry.py'))
    const parallel = graph.nodes.find((n) => n.kind === 'parallel')!
    assert.equal(parallel.label, 'prepare-order')
    assert.deepEqual(parallel.branches!.map((b) => [b.name, b.nodes.map((n) => n.label)]),
      [['reserve-inventory', ['reserve-inventory']], ['process-payment', ['process-payment']]])
    const map = graph.nodes.find((n) => n.kind === 'map')!
    assert.equal(map.branches!.length, 1)
    assert.equal(map.branches![0].dynamic, true)
    assert.equal(map.branches![0].nodes[0].sourceLine, 69)
  })

  it('resolves branch lists and callbacks held in variables', () => {
    const graph = parser.parseFile(resolve(fixturesDir, 'variable-branches.py'))
    // Nested defs and branch-list assignments are not handler steps
    assert.deepEqual(graph.nodes.map((n) => [n.kind, n.label]),
      [['start', 'Start'], ['step', 'start'], ['parallel', 'fulfil'], ['map', 'per-item'], ['parallel', 'audit'], ['end', 'End']])

    const branches = (label: string) => graph.nodes.find((n) => n.label === label)!.branches!
      .map((b) => [b.name, b.nodes.map((n) => [n.label, n.sourceLine])])
    assert.deepEqual(branches('fulfil'), [['reserve', [['reserve', 22]]], ['ship', [['ship', 15], ['ship-delay', 16]]]])
    assert.deepEqual(branches('per-item'), [['handle_item', [['handle-item', 28]]]])
    assert.deepEqual(branches('audit'), [['notify_warehouse', [['notify-warehouse', 6]]], ['branch', [['audit-log', 9]]]])
  })

  it('resolves built-up, scoped and generated branch lists', () => {
    const graph = parser.parseFile(resolve(fixturesDir, 'branch-sources.py'))
    assert.deepEqual(graph.nodes.map((n) => n.label),
      ['Start', 'built-up', 'per-region', 'lambda-comp', 'mapped', 'opaque', 'End'])

    const branches = (label: string) => graph.nodes.find((n) => n.label === label)!.branches!
      .map((b) => [b.name, b.dynamic, b.nodes.map((n) => [n.label, n.sourceLine])])
    // Assignment in this function, then append / extend / += in order; never another function's `branches`
    assert.deepEqual(branches('built-up'), [
      ['branch', false, [['first', 25]]],
      ['branch', false, [['second', 26]]],
      ['third', false, [['third', 17]]],
      ['fourth', false, [['fourth', 28]]],
    ])
    // Comprehensions and list(map(...)) → one dynamic branch from the element expression
    assert.deepEqual(branches('per-region'), [['each item', true, [['charge-region', 12]]]])
    assert.deepEqual(branches('lambda-comp'), [['each item', true, [['ship-region', 33]]]])
    assert.deepEqual(branches('mapped'), [['each item', true, [['charge-region', 12]]]])
    assert.deepEqual(branches('opaque'), [['each item', true, [['build_branch', undefined]]]])
  })

  it('finds handlers whose decorator takes arguments', () => {
    // Multi-line decorator arguments, and a triple-quoted string with lines at column 0
    const graph = parser.parseFile(resolve(fixturesDir, 'decorator-args.py'))
    assert.deepEqual(graph.nodes.map((n) => n.label), ['Start', 'fetch', 'summarise', 'End'])

    const dir = mkdtempSync(join(tmpdir(), 'py-parser-'))
    const file = join(dir, 'empty_args.py')
    writeFileSync(file, '@durable_execution()\nasync def handler(event, context: DurableContext):\n    context.wait(Duration.from_seconds(1), name="pause")\n')
    try {
      assert.deepEqual(parser.parseFile(file).nodes.map((n) => n.label), ['Start', 'pause', 'End'])
    } finally {
      rmSync(dir, { recursive: true })
    }
  })

  it('draws child context and with_retry callbacks as their own branch', () => {
    const graph = parser.parseFile(resolve(fixturesDir, 'child-context.py'))
    // Callback contents don't leak into the top level
    assert.deepEqual(graph.nodes.map((n) => [n.kind, n.label]), [
      ['start', 'Start'], ['runInChildContext', 'process-order'], ['runInChildContext', 'inline'],
      ['runInChildContext', 'plain'], ['withRetry', 'charge-payment'], ['step', 'done'], ['end', 'End'],
    ])
    const branches = (label: string) => graph.nodes.find((n) => n.label === label)!.branches
      ?.map((b) => [b.name, b.nodes.map((n) => [n.label, n.sourceLine])])
    assert.deepEqual(branches('process-order'), [['process-order', [['validate', 8], ['reserve', 9]]]])
    assert.deepEqual(branches('inline'), [['inline', [['inline-step', 24]]]])
    assert.equal(branches('plain'), undefined, 'nothing durable inside: no branches')
    assert.deepEqual(branches('charge-payment'), [['charge-payment', [['charge', 13], ['settle', 14]]]])

    const id = (label: string) => graph.nodes.flatMap((n) => [n, ...(n.branches ?? []).flatMap((b) => b.nodes)]).find((n) => n.label === label)!.id
    const edge = (from: string, to: string) => graph.edges.some((e) => e.from === from && e.to === to)
    assert.ok(edge(id('settle'), id('done')), 'with_retry branch joins the next step')
  })

  it('reads commented branch lists, positional ParallelBranch and map func= lambdas', () => {
    const graph = parser.parseFile(resolve(fixturesDir, 'branch-shapes.py'))
    const process = graph.nodes.find((n) => n.label === 'process')!
    assert.deepEqual(process.branches!.map((b) => [b.name, b.nodes.map((n) => [n.label, n.sourceLine])]), [
      ['task_a', [['run-a', 6]]],
      ['task-b', [['run-a', 6]]],
      ['task-c', [['run-c', 11]]],
      ['branch', [['same', 24]]],
      ['branch', [['same', 27]]],
    ])
    const map = graph.nodes.find((n) => n.label === 'items')!
    assert.deepEqual(map.branches!.map((b) => b.nodes.map((n) => n.label)), [['per-item']])
  })

  it('draws else and elif branches', () => {
    const graph = parser.parseFile(resolve(fixturesDir, 'if-else.py'))
    const id = (label: string) => graph.nodes.find((n) => n.label === label)!.id
    const edges = new Set(graph.edges.map((e) => `${e.from}>${e.to}${e.label ? ':' + e.label : ''}`))
    const has = (from: string, to: string, label?: string) =>
      assert.ok(edges.has(`${id(from)}>${id(to)}${label ? ':' + label : ''}`), `${from} -> ${to} ${label ?? ''}`)

    // if / else: both sides join at the next condition
    has('event["vip"]', 'fast-track', 'yes')
    has('event["vip"]', 'queue', 'no')
    has('fast-track', 'event["tier"] == "gold"')
    has('notify-wait', 'event["tier"] == "gold"')
    // elif chain: the last else returns, so it ends the workflow
    has('event["tier"] == "gold"', 'event["tier"] == "silver"', 'no')
    has('gold', '!(event["skip"])')
    has('silver', '!(event["skip"])')
    has('bronze', 'End')
    // only the else side is durable: the condition is negated
    has('!(event["skip"])', 'only-else', 'yes')
    // if / else inside a loop: the loop body counts both sides, and both sides loop back
    assert.equal(graph.nodes.find((n) => n.kind === 'loop')!.bodyCount, 3)
    has('order["paid"]', 'chase', 'no')
    assert.equal(graph.nodes.find((n) => n.label === 'chase')!.sourceLine, 29)
  })
})
