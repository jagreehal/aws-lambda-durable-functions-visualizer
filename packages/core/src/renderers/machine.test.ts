import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { parseFile } from '../parser.js'
import { renderMachineJson, renderMachineJsonString } from './machine.js'
import { buildEdges, type WorkflowGraph, type WorkflowNode } from '../graph.js'

const examplesDir = resolve(import.meta.dirname, '../../../..', 'examples')

describe('renderMachineJson', () => {
  it('emits Autovisualizer-ready MachineJSON for order-workflow.ts', () => {
    const graph = parseFile(resolve(examplesDir, 'order-workflow.ts'))
    const machine = renderMachineJson(graph)

    assert.equal(machine.id, 'order-workflow')
    assert.equal(machine.initial, 'Start')
    assert.equal(machine.states.End.type, 'final')

    assert.deepEqual(machine.states.Start.on?.NEXT, { target: 'validate-order' })
    assert.deepEqual(machine.states['validate-order'].on?.NEXT, { target: 'prepare-order' })

    const parallel = machine.states['prepare-order']
    assert.equal(parallel.type, 'parallel')
    assert.ok(parallel.tags?.includes('parallel'))
    assert.ok(parallel.states?.['check-inventory'])
    assert.ok(parallel.states?.['reserve-payment'])
    // A branch's step runs before the branch is done, so it is not itself final
    const region = parallel.states!['check-inventory']
    const inventory = region.states!['check-inventory']
    assert.deepEqual(inventory.on?.NEXT, { target: 'done' })
    assert.equal(region.states!.done.type, 'final')
    assert.ok(inventory.invoke)
    const invoke = Array.isArray(inventory.invoke) ? inventory.invoke[0] : inventory.invoke
    assert.equal(invoke.src, 'InventoryFunction')
    assert.deepEqual(parallel.on?.['xstate.done.state'], { target: 'review-results' })

    // `.` can't appear in a state key, so it is drawn with the look-alike one-dot leader
    const condition = machine.states['event․total > 5000']
    assert.deepEqual(condition.on?.yes, { target: 'manager-approval' })
    assert.deepEqual(condition.on?.no, { target: 'fulfill-order' })
    assert.ok(machine.states['validate-order'].tags?.includes('step'))
    assert.equal(machine.states['manager-approval'].description, 'timeout hours: 24')
  })

  it('pretty-prints JSON with states for CLI output', () => {
    const graph = parseFile(resolve(examplesDir, 'order-workflow.ts'))
    const text = renderMachineJsonString(graph)
    const parsed = JSON.parse(text)

    assert.ok(parsed.states)
    assert.equal(parsed.id, 'order-workflow')
    assert.ok(text.includes('\n'))
  })

  it('does not nest branch nodes at the root', () => {
    const graph = parseFile(resolve(examplesDir, 'order-workflow.ts'))
    const machine = renderMachineJson(graph)

    assert.equal(machine.states['check-inventory'], undefined)
    assert.equal(machine.states['reserve-payment'], undefined)
  })

  it('maps loop next/done edges to events', () => {
    const graph = parseFile(resolve(examplesDir, 'order-batch-loop.ts'))
    const machine = renderMachineJson(graph)

    const orders = 'loop: const order of event․orders'
    assert.deepEqual(machine.states[orders].on?.NEXT, { target: 'validate-order' })
    assert.deepEqual(machine.states[orders].on?.done, { target: 'loop: let attempt = 0; attempt < 3; attempt++ x3' })
    assert.deepEqual(machine.states['charge-order'].on?.next, {
      target: orders,
      description: 'loop',
    })
  })

  it('includes config annotations in descriptions', () => {
    const graph = parseFile(resolve(examplesDir, 'order-workflow-config.ts'))
    const machine = renderMachineJson(graph)
    const text = JSON.stringify(machine)

    assert.ok(text.includes('flat') || text.includes('FLAT') || /flat/i.test(text))
    assert.ok(/tenant/i.test(text))
  })

  it('renders a hand-built sequential graph', () => {
    const nodes: WorkflowNode[] = [
      { id: 'node_start', kind: 'start', label: 'Start' },
      { id: 'step_1', kind: 'step', label: 'one' },
      { id: 'step_2', kind: 'step', label: 'two' },
      { id: 'node_end', kind: 'end', label: 'End' },
    ]
    const graph: WorkflowGraph = {
      name: 'tiny',
      nodes,
      edges: buildEdges(nodes),
    }
    const machine = renderMachineJson(graph)

    assert.equal(machine.id, 'tiny')
    assert.equal(machine.initial, 'Start')
    assert.deepEqual(machine.states.one.on?.NEXT, { target: 'two' })
    assert.deepEqual(machine.states.two.on?.NEXT, { target: 'End' })
  })

  it('tags states with Autovisualizer shapes and colours', () => {
    const machine = renderMachineJson(parseFile(resolve(examplesDir, 'order-workflow.ts')))

    assert.deepEqual(machine.states['event․total > 5000'].tags, ['condition', 'shape:diamond', 'color:#6b71a8'])
    assert.ok(machine.states.Start.tags?.includes('shape:stadium'))
    assert.ok(machine.states['prepare-order'].tags?.includes('shape:hexagon'))
  })

  it('nests parallels and keeps branch transitions', () => {
    const fixture = resolve(import.meta.dirname, '../../../..', 'packages/core/test-fixtures/nested-parallel.ts')
    const machine = renderMachineJson(parseFile(fixture))
    const outer = machine.states.outer

    assert.deepEqual(outer.on?.['xstate.done.state'], { target: 'after' })
    const first = outer.states!.branch
    assert.equal(first.states!.inner.type, 'parallel')
    assert.deepEqual(Object.keys(first.states!.inner.states!), ['a', 'b'])
    assert.equal(first.states!.inner.states!.a.states!.done.type, 'final')
    assert.deepEqual(first.states!.inner.on?.['xstate.done.state'], { target: 'tail' })
    assert.deepEqual(first.states!.tail.on?.NEXT, { target: 'done' })

    // A condition that skips the rest of the branch also goes to `done`
    const gated = outer.states!.gated
    assert.deepEqual(gated.states!['event․vip'].on, { yes: { target: 'vip' }, no: { target: 'done' } })
    assert.equal(gated.states!.done.type, 'final')
    assert.deepEqual(gated.states!.vip.on?.NEXT, { target: 'done' })
  })

  it('draws a child context with contents as a compound state', () => {
    const nodes: WorkflowNode[] = [
      { id: 'node_start', kind: 'start', label: 'Start' },
      {
        id: 'child_1', kind: 'runInChildContext', label: 'process-order',
        branches: [{ name: 'process-order', dynamic: false, nodes: [
          { id: 'step_2', kind: 'step', label: 'validate' },
          { id: 'step_3', kind: 'step', label: 'charge' },
        ] }],
      },
      { id: 'step_4', kind: 'step', label: 'notify' },
      { id: 'node_end', kind: 'end', label: 'End' },
    ]
    const machine = renderMachineJson({ name: 'child', nodes, edges: buildEdges(nodes) })
    const child = machine.states['process-order']

    assert.equal(child.type, undefined)
    assert.equal(child.initial, 'validate')
    assert.deepEqual(child.states!.validate.on?.NEXT, { target: 'charge' })
    assert.deepEqual(child.states!.charge.on?.NEXT, { target: 'done' })
    assert.deepEqual(child.on?.['xstate.done.state'], { target: 'notify' })
    assert.ok(child.tags?.includes('shape:subroutine'))
  })
})
