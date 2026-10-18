// Prompt detection and "what the agent said" against real-layout screens from
// each harness (claude, codex, gemini, agy, kimi). Each fixture is a captured screen
// with private content replaced; screens.json holds the reviewed expectations.
// To add a case: save the screen to fixtures/screens/<harness>-<case>.txt,
// add its entry to screens.json by hand, and run npm test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseDecision, paneState, lastLine } from '../crossbar.mjs';

const DIR = join(import.meta.dirname, 'fixtures', 'screens');
const expected = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'screens.json'), 'utf8'));
const screens = readdirSync(DIR).filter((f) => f.endsWith('.txt')).map((f) => f.slice(0, -4)).sort();

test('every screen has an expectation and vice versa', () => {
  assert.deepEqual(screens, Object.keys(expected).sort());
});

for (const name of screens) {
  const raw = readFileSync(join(DIR, `${name}.txt`), 'utf8');
  const want = expected[name];
  test(name, () => {
    const d = parseDecision(raw);
    assert.deepEqual(d && { question: d.question, options: d.options.map((o) => o.label), cursor: d.cursor }, want.decision, 'decision');
    assert.equal(paneState(raw).state, want.state, 'state');
    if ('key' in want) assert.equal(paneState(raw).key, want.key, 'key');
    // what the agent said; not checked under a menu, where it isn't shown
    if ('lastLine' in want) assert.equal(lastLine(raw), want.lastLine, 'lastLine');
  });
}

test('a decision is the same however far the cursor has moved', () => {
  const at = (n) => parseDecision(readFileSync(join(DIR, `agy-wrapped-menu-cursor${n}.txt`), 'utf8'));
  assert.equal(at(0).sig, at(2).sig); // answering checks sig, so it must not depend on the cursor
});

test("Claude's status line isn't what it said, whatever the verb", () => {
  for (const verb of ['Brewed', 'Sautéed', 'Crème-brûléed']) {
    assert.equal(lastLine(`✻ ${verb} for 11s · done 7:35 AM\n${'─'.repeat(40)}\n❯ \n${'─'.repeat(40)}\n`), '', verb);
  }
});
