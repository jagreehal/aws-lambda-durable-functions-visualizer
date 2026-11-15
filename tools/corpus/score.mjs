// Run from .tmp/real: node ../../tools/corpus/score.mjs [lang]. A handler passes when it parses and no
// regex-counted durable call is missing; the regex is noisy, so read unexplained.txt before trusting a miss.
const only = process.argv[2]
const rows = JSON.parse((await import('node:fs')).readFileSync(only ? `results-${only}.json` : 'results.json', 'utf8'))
const internalPath = (f) => /(__tests__|\/tests?\/|\.test\.|_test\.(py|go)|\/test_|Tests?\/(?!.*TestFunctions)|\/src\/(?!main\/java\/software\/amazon\/lambda\/durable\/examples)|\/benches\/|\.github\/)/.test(f) && !/examples?\//.test(f) && !/conformance/i.test(f)
const internal = (f) => /^\.\/aws_aws-(durable-execution-sdk|lambda-dotnet)/.test(f) && internalPath(f)
const real = rows.filter((r) => !internal(r.f) && (r.calls > 0 || r.err))
// A file counts as handled when it parses and no durable call is missed
const ok = (r) => !r.err && r.nodes >= r.calls
const by = Object.groupBy(real, (r) => r.lang)
let tot = 0, good = 0
for (const [lang, rs] of Object.entries(by)) {
  const n = rs.filter(ok).length; tot += rs.length; good += n
  console.log(`${lang.padEnd(5)} ${String(n).padStart(4)} / ${String(rs.length).padEnd(4)} ${(100 * n / rs.length).toFixed(0)}%   errors ${rs.filter((r) => r.err).length}  missed-steps ${rs.filter((r) => !r.err && r.nodes < r.calls).length}`)
}
console.log(`all   ${good} / ${tot}  ${(100 * good / tot).toFixed(0)}%`)
const repos = Object.groupBy(real, (r) => r.repo)
console.log(Object.entries(repos).map(([k, v]) => `${k}: ${v.filter(ok).length}/${v.length}`).join('\n'))
import { readFileSync } from 'node:fs'
const bad = real.filter((r) => !ok(r))
const causes = {
  'C# WrapAsync<..> entry': (r, s) => r.lang === 'cs' && r.err && /WrapAsync\s*</.test(s),
  'Python @durable_execution(...) entry': (r, s) => r.lang === 'py' && r.err && /@durable_execution\(/.test(s),
  'TS withDurableExecution(fnName) entry': (r, s) => r.lang === 'ts' && r.err && /withDurableExecution\(\s*\w+\s*[,)]/.test(s),
  'child context contents dropped': (r, s) => !r.err && /run_?in_?child_?context|RunInChildContext|durable\.Go\(/i.test(s),
  'Java try-with-resources parallel': (r, s) => r.lang === 'java' && !r.err && /try\s*\(\s*var\s+\w+\s*=\s*\w+\.(parallel|map)/.test(s),
  'TS parallel/map without a name': (r, s) => r.lang === 'ts' && !r.err && /\.(parallel|map)\(\s*[\[\w]/.test(s) && !/\.(parallel|map)\(\s*['"`]/.test(s),
}
const left = new Set(bad)
for (const [name, test] of Object.entries(causes)) {
  const hit = bad.filter((r) => test(r, readFileSync(r.f, 'utf8')))
  hit.forEach((r) => left.delete(r))
  console.log(`${String(hit.length).padStart(4)}  ${name}  (${Object.entries(Object.groupBy(hit, (r) => r.lang)).map(([l, v]) => l + ' ' + v.length).join(', ')})`)
}
console.log(`${String(left.size).padStart(4)}  unexplained`)
import { writeFileSync } from 'node:fs'
writeFileSync(only ? `unexplained-${only}.txt` : 'unexplained.txt', [...left].map((r) => `${r.lang} ${r.calls}/${r.nodes} ${r.err ? 'ERR ' : ''}${r.f}`).join('\n'))
