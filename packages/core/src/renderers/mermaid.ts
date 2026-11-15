/**
 * Render a WorkflowGraph as a Mermaid flowchart.
 */

import type { WorkflowGraph, WorkflowNode, WorkflowEdge } from '../graph.js'
import { KIND_STYLES, type KindShape } from './kind-style.js'

export interface MermaidOptions {
  direction?: 'TD' | 'LR'
}

/** Escape text for use inside Mermaid node labels. */
function esc(text: string): string {
  return text.replace(/"/g, "'").replace(/[[\]{}()<>|]/g, ' ')
}

/**
 * Escape text for a quoted Mermaid label. Inside quotes, parentheses, brackets,
 * braces and pipes are safe, so code like `items.iter()` keeps them. Characters
 * that Mermaid would read as markup or an entity are written as entity codes.
 */
function escQuoted(text: string): string {
  return text
    .replace(/#/g, '#35;')
    .replace(/"/g, '#quot;')
    .replace(/</g, '#lt;')
    .replace(/>/g, '#gt;')
}

/** Break long labels at spaces so node width does not depend on the renderer's own wrapping. */
function wrapLabel(text: string, maxLineLength = 24): string {
  const lines: string[] = []
  let current = ''
  for (const word of text.split(' ')) {
    if (current && (current + ' ' + word).length > maxLineLength) {
      lines.push(current)
      current = word
    } else {
      current = current ? `${current} ${word}` : word
    }
  }
  if (current) lines.push(current)
  return lines.join('<br>')
}

function buildAnnotation(node: WorkflowNode): string {
  const parts: string[] = []
  if (node.nestingType === 'FLAT') parts.push('flat')
  if (node.completionConfig) parts.push(node.completionConfig)
  if (node.stepSemantics) parts.push(node.stepSemantics)
  if (node.tenantId) parts.push(`tenant ${node.tenantId}`)
  if (node.maxConcurrency != null) parts.push(`concurrency ${node.maxConcurrency}`)
  if (parts.length === 0) return ''
  return '<br>' + parts.join('<br>')
}

function shapeForKind(node: WorkflowNode): string {
  const quoted = node.kind === 'loop' || node.kind === 'condition'
  const text = node.kind === 'loop'
    ? wrapLabel(escQuoted(node.label))
    : node.kind === 'condition'
      ? escQuoted(node.label)
      : esc(node.label)
  const label = (quoted ? `"${text}${buildAnnotation(node)}"` : text + buildAnnotation(node))
  const [open, close] = MERMAID_SHAPES[KIND_STYLES[node.kind]?.shape ?? 'rect']
  return `${open}${label}${close}`
}

const MERMAID_SHAPES: Record<KindShape, [string, string]> = {
  stadium: ['([', '])'],
  rect: ['[', ']'],
  trapezoid: ['[/', '\\]'],
  hexagon: ['{{', '}}'],
  circle: ['((', '))'],
  subroutine: ['[[', ']]'],
  diamond: ['{', '}'],
  rounded: ['(', ')'],
}

/** Escape text for use in edge labels — no parens, brackets, or pipes. */
function escEdge(text: string): string {
  return text.replace(/[[\]{}()<>|]/g, ' ').replace(/\s+/g, ' ').trim()
}

function renderEdge(edge: WorkflowEdge): string {
  // Back-edges to a loop header are dashed so they read as "repeat"
  const arrow = edge.style === 'back' ? '-.->' : '-->'
  if (edge.label) {
    const label = `&nbsp;&nbsp;${escEdge(edge.label)}&nbsp;&nbsp;`
    return `  ${edge.from} ${arrow}|${label}| ${edge.to}`
  }
  return `  ${edge.from} ${arrow} ${edge.to}`
}

function styleForKind(node: WorkflowNode): string | undefined {
  const style = KIND_STYLES[node.kind]
  return style && `style ${node.id} fill:${style.fill},stroke:${style.stroke},color:${style.color}`
}

export function renderMermaid(graph: WorkflowGraph, options?: MermaidOptions): string {
  const direction = options?.direction ?? 'TD'
  const lines: string[] = [`graph ${direction}`]

  // Collect all nodes for styling and click callbacks
  const allNodes: WorkflowNode[] = []

  const subgraphStyle = (subId: string) =>
    `  style ${subId} fill:transparent,stroke:#444,stroke-width:1px,stroke-dasharray:5 5,rx:8,ry:8`

  // Emit node definitions, using subgraphs for parallel/map branches and loop
  // bodies. Branches are node lists of their own, so they recurse.
  const emitNodes = (nodes: WorkflowNode[], indent: string) => {
    // Loop bodies are the flat nodes that follow a loop node. Track where each
    // open loop subgraph ends so nested loops close in the right order.
    const openLoops: { subId: string; endIndex: number }[] = []
    nodes.forEach((node, index) => {
      allNodes.push(node)
      lines.push(`${indent}${node.id}${shapeForKind(node)}`)
      const subId = `sub_${node.id}`

      if (node.branches?.length) {
        // The hub sits outside the subgraph that holds its branches
        lines.push(`${indent}subgraph ${subId}[" "]`)
        for (const branch of node.branches) emitNodes(branch.nodes, indent + '  ')
        lines.push(`${indent}end`)
        lines.push(subgraphStyle(subId))
      } else if (node.kind === 'loop') {
        // The loop header sits outside the subgraph, like a parallel hub
        const bodyEnd = Math.min(index + Math.max(node.bodyCount ?? 1, 1), nodes.length - 1)
        lines.push(`${indent}subgraph ${subId}[" "]`)
        openLoops.push({ subId, endIndex: bodyEnd })
      }

      // Close every loop subgraph whose body ends at this node
      while (openLoops.length > 0 && openLoops[openLoops.length - 1].endIndex <= index) {
        const closed = openLoops.pop()!
        lines.push(`${indent}end`)
        lines.push(subgraphStyle(closed.subId))
      }
    })
  }
  emitNodes(graph.nodes, '  ')

  lines.push('')

  // Edges
  for (const edge of graph.edges) {
    lines.push(renderEdge(edge))
  }

  lines.push('')

  // Styles
  for (const node of allNodes) {
    const style = styleForKind(node)
    if (style) lines.push(`  ${style}`)
  }

  // Click callbacks for nodes with source lines
  for (const node of allNodes) {
    if (node.sourceLine != null) {
      lines.push(`  click ${node.id} call onNodeClick(${node.sourceLine})`)
    }
  }

  return lines.join('\n')
}
