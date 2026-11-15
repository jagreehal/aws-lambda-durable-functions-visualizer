/**
 * How each node kind is drawn, shared by the Mermaid and MachineJSON renderers.
 * `shape` uses Mermaid's flowchart shape names, which Autovisualizer reads from
 * `shape:<name>` tags.
 */

import type { NodeKind } from '../graph.js'

export type KindShape =
  | 'stadium'
  | 'rect'
  | 'trapezoid'
  | 'hexagon'
  | 'circle'
  | 'subroutine'
  | 'diamond'
  | 'rounded'

export interface KindStyle {
  shape: KindShape
  fill: string
  stroke: string
  color: string
}

const terminal: KindStyle = { shape: 'stadium', fill: '#5b8ab4', stroke: '#4a7293', color: '#e8edf2' }
const fanOut: KindStyle = { shape: 'hexagon', fill: '#7b6b9e', stroke: '#655883', color: '#e8e3f0' }
const waiting: KindStyle = { shape: 'circle', fill: '#b05a5a', stroke: '#8f4a4a', color: '#f2e0e0' }
const child: KindStyle = { shape: 'subroutine', fill: '#4a849e', stroke: '#3d6d83', color: '#deedf3' }

export const KIND_STYLES: Record<NodeKind, KindStyle> = {
  start: terminal,
  end: terminal,
  step: { shape: 'rect', fill: '#4a8c72', stroke: '#3d7360', color: '#e0efe8' },
  invoke: { shape: 'trapezoid', fill: '#b8873a', stroke: '#967032', color: '#f5edd8' },
  parallel: fanOut,
  map: fanOut,
  promiseAll: fanOut,
  promiseAny: fanOut,
  promiseRace: fanOut,
  promiseAllSettled: fanOut,
  wait: waiting,
  waitForCallback: waiting,
  createCallback: waiting,
  waitForCondition: waiting,
  runInChildContext: child,
  withRetry: child,
  condition: { shape: 'diamond', fill: '#6b71a8', stroke: '#575c8a', color: '#e3e4f0' },
  loop: { shape: 'rounded', fill: '#7d8a3e', stroke: '#657131', color: '#eef0dc' },
}
