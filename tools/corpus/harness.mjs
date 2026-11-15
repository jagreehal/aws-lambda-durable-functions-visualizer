import { readFileSync, writeFileSync } from 'node:fs'
// Run from .tmp/real after clone.sh and find.sh: node ../../tools/corpus/harness.mjs [distDir] [lang]
// Parses every handler and records parse errors and nodes vs durable calls counted by regex.
const dist = process.argv[2] || new URL('../../packages/core/dist', import.meta.url).pathname
const only = process.argv[3]
const core = await import(dist.replace(/\/$/, '') + '/index.js')
const OPS = 'step|invoke|parallel|map|wait|waitForCallback|wait_for_callback|createCallback|create_callback|waitForCondition|wait_for_condition|runInChildContext|run_in_child_context|withRetry|with_retry'
const CALL = {
  ts: new RegExp(`\\b\\w+\\.(${OPS})\\s*(<[^>()]*>)?\\(`, 'g'),
  py: new RegExp(`\\b\\w+\\.(${OPS})\\s*\\(`, 'g'),
  java: new RegExp(`\\b\\w+\\.(${OPS})\\s*\\(`, 'g'),
  rs: new RegExp(`\\b\\w+\\.(${OPS})\\s*(::<[^>]*>)?\\(`, 'g'),
  cs: /\.(StepAsync|InvokeAsync|ParallelAsync|MapAsync|WaitAsync|WaitForCallbackAsync|CreateCallbackAsync|WaitForConditionAsync|RunInChildContextAsync)\s*(<[^>()]*>)?\(/g,
  go: /\bdurable\.(Step|Invoke|Parallel|Map|Wait|WaitForCallback|CreateCallback|WaitForCondition|RunInChildContext|Retry|Select|Go|All|Any|Race)\w*(\[[^\]]*\])?\(/g,
}
const SKIP = new Set(['start', 'end', 'condition', 'loop'])
const count = (nodes) => nodes.reduce((n, x) => n + (SKIP.has(x.kind) || x.sourceLine == null ? 0 : 1) + (x.branches ?? []).reduce((m, b) => m + count(b.nodes), 0), 0)
const rows = []
for (const lang of Object.keys(CALL).filter((l) => !only || l === only)) {
  for (const f of readFileSync(`${lang}.txt`, 'utf8').trim().split('\n').filter(Boolean)) {
    const src = readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '').replace(/^\s*#.*$/gm, '')
    const calls = (src.match(CALL[lang]) ?? []).length
    let nodes = 0, err = ''
    try { nodes = count(core.parseFile(f).nodes) } catch (e) { err = e.message.split('\n')[0].slice(0, 90) }
    rows.push({ lang, repo: f.split('/')[1], f, calls, nodes, err })
  }
}
writeFileSync(only ? `results-${only}.json` : 'results.json', JSON.stringify(rows, null, 1))
const by = (k) => Object.groupBy(rows, (r) => r[k])
for (const [lang, rs] of Object.entries(by('lang'))) {
  const parsed = rs.filter((r) => !r.err), withCalls = parsed.filter((r) => r.calls > 0)
  const exact = withCalls.filter((r) => r.nodes === r.calls).length, under = withCalls.filter((r) => r.nodes < r.calls).length, over = withCalls.filter((r) => r.nodes > r.calls).length
  console.log(`${lang.padEnd(5)} files ${String(rs.length).padStart(4)}  errors ${String(rs.length - parsed.length).padStart(4)}  with calls ${String(withCalls.length).padStart(4)}  exact ${exact}  under ${under}  over ${over}`)
}
