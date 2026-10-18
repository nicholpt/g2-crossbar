#!/usr/bin/env node
// Save what an agent's pane shows right now, with what Crossbar makes of it,
// to turn a misread prompt into a test fixture.
//   npm run capture -- agents:1.0 agy-plan-menu
// Writes .run/captures/<name>.txt (the visible screen, as the bridge reads it)
// and prints a draft entry for test/fixtures/screens.json. Captures can hold
// private text: replace it before moving one into test/fixtures/screens/.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseDecision, paneState, lastLine } from '../crossbar.mjs';

const TMUX = process.env.CROSSBAR_TMUX || ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux'].find((p) => existsSync(p)) || 'tmux';

const [pane, name = `capture-${new Date().toISOString().replace(/[:.]/g, '-')}`] = process.argv.slice(2);
if (!pane) {
  console.error('usage: npm run capture -- <pane, e.g. agents:1.0> [name]\npanes:');
  console.error(execFileSync(TMUX, ['list-panes', '-a', '-F', '  #{session_name}:#{window_index}.#{pane_index}  #{window_name}']).toString());
  process.exit(2);
}
// the same capture the bridge's watcher uses: visible screen, wrapped lines joined
const raw = execFileSync(TMUX, ['capture-pane', '-p', '-J', '-t', pane]).toString().split('\n').slice(-40).join('\n');
const dir = join(import.meta.dirname, '..', '.run', 'captures');
mkdirSync(dir, { recursive: true });
const file = join(dir, `${name}.txt`);
writeFileSync(file, raw);
const d = parseDecision(raw);
const entry = { state: paneState(raw).state, decision: d && { question: d.question, options: d.options.map((o) => o.label), cursor: d.cursor }, lastLine: lastLine(raw) };
console.log(`saved ${file}\n\nCrossbar reads it as:\n${JSON.stringify({ [name]: entry }, null, 2)}\n`);
console.log('If that is wrong: fix the entry to what it should be, replace private text in both, then move the');
console.log('screen to test/fixtures/screens/ and add the entry to test/fixtures/screens.json. npm test will fail until the parser agrees.');
