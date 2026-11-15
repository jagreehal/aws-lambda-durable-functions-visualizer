// Regenerates the README images: `pnpm build && pnpm screenshots`.
//   .github/demo.svg            animated walkthrough of examples/order-workflow.ts (Autovisualizer's toAnimatedSvg)
//   .github/screenshots/*.png   the pages `ldfviz --open` writes, for the README sections
import { chromium } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseFile, renderMachineJsonString } from '@ldfviz/core'

const root = resolve(import.meta.dirname, '..')
const out = resolve(root, '.github')
const shots = resolve(out, 'screenshots')
mkdirSync(shots, { recursive: true })

const EMBED = 'https://cdn.jsdelivr.net/npm/autovisualizer@0.9.0/public/embed/embed.js'

/** Run `ldfviz <file> --open` without a browser and return the page it wrote. */
function openPage(file, ...args) {
  const run = spawnSync(process.execPath, [resolve(root, 'packages/cli/dist/bin.cjs'), resolve(root, file), '--open', ...args], {
    env: { ...process.env, BROWSER: 'none' },
    encoding: 'utf8',
  })
  const page = /Opened: (.+\.html)/.exec(run.stderr)?.[1]
  if (run.status !== 0 || !page) throw new Error(`ldfviz failed for ${file}:\n${run.stderr}`)
  return pathToFileURL(page).href
}

const WALKTHROUGH = [
  { event: 'NEXT', note: 'validate the order' },
  { event: 'NEXT', note: 'check stock and reserve payment in parallel' },
  { event: 'NEXT', note: 'both branches done: review' },
  { event: 'NEXT', note: 'is the total over 5000?' },
  { event: 'yes', note: 'wait for a manager to approve' },
  { event: 'NEXT', note: 'fulfil the order' },
  { event: 'NEXT', note: 'done' },
]

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 })

// Animated hero: the order workflow stepped through with Autovisualizer
const machine = renderMachineJsonString(parseFile(resolve(root, 'examples/order-workflow.ts')))
await page.setContent(`<!DOCTYPE html><html><head><script type="module" src="${EMBED}"></script></head><body>
  <script type="application/json" id="workflow">${machine.replace(/</g, '\\u003c')}</script>
  <auto-visualizer id="order" definition="#workflow" theme="dark" direction="right" walkthrough='${JSON.stringify(WALKTHROUGH)}' style="height:700px"></auto-visualizer>
</body></html>`)
const chart = page.locator('auto-visualizer#order')
await chart.getByText('Start', { exact: true }).first().waitFor()
const svg = await chart.evaluate((element) => element.toAnimatedSvg({ title: 'order-workflow.ts', stepMs: 1600 }))
writeFileSync(resolve(out, 'demo.svg'), svg)

// Static screenshots of the pages the CLI opens
const SHOTS = [
  ['nested-parallel.png', 'packages/core/test-fixtures/nested-parallel.ts'],
  ['if-else.png', 'packages/core/test-fixtures/if-else.ts'],
  ['child-context.png', 'examples/order-workflow-config.ts'],
  ['mermaid.png', 'examples/order-workflow.ts', '--mermaid'],
]
for (const [name, file, ...args] of SHOTS) {
  await page.goto(openPage(file, ...args))
  if (args.includes('--mermaid')) await page.locator('.mermaid svg').waitFor()
  else await page.locator('auto-visualizer').getByText('Start', { exact: true }).first().waitFor()
  await page.waitForTimeout(1500) // let the layout settle and fit
  await page.screenshot({ path: resolve(shots, name) })
}

await browser.close()
console.log('Wrote .github/demo.svg and .github/screenshots/')
