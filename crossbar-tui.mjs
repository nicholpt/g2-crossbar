#!/usr/bin/env node
// Crossbar in a terminal: the same PSP-style browser as the glasses app, run on
// the Mac itself (`npm run tui`, also handy over ssh).
//   ←/→ category   ↑/↓ item   ⏎ options   esc back   r refresh   q quit
import { execFile, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createCrossbar } from './crossbar.mjs';

const TMUX = process.env.CROSSBAR_TMUX || ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux'].find((p) => existsSync(p)) || 'tmux';
const run = (cmd) => new Promise((resolve, reject) => {
  execFile('/bin/sh', ['-c', cmd], { timeout: 10_000, maxBuffer: 4 << 20 }, (err, out, se) =>
    err ? reject(new Error((se || err.message).trim())) : resolve(out));
});
const crossbar = createCrossbar({ run, tmux: TMUX });
const out = process.stdout;

// --- state --------------------------------------------------------------------
let cats = [];
let ci = -1; // Agents once loaded
const itemIdx = {};
let menu = null; // { i, armed } while the options menu is open (armed: confirm pending)
let view = null; // { id, frame, scroll } for non-pane views (vitals, notes, logs…)
let toast = { text: '', until: 0 };
let loading = 'loading…';
let phase = 0;

const cat = () => cats[ci];
const items = () => cat()?.items ?? [];
const ii = () => Math.min(itemIdx[cat()?.id] ?? 0, Math.max(0, items().length - 1));
const item = () => items()[ii()];
// mic / camera / text-entry actions need the phone or glasses
const acts = () => (item()?.actions ?? []).filter((a) => !a.needs);
const say = (text, ms = 2500) => { toast = { text, until: Date.now() + ms }; draw(); };

async function refresh() {
  try {
    const keep = cat()?.id, keepItem = item()?.id;
    cats = await crossbar.list();
    loading = '';
    const c = cats.findIndex((x) => x.id === keep);
    ci = c >= 0 ? c : Math.max(0, cats.findIndex((x) => x.id === 'agents'));
    const k = items().findIndex((x) => x.id === keepItem);
    if (k >= 0) itemIdx[cat().id] = k;
  } catch (e) { loading = `scan failed: ${e.message.split('\n')[0]}`; }
  draw();
}

// --- drawing: a cell grid over a sky gradient ------------------------------------
const lerp = (a, b, t) => Math.round(a + (b - a) * t);
const SKY = [[11, 31, 74], [29, 79, 156], [74, 138, 214]];
function sky(y, h) {
  const t = y / Math.max(1, h - 1);
  const [a, b, u] = t < 0.55 ? [SKY[0], SKY[1], t / 0.55] : [SKY[1], SKY[2], (t - 0.55) / 0.45];
  return a.map((v, i) => lerp(v, b[i], u));
}
const width = (s) => [...s].length;

function draw() {
  if (!out.isTTY) return;
  const W = out.columns || 80, H = out.rows || 24;
  // grid of [char, fg rgb | null (=default white), bold]
  const grid = Array.from({ length: H }, () => Array.from({ length: W }, () => [' ', null, false]));
  const put = (x, y, s, fg = null, bold = false) => {
    if (y < 0 || y >= H) return;
    for (const ch of s) { if (x >= 0 && x < W) grid[y][x] = [ch, fg, bold]; x++; }
  };
  const clip = (s, n) => (width(s) > n ? [...s].slice(0, Math.max(0, n - 1)).join('') + '…' : s);

  // the ribbon
  for (let k = 0; k < 3; k++) {
    for (let x = 0; x < W; x++) {
      const y = Math.round(H * 0.68 + Math.sin(x / W * 5 + phase * (0.6 + k * 0.15) + k) * H * 0.07 + Math.sin(x / W * 2.3 - phase * 0.3 + k * 2) * H * 0.04);
      if (y >= 0 && y < H && grid[y][x][0] === ' ') grid[y][x] = ['·─━'[k], [120 + k * 30, 160 + k * 25, 230], false];
    }
  }

  const DIM = [175, 195, 235], FAINT = [120, 150, 205], LIVE = [158, 240, 180];
  if (view) return drawView(W, H, grid, put, clip, DIM);
  put(2, 0, 'Crossbar', DIM);
  const clock = new Date().toLocaleString([], { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  put(W - width(clock) - 2, 0, clock, null, true);

  const bar = Math.max(4, Math.floor(H * 0.3));
  const col = Math.max(14, Math.floor(W * 0.28));
  if (!cats.length) put(col, bar, loading, DIM);
  // categories: fixed column for the selected one, neighbours either side
  for (let d = cats.length > 1 ? -1 : 0; cats.length && d <= Math.max(0, cats.length - 2); d++) { // each category once
    const c = cats[(ci + d + cats.length) % cats.length];
    const x = col + d * 12;
    put(x, bar, c.icon, d ? FAINT : null, !d);
    if (!d) put(x, bar + 1, c.label, null, true);
  }

  // items: selected under the bar, earlier ones stacked above it
  const list = items(), i = ii();
  const iw = W - col - 4;
  const lab = (it) => `${it.live ? '● ' : '  '}${it.label}`;
  if (list[i]) {
    put(col - 2, bar + 3, clip(lab(list[i]), iw), list[i].live ? LIVE : null, true);
    put(col, bar + 4, clip(list[i].sub, iw), DIM);
    if (list[i].live) put(col, bar + 3, clip(list[i].label, iw), null, true);
  }
  for (let k = i + 1, y = bar + 6; k < list.length && y < H - 2; k++, y++) put(col - 2, y, clip(lab(list[k]), iw), FAINT);
  for (let k = i - 1, y = bar - 2; k >= 0 && y > 1; k--, y--) put(col - 2, y, clip(lab(list[k]), iw), FAINT);

  // options menu (the triangle menu) on the right
  let panelX = W;
  if (menu && item()) {
    const pw = Math.min(30, Math.floor(W * 0.4)), px = W - pw;
    const list = acts();
    const top = Math.max(1, Math.floor(H / 2 - list.length));
    list.forEach((a, k) => {
      const label = menu.armed === a.id ? `${a.label}? ⏎ again` : a.label;
      put(px + 3, top + k * 2, clip(`${k === menu.i ? '▶ ' : '  '}${label}`, pw - 4), menu.armed === a.id ? [255, 140, 140] : k === menu.i ? null : DIM, k === menu.i);
    });
    panelX = px;
  }

  const hint = toast.text && Date.now() < toast.until ? toast.text
    : menu ? '↑↓ choose   ⏎ do it   esc back' : '←→ category   ↑↓ item   ⏎ options   r refresh   q quit';
  put(2, H - 1, clip(hint, W - 4), DIM);

  emit(W, H, grid, panelX);
}

// Non-pane views: documents (top: true) page from the top, the rest follow the tail.
function drawView(W, H, grid, put, clip, DIM) {
  const f = view.frame;
  const rows = [];
  for (const l of f?.lines ?? ['loading…']) { let r = [...l]; do { rows.push(r.slice(0, W - 4).join('')); r = r.slice(W - 4); } while (r.length); }
  const n = H - 3;
  view.scroll = Math.max(0, Math.min(view.scroll, rows.length - n));
  const start = f?.top ? view.scroll : Math.max(0, rows.length - n - view.scroll);
  put(2, 0, clip(f?.label ?? view.id, W - 4), null, true);
  rows.slice(start, start + n).forEach((r, k) => put(2, k + 2, r));
  put(2, H - 1, '↑↓ scroll   esc back   q quit', DIM);
  emit(W, H, grid, W, 0.3);
}

function emit(W, H, grid, panelX, shade = 1) {
  // emit with a per-row background (darker band behind the menu panel)
  let s = '\x1b[H';
  for (let y = 0; y < H; y++) {
    const bg = sky(y, H).map((v) => Math.round(v * shade));
    let lastStyle = '';
    for (let x = 0; x < W; x++) {
      const [ch, fg, bold] = grid[y][x];
      const b = x >= panelX ? bg.map((v) => Math.round(v * 0.35)) : bg;
      const f = fg || [242, 246, 255];
      const style = `\x1b[${bold ? 1 : 22};38;2;${f.join(';')};48;2;${b.join(';')}m`;
      if (style !== lastStyle) { s += style; lastStyle = style; }
      s += ch;
    }
    if (y < H - 1) s += '\r\n';
  }
  out.write(`${s}\x1b[0m`);
}

// --- actions ----------------------------------------------------------------------
async function doAction(a) {
  const it = item();
  menu = null;
  say(`${a.label}…`, 10_000);
  try {
    const r = await crossbar.act(it.id, a.id);
    if (r.view?.startsWith('pane:')) return attach(r.view.slice(5));
    if (r.view) return openView(r.view);
    say(r.message);
    setTimeout(refresh, 1200);
  } catch (e) { say(`failed: ${e.message.split('\n')[0]}`); }
}

async function openView(id) {
  view = { id, frame: null, scroll: 0 };
  toast = { text: '', until: 0 };
  const poll = async () => {
    if (view?.id !== id) return;
    try { view.frame = await crossbar.view(id); } catch (e) { view.frame = { label: id, lines: [e.message.split('\n')[0]] }; }
    draw();
    setTimeout(poll, 1000);
  };
  poll();
}

// Open a pane: switch to it if we're inside tmux, else attach until detached.
function attach(pane) {
  if (process.env.TMUX) {
    spawnSync(TMUX, ['switch-client', '-t', pane]);
    return say(`switched to ${pane}`);
  }
  leave();
  const sess = pane.split(':')[0];
  spawnSync(TMUX, ['select-window', '-t', pane.replace(/\.\d+$/, '')]);
  spawnSync(TMUX, ['select-pane', '-t', pane]);
  spawnSync(TMUX, ['attach', '-t', sess], { stdio: 'inherit' });
  enter();
  refresh();
}

// --- input --------------------------------------------------------------------------
function key(k) {
  const n = items().length;
  if (view) {
    const page = view.frame?.top ? (out.rows || 24) - 4 : 4;
    if (k === 'up') view.scroll += view.frame?.top ? -page : page;
    else if (k === 'down') view.scroll = Math.max(0, view.scroll + (view.frame?.top ? page : -page));
    else if (k === 'esc' || k === 'left') view = null;
    else if (k === 'quit') return quit();
    view && (view.scroll = Math.max(0, view.scroll));
  } else if (menu) {
    const list = acts();
    if (k === 'up') { menu.i = Math.max(0, menu.i - 1); menu.armed = null; }
    else if (k === 'down') { menu.i = Math.min(list.length - 1, menu.i + 1); menu.armed = null; }
    else if (k === 'enter' && list[menu.i]?.confirm && menu.armed !== list[menu.i].id) menu.armed = list[menu.i].id;
    else if (k === 'enter' && list[menu.i]) return void doAction(list[menu.i]);
    else if (k === 'esc' || k === 'left') menu = null;
  } else if (k === 'left' || k === 'right') { if (cats.length) ci = (ci + (k === 'left' ? -1 : 1) + cats.length) % cats.length; }
  else if (k === 'up' || k === 'down') { if (n) itemIdx[cat().id] = Math.max(0, Math.min(n - 1, ii() + (k === 'up' ? -1 : 1))); }
  else if (k === 'enter' && item()) {
    if (acts().length) menu = { i: 0 };
    else say(item().label);
  } else if (k === 'refresh') return void refresh();
  else if (k === 'quit') return quit();
  draw();
}

const KEYMAP = { '\x1b[A': 'up', '\x1b[B': 'down', '\x1b[C': 'right', '\x1b[D': 'left', '\x1bOA': 'up', '\x1bOB': 'down', '\x1bOC': 'right',
  '\x1bOD': 'left', k: 'up', j: 'down', l: 'right', h: 'left', '\r': 'enter', '\n': 'enter', ' ': 'enter', '\x1b': 'esc', '\x7f': 'esc',
  q: 'quit', '\x03': 'quit', r: 'refresh', o: 'enter' };
function onData(d) {
  const s = d.toString();
  // split pasted/buffered input into escape sequences and single chars
  for (const tok of s.match(/\x1b\[[0-9;]*[A-Za-z~]|\x1bO[A-Z]|\x1b|[\s\S]/g) || []) if (KEYMAP[tok]) key(KEYMAP[tok]);
}

// --- terminal lifecycle --------------------------------------------------------------
let timers = [];
function enter() {
  out.write('\x1b[?1049h\x1b[?25l');
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.on('data', onData);
  timers = [setInterval(() => { phase += 0.08; draw(); }, 125), setInterval(refresh, 5000)];
  draw();
}
function leave() {
  timers.forEach(clearInterval);
  process.stdin.off('data', onData);
  process.stdin.setRawMode?.(false);
  out.write('\x1b[0m\x1b[?25h\x1b[?1049l');
}
function quit() { leave(); process.exit(0); }

if (!process.stdin.isTTY) { console.error('crossbar-tui needs a terminal (use ssh -t)'); process.exit(1); }
process.on('SIGTERM', quit);
process.on('uncaughtException', (e) => { leave(); console.error(e); process.exit(1); }); // never strand the terminal
process.on('SIGHUP', () => process.exit(0));
out.on('resize', draw);
enter();
refresh();
