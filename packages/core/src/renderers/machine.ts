/**
 * Render a WorkflowGraph as XState MachineJSON for Autovisualizer.
 *
 * Emits static `target` transitions (no `@code` / `@expr`) so the no-worker
 * Autovisualizer path can load the result.
 */

import type { WorkflowBranch, WorkflowEdge, WorkflowGraph, WorkflowNode } from '../graph.js'
import { KIND_STYLES } from './kind-style.js'

/** Minimal MachineJSON state node (Autovisualizer / machineFromJSON compatible). */
export interface MachineStateJson {
  type?: 'atomic' | 'compound' | 'parallel' | 'final' | 'history' | 'choice'
  description?: string
  tags?: string[]
  initial?: string
  states?: Record<string, MachineStateJson>
  on?: Record<string, MachineTransitionJson | MachineTransitionJson[]>
  always?: MachineTransitionJson | MachineTransitionJson[]
  invoke?: MachineInvokeJson | MachineInvokeJson[]
}

export interface MachineTransitionJson {
  target?: string | string[]
  guard?: { type: string } | string
  actions?: unknown
  description?: string
}

export interface MachineInvokeJson {
  src: string
  id?: string
}

export interface MachineJson {
  id: string
  initial: string
  description?: string
  states: Record<string, MachineStateJson>
}

function sanitizeKey(raw: string, fallback: string): string {
  const cleaned = raw
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
  if (!cleaned) return fallback
  if (/^[0-9]/.test(cleaned)) return `s_${cleaned}`
  return cleaned
}

/**
 * A state key that reads as the node's own label. Keys can't hold `.` (XState's
 * path separator) or start with `#` (an id reference), so `.` becomes the
 * look-alike one-dot leader and a leading `#` is dropped.
 */
function stateKey(label: string, fallback: string): string {
  const key = label.trim().replace(/\./g, '\u2024').replace(/^#+/, '')
  return key || fallback
}

function uniqueKey(base: string, used: Set<string>): string {
  let key = base
  let n = 2
  while (used.has(key)) {
    key = `${base}_${n++}`
  }
  used.add(key)
  return key
}

function eventName(label?: string): string {
  if (!label || !label.trim()) return 'NEXT'
  const cleaned = label.trim().replace(/\s+/g, '_').replace(/[^A-Za-z0-9_.-]/g, '')
  return cleaned || 'NEXT'
}

function buildDescription(node: WorkflowNode): string | undefined {
  const parts: string[] = []
  if (node.nestingType === 'FLAT') parts.push('flat')
  if (node.completionConfig) parts.push(node.completionConfig)
  if (node.stepSemantics) parts.push(node.stepSemantics)
  if (node.tenantId) parts.push(`tenant ${node.tenantId}`)
  if (node.maxConcurrency != null) parts.push(`concurrency ${node.maxConcurrency}`)
  if (node.retryStrategy) parts.push(`retry ${node.retryStrategy}`)
  if (node.timeout) parts.push(`timeout ${node.timeout}`)
  if (node.target && node.kind === 'invoke') parts.push(`→ ${node.target}`)
  return parts.length > 0 ? parts.join(' · ') : undefined
}

/** Ids of every node inside `node`'s branches, at any depth. */
function descendantIds(node: WorkflowNode, into = new Set<string>()): Set<string> {
  for (const branch of node.branches ?? []) {
    for (const child of branch.nodes) {
      into.add(child.id)
      descendantIds(child, into)
    }
  }
  return into
}

function kindTags(node: WorkflowNode): string[] {
  const style = KIND_STYLES[node.kind]
  return style ? [node.kind, `shape:${style.shape}`, `color:${style.fill}`] : [node.kind]
}

function buildState(node: WorkflowNode, edges: WorkflowEdge[]): MachineStateJson {
  const state: MachineStateJson = {}
  if (node.branches?.length) {
    const used = new Set<string>()
    const regions = node.branches.map((branch) => buildBranchRegion(branch, edges, used))
    if (regions.length === 1 && !FAN_OUT.has(node.kind)) {
      // A child context or retry block runs its steps in order: a compound state, not a parallel one.
      Object.assign(state, regions[0].region)
    } else {
      state.type = 'parallel'
      state.states = Object.fromEntries(regions.map(({ key, region }) => [key, region]))
    }
  } else if (node.kind === 'end') {
    state.type = 'final'
  }
  const description = buildDescription(node)
  if (description) state.description = description
  // Always tag kinds so Autovisualizer can pick durable shapes (including start/end).
  state.tags = kindTags(node)
  if (node.kind === 'invoke' && node.target) {
    state.invoke = { src: node.target, id: node.id }
  }
  return state
}

/**
 * States for one level of the workflow (the top level or one branch), with
 * transitions from the graph's edges. Edges that leave the level go to
 * `exitKey`, or are dropped when there is none.
 */
function buildLevel(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  exitKey?: string,
): { states: Record<string, MachineStateJson>; keyOf: Map<string, string> } {
  const used = new Set(exitKey ? [exitKey] : [])
  const keyOf = new Map(nodes.map((n) => [n.id, uniqueKey(stateKey(n.label, n.kind), used)]))
  const states: Record<string, MachineStateJson> = {}
  const inner = new Map<string, Set<string>>()
  for (const node of nodes) {
    states[keyOf.get(node.id)!] = buildState(node, edges)
    if (node.branches?.length) inner.set(node.id, descendantIds(node))
  }
  const targetOf = (to: string) => keyOf.get(to) ?? exitKey

  for (const edge of edges) {
    const from = keyOf.get(edge.from)
    // Fan-out into branch nodes is drawn by the parallel regions.
    if (!from || inner.get(edge.from)?.has(edge.to)) continue
    const target = targetOf(edge.to)
    if (target) addTransition(states[from], edge, target)
  }

  // Fan-in: a parallel state is done when its branches are, then moves on.
  for (const [id, below] of inner) {
    const exit = edges.find((e) => below.has(e.from) && !below.has(e.to))
    const target = exit && targetOf(exit.to)
    // MachineJSON has no `onDone` key (machineFromJSON rejects it); this is the event it stands for.
    if (target) (states[keyOf.get(id)!].on ??= {})[DONE_EVENT] = { target }
  }
  return { states, keyOf }
}

function addTransition(state: MachineStateJson, edge: WorkflowEdge, target: string): void {
  const event = eventName(edge.label)
  const transition: MachineTransitionJson = { target }
  if (edge.style === 'back') transition.description = 'loop'
  state.on ??= {}
  const existing = state.on[event]
  if (!existing) state.on[event] = transition
  else if (Array.isArray(existing)) existing.push(transition)
  else state.on[event] = [existing, transition]
}

const DONE = 'done'
const FAN_OUT = new Set(['parallel', 'map', 'promiseAll', 'promiseAny', 'promiseRace', 'promiseAllSettled'])
const DONE_EVENT = 'xstate.done.state'

function buildBranchRegion(
  branch: WorkflowBranch,
  edges: WorkflowEdge[],
  usedKeys: Set<string>,
): { key: string; region: MachineStateJson } {
  // An unnamed one-step branch is called after its step.
  const name = branch.name === 'branch' && branch.nodes.length === 1 ? branch.nodes[0].label : branch.name
  const key = uniqueKey(stateKey(name, 'branch'), usedKeys)
  const tags = branch.dynamic ? ['dynamic'] : undefined
  if (branch.nodes.length === 0) {
    return { key, region: { type: 'final', description: branch.name, tags } }
  }

  // Each step runs, then leaves for `done`; a final step would finish the branch the moment it started.
  const { states, keyOf } = buildLevel(branch.nodes, edges, DONE)
  states[DONE] = { type: 'final' }
  return { key, region: { initial: keyOf.get(branch.nodes[0].id)!, tags, states } }
}

/**
 * Convert a durable workflow graph into MachineJSON.
 */
export function renderMachineJson(graph: WorkflowGraph): MachineJson {
  const nested = new Set<string>()
  for (const node of graph.nodes) descendantIds(node, nested)
  const topLevel = graph.nodes.filter((n) => !nested.has(n.id))

  const { states, keyOf } = buildLevel(topLevel, graph.edges)
  const start = topLevel.find((n) => n.kind === 'start') ?? topLevel[0]
  if (!start) {
    throw new Error('Cannot render MachineJSON: workflow has no states')
  }

  return {
    id: sanitizeKey(graph.name, 'workflow'),
    initial: keyOf.get(start.id)!,
    states,
  }
}

/** Pretty-print MachineJSON for CLI / file output. */
export function renderMachineJsonString(graph: WorkflowGraph, space = 2): string {
  return JSON.stringify(renderMachineJson(graph), null, space)
}
