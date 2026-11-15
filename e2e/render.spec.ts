import { test, expect, type Page } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const cli = resolve(root, 'packages/cli/dist/bin.cjs')

/** Run `ldfviz <file> --open` without a browser and return the page it wrote. */
function openPage(file: string, ...args: string[]): string {
  const run = spawnSync(process.execPath, [cli, resolve(root, file), '--open', ...args], {
    env: { ...process.env, BROWSER: 'none' },
    encoding: 'utf8',
  })
  const page = /Opened: (.+\.html)/.exec(run.stderr)?.[1]
  if (run.status !== 0 || !page) throw new Error(`ldfviz failed for ${file}:\n${run.stderr}`)
  return pathToFileURL(page).href
}

/** Load a page and wait for Autovisualizer to draw the chart. */
async function chart(page: Page, file: string) {
  await page.goto(openPage(file))
  const element = page.locator('auto-visualizer')
  // Every workflow starts at Start, so its label means the chart is drawn
  await element.getByText('Start', { exact: true }).first().waitFor()
  return element
}

const EXAMPLES = [
  ['examples/order-workflow.ts', 'validate-order'],
  ['examples/order_processor.py', 'Start'],
  ['examples/OrderProcessor.java', 'Start'],
  ['examples/OrderWorkflow.cs', 'Start'],
  ['examples/order_workflow.rs', 'Start'],
  ['examples/order_workflow.go', 'Start'],
] as const

for (const [file, state] of EXAMPLES) {
  test(`Autovisualizer draws ${file}`, async ({ page }) => {
    const element = await chart(page, file)
    await expect(element.getByText(state, { exact: true }).first()).toBeVisible()
    // The embed shows loading errors (e.g. MachineJSON it rejects) in place of the chart
    await expect(element.getByText(/Unknown key|Error/)).toHaveCount(0)
  })
}

test('nested parallels, branch steps and their done states are drawn', async ({ page }) => {
  const element = await chart(page, 'packages/core/test-fixtures/nested-parallel.ts')
  for (const state of ['outer', 'inner', 'tail', 'first', 'after']) {
    await expect(element.getByText(state, { exact: true }).first()).toBeVisible()
  }
  await expect(element.getByText('done', { exact: true }).first()).toBeVisible()
})

test('if / else branches are drawn as a condition with yes and no', async ({ page }) => {
  const element = await chart(page, 'packages/core/test-fixtures/if-else.ts')
  // State names write `.` as the look-alike one-dot leader, since XState reads `.` as a path
  for (const label of ['event\u2024vip', 'fast-track', 'queue', 'yes', 'no']) {
    await expect(element.getByText(label, { exact: true }).first()).toBeVisible()
  }
})

test('--mermaid --open draws the flowchart', async ({ page }) => {
  await page.goto(openPage('examples/order-workflow.ts', '--mermaid'))
  await expect(page.locator('.mermaid svg')).toBeVisible()
  await expect(page.locator('.mermaid svg').getByText('validate-order')).toBeVisible()
})
