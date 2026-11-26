/**
 * Compare two benchmark results (scripts/perf/README.md): `npm run perf:compare -- before.json after.json [--markdown]`.
 * Prints before, after, the change and its verdict for every metric of every case; `--markdown` prints the tables a
 * pull request carries instead. Exits 1 when a case could not be compared (it failed, or its fixture differs).
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { changeMarkdown, changeTables, compareResults, type RunResult } from './results';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { markdown: { type: 'boolean', default: false } } });
if (positionals.length !== 2) {
  console.error('Usage: npm run perf:compare -- <before.json> <after.json> [--markdown]');
  process.exit(2);
}
const [before, after] = positionals.map((p) => JSON.parse(readFileSync(p, 'utf8')) as RunResult);
for (const [label, r] of [['before', before], ['after', after]] as const) if (r.schemaVersion !== 1) throw new Error(`${label}: not a benchmark result this command reads (schemaVersion ${r.schemaVersion}).`);
const changes = compareResults(before, after);
const tree = (r: RunResult) => `${r.build.commit ?? r.build.head ?? '?'}${r.build.dirty ? ' (dirty checkout)' : ''}, ${r.config.iterations} iterations`;
if (values.markdown) console.log(changeMarkdown(changes, before, after));
else console.log(`before: ${tree(before)}\nafter:  ${tree(after)}\n\n${changeTables(changes)}`);
process.exitCode = changes.some((c) => c.status !== 'compared') ? 1 : 0;
