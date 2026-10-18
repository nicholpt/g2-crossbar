// The model and effort shown next to each agent in the Agents list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentModel, claudeModel, withoutModelLine } from '../crossbar.mjs';

const screen = (name) => readFileSync(join(import.meta.dirname, 'fixtures', 'screens', `${name}.txt`), 'utf8');

test('codex, agy and kimi: from their footers', () => {
  assert.equal(agentModel('codex', screen('codex-working')), 'GPT-6.1-Sol ultra');
  assert.equal(agentModel('codex', screen('codex-idle-tool-tail')), 'GPT-6.1 high');
  assert.equal(agentModel('agy', screen('agy-working')), 'Gemini 4 Argon high');
  assert.equal(agentModel('kimi', ' K3 thinking: high  ~/projects/demo        /tasks to check progress'), 'K3 high');
  assert.equal(agentModel('codex', screen('claude-idle-answer')), ''); // nothing that looks like a footer
});

test("claude: the newest session's latest model, and the effort setting", () => {
  const home = mkdtempSync(join(tmpdir(), 'crossbar-home-'));
  const dir = join(home, '.claude', 'projects', '-Users-me-projects-demo');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ effortLevel: 'xhigh' }));
  writeFileSync(join(dir, 'old.jsonl'), '{"message":{"model":"claude-haiku-5-5"}}\n');
  utimesSync(join(dir, 'old.jsonl'), new Date(2020, 0, 1), new Date(2020, 0, 1));
  writeFileSync(join(dir, 'new.jsonl'), '{"message":{"model":"claude-sonnet-5-5"}}\n{"message":{"model":"claude-opus-5-5"}}\n{"message":{"model":"<synthetic>"}}\n');
  assert.equal(claudeModel('/Users/me/projects/demo', home), 'Opus 5.5 xhigh');
  writeFileSync(join(dir, 'new.jsonl'), '{"message":{"model":"claude-proxy/codex/gpt-6.1-sol"}}\n');
  assert.equal(claudeModel('/Users/me/projects/demo', home), 'gpt-6.1-sol xhigh');
  assert.equal(claudeModel('/nowhere', home), '');
});

test("the pane view drops the footer line that names the model (it's in the header)", () => {
  for (const [agent, name, footer] of [['codex', 'codex-working', 'GPT-6.1-Sol ultra · ~/projects/demo'], ['agy', 'agy-working', 'plan · Gemini 4 Argon · high']]) {
    const before = screen(name).split('\n');
    const after = withoutModelLine(agent, screen(name)).split('\n');
    assert.equal(after.length, before.length - 1, `${name}: one line removed`);
    assert.ok(before.some((l) => l.includes(footer)) && !after.some((l) => l.includes(footer)), `${name}: it's the model line`);
  }
  const claude = screen('claude-idle-answer');
  assert.equal(withoutModelLine('claude', claude), claude); // Claude's footer has no model
});
