// The real bridge against a fake agent in a private tmux server: the alert
// arrives, answering moves the agent's own cursor and presses Enter, a stale
// prompt is refused, and keys only go to the pane a client is viewing.
// Needs tmux and a built web app (npm test builds it first).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { join } from 'node:path';
import WebSocket from 'ws';

const ROOT = join(import.meta.dirname, '..');
const TMUX = join(import.meta.dirname, 'bin', 'tmux-test');
const tmp = mkdtempSync(join(tmpdir(), 'crossbar-test-'));
const LOG = join(tmp, 'agent.log');
const PORT = 18000 + Math.floor(Math.random() * 2000);
let server;

const hasTmux = (() => { try { execFileSync('tmux', ['-V']); return true; } catch { return false; } })();
const skip = !hasTmux ? 'tmux is not installed' : !existsSync(join(ROOT, 'dist', 'crossbar.html')) ? 'run npm run build first' : false;

before(async () => {
  if (skip) return;
  writeFileSync(join(tmp, 'crossbar.json'), JSON.stringify({ agents: ['fakeagent'], feed: { urls: [] } }));
  try { execFileSync(TMUX, ['kill-server'], { stdio: 'ignore' }); } catch {} // a leftover from a crashed run
  execFileSync(TMUX, ['new-session', '-d', '-s', 'agents', '-x', '120', '-y', '30', '-e', `FAKEAGENT_LOG=${LOG}`,
    join(import.meta.dirname, 'bin', 'fakeagent')]);
  server = spawn(process.execPath, [join(ROOT, 'crossbar-server.mjs')], {
    env: { ...process.env, CROSSBAR_MODE: 'home', CROSSBAR_KEY: 'test-pairing-code', BIND: '127.0.0.1', CROSSBAR_PORT: String(PORT),
      CROSSBAR_TMUX: TMUX, CROSSBAR_CONFIG: join(tmp, 'crossbar.json'), WHISPER_MODEL: join(tmp, 'no-model.bin') }, // Whisper never starts: no speech is sent
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`bridge didn't start:\n${out}`)), 10_000);
    const on = (d) => { out += d; if (out.includes('listening')) { clearTimeout(t); resolve(); } };
    server.stdout.on('data', on);
    server.stderr.on('data', on);
  });
});

after(() => {
  server?.kill();
  try { execFileSync(TMUX, ['kill-server'], { stdio: 'ignore' }); } catch {}
});

/** A client that collects messages and can wait for one. */
function client() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const seen = [];
  const waiters = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    seen.push(m);
    for (const w of [...waiters]) if (w.wants(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
  });
  const next = (match, ms = 12_000) => new Promise((resolve, reject) => {
    const hit = seen.find(match);
    if (hit) { seen.splice(seen.indexOf(hit), 1); return resolve(hit); }
    const t = setTimeout(() => reject(new Error(`timed out; got: ${seen.map((m) => m.type).join(', ')}`)), ms);
    waiters.push({ wants: match, resolve: (m) => { clearTimeout(t); resolve(m); } });
  });
  const send = (m) => ws.send(JSON.stringify(m));
  return { ws, next, send, open: new Promise((r) => ws.on('open', r)) };
}
const agentLog = () => (existsSync(LOG) ? readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

test('a prompt becomes an alert, and answering it picks that option', { skip, timeout: 40_000 }, async () => {
  const c = client();
  await c.open;
  c.send({ type: 'crossbar' });
  const alerts = await c.next((m) => m.type === 'alerts' && m.fresh.some((a) => a.kind === 'approval'));
  const alert = alerts.fresh.find((a) => a.kind === 'approval');
  assert.equal(alert.agent, 'fakeagent');
  assert.equal(alert.decision.question, 'Do you want to proceed?');
  assert.deepEqual(alert.decision.options.map((o) => o.label), ['1. Yes', "2. Yes, and don't ask again for npm test commands", '3. No, and tell me what to do differently (esc)']);

  // open the agent's view, as the app does
  c.send({ type: 'crossbar' });
  await c.next((m) => m.type === 'crossbar' && m.categories);
  c.send({ type: 'crossbar-act', item: `pane:${alert.pane}`, action: 'view' });
  const frame = await c.next((m) => m.type === 'frame' && m.decision);

  // a prompt that has changed since you looked is refused, and nothing is typed
  c.send({ type: 'answer', index: 1, sig: 'stale' });
  const refused = await c.next((m) => m.type === 'crossbar-result' && m.ok === false);
  assert.match(refused.message, /changed/);
  assert.deepEqual(agentLog(), []);

  // pick option 2: two ↓ from the cursor on option 0, then Enter
  c.send({ type: 'answer', index: 2, sig: frame.decision.sig });
  const chose = await c.next((m) => m.type === 'crossbar-result' && /^chose/.test(m.message ?? ''));
  assert.equal(chose.message, 'chose: 3. No, and tell me what to do differently (esc)');
  const DOWN = [27, 91, 66];
  for (let i = 0; i < 30 && agentLog().length < 4; i++) await new Promise((r) => setTimeout(r, 100)); // keys land asynchronously
  assert.deepEqual(agentLog(), [{ bytes: DOWN }, { bytes: DOWN }, { bytes: [13] }, { chose: 2 }]);
  c.ws.close();
});

test('keys only go to the pane this client is viewing', { skip, timeout: 15_000 }, async () => {
  const c = client();
  await c.open;
  const before = agentLog().length;
  c.send({ type: 'key', key: 'enter' });
  const r = await c.next((m) => m.type === 'crossbar-result');
  assert.equal(r.ok, false);
  assert.match(r.message, /not viewing a pane/);
  assert.equal(agentLog().length, before);
  c.ws.close();
});

test('unknown keys are refused', { skip, timeout: 15_000 }, async () => {
  const c = client();
  await c.open;
  c.send({ type: 'crossbar' });
  await c.next((m) => m.type === 'crossbar' && m.categories);
  const pane = execFileSync(TMUX, ['list-panes', '-a', '-F', '#{session_name}:#{window_index}.#{pane_index}']).toString().trim().split('\n')[0];
  c.send({ type: 'crossbar-act', item: `pane:${pane}`, action: 'view' });
  await c.next((m) => m.type === 'frame');
  c.send({ type: 'key', key: 'rm -rf /' });
  const r = await c.next((m) => m.type === 'crossbar-result' && !m.action); // not the view's own result
  assert.equal(r.ok, false);
  assert.match(r.message, /unknown key/);
  c.ws.close();
});

test('feeds saved twice quickly: the later save wins, even when the first fetch ends last', { skip, timeout: 15_000 }, async (t) => {
  // A is slow the first time only: the first save's fetch (A) finishes after the second's (A + B)
  let firstA = true;
  const rss = (name) => `<rss><channel><title>${name}</title><item><title>${name} headline</title></item></channel></rss>`;
  const BODIES = { '/A': rss('A'), '/B': rss('B') }; // fixed bodies: nothing from the request is echoed
  const feeds = createServer((req, res) => {
    const body = BODIES[req.url];
    if (!body) { res.statusCode = 404; res.end(); return; }
    const delay = req.url === '/A' && firstA ? 2000 : 0;
    if (req.url === '/A') firstA = false;
    setTimeout(() => res.end(body), delay);
  });
  await new Promise((r) => feeds.listen(0, '127.0.0.1', r));
  t.after(() => feeds.close());
  const base = `http://127.0.0.1:${feeds.address().port}`;
  const c = client();
  await c.open;
  c.send({ type: 'setup-feed', feed: { urls: [`${base}/A`], minutes: 30 } });
  c.send({ type: 'setup-feed', feed: { urls: [`${base}/A`, `${base}/B`], minutes: 30 } });
  await new Promise((r) => setTimeout(r, 3500)); // both fetches are done
  c.ws.close();
  const later = client(); // a new client: the list as it stands now, not the broadcasts on the way
  await later.open;
  later.send({ type: 'papers' });
  const { papers } = await later.next((m) => m.type === 'papers');
  assert.deepEqual(papers.map((p) => p.title).sort(), ['A headline', 'B headline']);
  later.ws.close();
});

test('the setup screen gets its feed suggestions from the bridge', { skip, timeout: 15_000 }, async () => {
  const c = client();
  await c.open;
  c.send({ type: 'setup' });
  const { presets } = await c.next((m) => m.type === 'setup');
  assert.ok(presets.length >= 2 && presets.every(([name, url]) => name && /^https:\/\//.test(url)));
  c.ws.close();
});

test('the bridge serves its files, and nothing that is a folder or outside dist', { skip, timeout: 15_000 }, async () => {
  const get = async (path) => (await fetch(`http://127.0.0.1:${PORT}${path}`)).status;
  assert.equal(await get('/'), 200);
  assert.equal(await get('/crossbar.html'), 200);
  assert.equal(await get('/assets'), 404); // a folder
  assert.equal(await get('/nope.js'), 404);
  assert.equal(await get('/%2e%2e/package.json'), 404); // outside dist
});

test('subtitles: a switch in System, each phone its own', { skip, timeout: 15_000 }, async () => {
  const a = client(), b = client();
  await Promise.all([a.open, b.open]);
  const subsItem = (m) => m.categories.find((c) => c.id === 'system')?.items[0];
  a.send({ type: 'crossbar' });
  const off = subsItem(await a.next((m) => m.type === 'crossbar' && m.categories));
  assert.equal(off.id, 'sys:subs');
  assert.deepEqual(off.actions.map((x) => x.id), ['on']);
  a.send({ type: 'crossbar-act', item: 'sys:subs', action: 'on' });
  await a.next((m) => m.type === 'subs' && m.on === true);
  await a.next((m) => m.type === 'crossbar' && m.categories && subsItem(m).label === 'Subtitles On'); // (an earlier refresh may come first)
  a.ws.send(Buffer.alloc(9600)); // a second of silence from the mic: nothing to caption
  b.send({ type: 'crossbar' });
  assert.equal(subsItem(await b.next((m) => m.type === 'crossbar' && m.categories)).label, 'Subtitles'); // b's are still off
  a.send({ type: 'crossbar-act', item: 'sys:subs', action: 'off' });
  await a.next((m) => m.type === 'subs' && m.on === false);
  a.ws.close(); b.ws.close();
});
