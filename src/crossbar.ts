// Crossbar: PSP-style browser of your Mac on the G2 glasses, mirrored
// and touch-driven on the phone. Catalog, actions and views live in the
// bridge (crossbar.mjs / crossbar-server.mjs); this file is presentation + input, plus
// the things only the phone/glasses can do: mic (Ask), camera (Snap), and the
// glasses' battery / is-worn status.
/// <reference types="vite/client" />
import {
  AudioInputSource,
  OsEventTypeList,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
  ImageContainerProperty,
  ImageRawDataUpdate,
  ImageRawDataUpdateResult,
  waitForEvenAppBridge,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk';
import { getTextWidth, pxTruncate } from '@evenrealities/pretext';
import { iconPng, iconUrl } from './crossbar-icons';
import { PORT, hostOf, isHome, toWs as toWsFor } from './address';

type Action = { id: string; label: string; confirm?: boolean; needs?: 'mic' | 'camera' | 'album' | 'text' };
type Item = { id: string; label: string; sub: string; meta?: string; live?: boolean; actions: Action[] };
type Cat = { id: string; label: string; icon: string; items: Item[] };
type Decision = { question: string; options: { label: string }[]; cursor: number; sig: string };
type Frame = { type: 'frame'; target: string; label: string; subject?: string; lines: string[]; top?: boolean; decision?: Decision };
type Alert = { pane: string; agent: string; kind: 'approval' | 'finished'; text?: string };
type Ask = { state: string; agent?: string; text?: string; until: number };
type Level = 'bar' | 'items' | 'menu' | 'view' | 'answer';

const params = new URLSearchParams(location.search);
// Where the bridge (crossbar-server.mjs on your Mac, :8787) is, first match wins:
// ?ws=…, the page's own origin when the bridge itself serves it, the address
// saved on the setup screen, or the one bin/setup baked into the package.
// Which addresses are accepted: src/address.ts.
const STORE_KEY = 'crossbar.bridge';
const STORE_CODE = 'crossbar.key';
const served = location.protocol === 'http:' && location.port === String(PORT);
const stored = (k: string) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
let saved = stored(STORE_KEY);
let code = stored(STORE_CODE);
const BUILT = (import.meta.env.VITE_CROSSBAR_ADDR as string | undefined) || ''; // the Mac's address from bin/setup (never the pairing code)
/** The bridge's WebSocket URL for an address, with the saved pairing code. */
const toWs = (addr: string, key = code) => toWsFor(addr, key);
const address = () => saved || BUILT;
const wsUrl = () => params.get('ws') || (served ? `ws://${location.host}/ws` : toWs(address()));
// nothing to connect to yet, or a home-network Mac without its pairing code
const needsSetup = () => !wsUrl() || (!params.get('ws') && !served && isHome(address()) && !code);
const $ = (id: string) => document.getElementById(id)!;

// --- state ---------------------------------------------------------------------
let cats: Cat[] = [];
let ci = -1; // set to Agents on first load
const itemIdx: Record<string, number> = {};
let level: Level = 'bar';
let mi = 0; // option-menu cursor
let armed = ''; // confirm-required action selected once, waiting for a second select
let viewing = ''; // view id shown in the view level
let frame: Frame | null = null;
let scroll = 0;
let ai = 0; // answer-list cursor (a prompt's options, then "Keys…")
let keymode = false; // glasses key strip under a pane view
let papers: { id: string; title: string; cat?: string; authors?: string; summary?: string }[] = []; // top-line feed headlines (the Mac fetches them; arXiv AI papers by default)
let mini = false; // glasses minimized to a small top-left tag (long press); the rest of the screen is left clear
let ki = 0;
let toast = { text: '', until: 0 };
let offline = 'connecting…';
let ask: Ask | null = null; // voice prompt in progress
let micLive = false;
let device: { battery?: number; charging?: boolean; wearing?: boolean } = {};
let pendingText: { item: string; action: string; label: string } | null = null; // phone text sheet

const cat = () => cats[ci];
const items = () => cat()?.items ?? [];
const ii = () => Math.min(itemIdx[cat()?.id] ?? 0, Math.max(0, items().length - 1));
const item = (): Item | undefined => items()[ii()];
const say = (text: string, ms = 2500) => { toast = { text, until: Date.now() + ms }; render(); };
const toastText = () => (toast.text && Date.now() < toast.until ? toast.text : '');
const asking = () => !!ask && ['listening', 'transcribing', 'pending'].includes(ask.state);
// Sent / cancelled / failed screens close on their own; any tap closes them sooner.
const dismissAsk = () => { ask = null; render(); };

// --- navigation (shared by glasses, phone touch and keyboard) -------------------
function moveCat(d: number) { if (cats.length) { ci = (ci + d + cats.length) % cats.length; render(); } }
function moveItem(d: number) {
  const n = items().length;
  if (n) { itemIdx[cat().id] = Math.max(0, Math.min(n - 1, ii() + d)); render(); }
}
function openMenu() {
  const it = item();
  if (!it) return;
  const acts = usable(it);
  if (!acts.length) return say(it.label);
  level = 'menu'; mi = 0; armed = ''; render();
}
// Mic/camera actions need the Even app (glasses mic, phone camera via the SDK);
// a plain browser can still take photos through a file input.
const usable = (it: Item | undefined) => (it?.actions ?? []).filter((a) => a.needs !== 'mic' || !!bridge);
const actionLabel = (a: Action) => (armed === a.id ? `${a.label}? select again` : a.label);

async function runAction(a: Action) {
  const it = item();
  if (!it) return;
  if (a.confirm && armed !== a.id) { armed = a.id; return say(`${a.label}: select again to confirm`, 5000); }
  armed = '';
  let arg: unknown;
  if (a.needs === 'text') {
    pendingText = { item: it.id, action: a.id, label: a.label };
    level = 'items';
    render();
    ($('sheettext') as HTMLTextAreaElement).focus();
    return say('type it on the phone', 4000);
  }
  if (a.needs === 'camera' || a.needs === 'album') {
    say(a.needs === 'camera' ? 'take the photo on your phone' : 'pick a photo on your phone', 30_000);
    try { arg = await getImage(a.needs); } catch (e) { return say(`photo: ${e instanceof Error ? e.message : e}`); }
    if (!arg) return say('no photo');
  }
  send({ type: 'crossbar-act', item: it.id, action: a.id, arg });
  say(`${a.label}…`, 8000);
  level = 'items';
  render();
}

function back() {
  if (asking()) return void send({ type: 'ask-cancel' });
  if (ask) return dismissAsk();
  if (level === 'answer') level = 'view';
  else if (level === 'view' && keymode) keymode = false;
  else if (level === 'view') { level = 'items'; viewing = ''; send({ type: 'view', pane: null }); }
  else if (level === 'menu') { level = 'items'; armed = ''; }
  else if (level === 'items') level = 'bar';
  else return void bridge?.shutDownPageContainer(1); // root: Even's exit dialog
  render();
}
function select() {
  if (asking()) return void send({ type: 'ask-cancel' }); // tap = cancel while asking
  if (ask) return dismissAsk();
  if (level === 'bar') { if (items().length) level = 'items'; render(); }
  else if (level === 'items') openMenu();
  else if (level === 'menu') { const a = usable(item())[mi]; if (a) runAction(a); }
  else if (level === 'answer') {
    const d = decision();
    if (!d || ai >= d.options.length) { level = 'view'; keymode = true; ki = 0; }
    else { send({ type: 'answer', index: ai, sig: d.sig }); say(`→ ${d.options[ai].label}`, 4000); level = 'view'; }
    render();
  } else if (level === 'view' && keymode) { send({ type: 'key', key: KEY_STRIP[ki][1] }); say(`key ${KEY_STRIP[ki][0]}`, 1200); }
  else if (level === 'view' && isPane()) {
    // tap in an agent's view: answer its prompt if it has one, else the key strip
    const d = decision();
    if (d) { level = 'answer'; ai = d.cursor; } else { keymode = true; ki = 0; }
    render();
  }
}
const isPane = () => viewing.startsWith('pane:');
const decision = () => (frame && frame.target === viewing ? frame.decision : undefined);
const KEY_STRIP: [string, string][] = [['↑', 'up'], ['↓', 'down'], ['Tab', 'tab'], ['Enter', 'enter'], ['Esc', 'esc'], ['1', '1'], ['2', '2'],
  ['3', '3'], ['y', 'y'], ['n', 'n'], ['Spc', 'space'], ['Bksp', 'bspace'], ['^C', 'ctrl-c']];
function step(d: number) {
  if (level === 'bar') moveCat(d);
  else if (level === 'items') moveItem(d);
  else if (level === 'menu') { const n = usable(item()).length; if (n) { mi = Math.max(0, Math.min(n - 1, mi + d)); armed = ''; render(); } }
  else if (level === 'answer') { const n = (decision()?.options.length ?? 0) + 1; ai = Math.max(0, Math.min(n - 1, ai + d)); render(); }
  else if (keymode) { ki = Math.max(0, Math.min(KEY_STRIP.length - 1, ki + d)); render(); }
  else { scroll = frame?.top ? scroll + d * (VIEW_ROWS - 1) : Math.max(0, scroll - d * 4); render(); }
}
function jumpTo(catId: string) {
  const k = cats.findIndex((c) => c.id === catId);
  if (k < 0) return;
  ci = k; itemIdx[catId] = 0; level = 'items'; render();
}

// --- photos (Snap) ---------------------------------------------------------------------
async function getImage(kind: 'camera' | 'album'): Promise<{ mime: string; data: string } | null> {
  if (bridge) {
    const asset = kind === 'camera' ? await bridge.captureImageFromCamera() : await bridge.pickImageFromAlbum();
    return asset ? { mime: asset.mimeType, data: asset.base64 } : null;
  }
  // plain browser: the file picker (camera on phones via capture)
  const input = $(kind === 'camera' ? 'filecam' : 'filepick') as HTMLInputElement;
  input.value = '';
  const file = await new Promise<File | null>((resolve) => { input.onchange = () => resolve(input.files?.[0] ?? null); input.click(); });
  if (!file) return null;
  const data = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
  return { mime: file.type || 'image/jpeg', data };
}

// --- mic (Ask) --------------------------------------------------------------------------
async function setMic(on: boolean) {
  if (!bridge || on === micLive) return;
  try { micLive = on ? await bridge.audioControl(true, AudioInputSource.Glasses) : (await bridge.audioControl(false), false); } catch { micLive = false; }
}

// --- status: time · G2 battery, or a notification banner -------------------------
const needsCount = () => cats.find((c) => c.id === 'needs')?.items.filter((it) => it.id.startsWith('alert:')).length ?? 0;
// phone header: the latest thing that needs you, or now playing
function notification(): string {
  const t = toastText();
  if (t) return t;
  const a = cats.find((c) => c.id === 'needs')?.items.find((it) => it.id.startsWith('alert:'));
  if (a) return `${a.label}${needsCount() > 1 ? ` +${needsCount() - 1}` : ''}`;
  const now = cats.find((c) => c.id === 'music')?.items.find((it) => it.id === 'music:now' && it.live);
  return now ? `${now.label} · ${now.sub.split(' · ')[0]}` : '';
}
function battery(): string {
  if (device.battery === undefined) return '';
  const segs = Math.max(0, Math.min(4, Math.ceil(device.battery / 25)));
  return `${device.charging ? '+' : ''}${'■'.repeat(segs)}${'□'.repeat(4 - segs)}`;
}
const clock = () => new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

// --- glasses rendering ------------------------------------------------------------
// Calm, Apple-like Crossbar: one focal point per screen, hierarchy by brightness
// (0–4) rather than symbols, detail only on the selected item. Category icons
// are images (crossbar-icons.ts): the selected one large, its neighbours small and dim.
const COL = 168;              // the Crossbar column: selected icon, label and items line up here
const W_ITEMS = 576 - COL - 12;
const VIEW_ROWS = 10;
const SP = getTextWidth(' ') || 5;
const C = {
  status: { id: 1, name: 'status' },
  label: { id: 2, name: 'label' },
  above: { id: 3, name: 'above' },
  box: { id: 4, name: 'box' },
  title: { id: 5, name: 'title' },
  below1: { id: 7, name: 'below1' },
  below2: { id: 8, name: 'below2' },
  head: { id: 1, name: 'head' }, // ids are per page: shares 1 with the Crossbar's status line
  term: { id: 9, name: 'term' },
  mini: { id: 11, name: 'mini' },
  keys: { id: 10, name: 'keys' },
};
// icon slots: one before the selected category, the selected one, two after
const BIG = 60, SMALL = 34;
const ICON_SLOTS = [
  { id: 20, name: 'icon0', d: -1, size: SMALL, x: COL - 52 - SMALL, y: 46 },
  { id: 21, name: 'icon1', d: 0, size: BIG, x: COL, y: 34 },
  { id: 22, name: 'icon2', d: 1, size: SMALL, x: COL + BIG + 52, y: 46 },
  { id: 23, name: 'icon3', d: 2, size: SMALL, x: COL + BIG + 52 + SMALL + 52, y: 46 },
];
const fit = (s: string, px: number) => pxTruncate(s, px);
const padTo = (s: string, x: number) => s + ' '.repeat(Math.max(1, Math.floor((x - getTextWidth(s)) / SP)));
// right-aligned pair on one line, never overflowing (an overflowing line wraps)
const spread = (left: string, right: string, width: number) => {
  if (!right) return fit(left, width);
  const l = fit(left, width - getTextWidth(right) - 24);
  return l + ' '.repeat(Math.max(2, Math.floor((width - 6 - getTextWidth(l) - getTextWidth(right)) / SP))) + right;
};
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

type Line = { text: string; color: number };
type GlassView = Record<'status' | 'label' | 'above' | 'title' | 'sub' | 'below1' | 'below2', Line>;
const L = (text: string, color: number): Line => ({ text, color });

function statusLine(): Line {
  const t = toastText();
  if (t) return L(fit(padTo('', Math.max(0, (568 - getTextWidth(fit(t, 520))) / 2)) + t, 568), 4); // banner
  const n = needsCount();
  const left = `${clock()}${mini && n ? `   ※${n}` : ''}`; // minimized there's no icon badge
  const right = battery();
  const room = 548 - getTextWidth(left) - getTextWidth(SEP) - (right ? getTextWidth(right) + 24 : 0);
  const title = paperTicker(room);
  return L(spread(title ? left + SEP + title : left, right, 548), 2);
}

// The newest AI papers on arXiv (cs.AI/LG/CL) after the clock. A title that
// doesn't fit scrolls sideways: hold, slide a few characters per step to its
// end, hold, then the next title.
const SEP = '   ';
const HOLD_MS = 2000, STEP_MS = 400, STEP_CHARS = 3;
const ticker = { i: 0, at: 0 };
function paperTicker(room: number): string {
  if (!papers.length || room < 80) return '';
  if (!ticker.at) ticker.at = Date.now();
  const r = slid(papers[ticker.i % papers.length].title, room, ticker.at);
  if (r.over) { ticker.i++; ticker.at = Date.now(); return paperTicker(room); }
  return r.text;
}
// `text` in `room` px, `since` it first showed: held, slid a few characters per
// step to its end, held; `over` once that's done (short texts stay 8 s).
function slid(text: string, room: number, since: number): { text: string; over: boolean } {
  const end = (() => { // first offset from which the rest fits
    let k = 0;
    while (k < text.length && getTextWidth(text.slice(k)) > room) k += STEP_CHARS;
    return k;
  })();
  const elapsed = Date.now() - since;
  const off = Math.min(end, Math.max(0, Math.floor((elapsed - HOLD_MS) / STEP_MS)) * STEP_CHARS);
  const done = HOLD_MS + Math.ceil(end / STEP_CHARS) * STEP_MS + (end ? HOLD_MS : 6000);
  return { text: fit(off ? text.slice(off).trimStart() : text, room), over: elapsed > done };
}

function askView(): Partial<GlassView> {
  const a = ask!;
  const secs = Math.max(0, Math.ceil((a.until - Date.now()) / 1000));
  const head = { listening: 'Listening…', transcribing: 'Transcribing…', pending: `Sending in ${secs}`,
    sent: 'Sent', cancelled: 'Cancelled', error: 'Couldn’t Send' }[a.state] ?? a.state;
  const hint = a.state === 'pending' ? 'Tap to cancel · double-tap to send now' : asking() ? 'Tap to cancel' : 'Tap to close';
  const said = wrap([a.text ? `“${a.text}”` : ''], W_ITEMS);
  return { label: L(`Ask ${cap(ask?.agent ?? '')}`, 2), title: L(head, 4), sub: L(fit(hint, W_ITEMS - 20), 2),
    below1: L(said[0] ?? '', 3), below2: L(said[1] ?? '', 2) };
}

const attention = (it: Item) => !!(it as Item & { attention?: boolean }).attention;
const itemTitle = (it: Item) => `${it.label}${attention(it) && cat()?.id !== 'needs' ? '  •' : ''}`;
const itemSub = (it: Item) => [it.meta, it.sub].filter(Boolean).join(' · ');

function crossbarView(): GlassView {
  const v: GlassView = { status: statusLine(), label: L('', 4), above: L('', 1), title: L('', 4), sub: L('', 2), below1: L('', 2), below2: L('', 1) };
  if (needsSetup()) return { ...v, title: L('Finish Setup on Your Phone', 4), sub: L(fit('In the Even app: Crossbar › Setup', W_ITEMS - 20), 2) };
  if (!cats.length) return { ...v, title: L(offline ? 'Mac Offline' : 'Loading…', 3), sub: L(fit(offline, W_ITEMS - 20), 1) };
  if (ask) return { ...v, ...askView() };
  const w = W_ITEMS - 20;
  if (level === 'answer') {
    const d = decision();
    const q = wrap([d?.question ?? ''], 560 - COL);
    const opts = [...(d?.options.map((o) => o.label.replace(/^\(?\d{1,2}[.)]\s+/, '')) ?? []), 'Keys…'];
    return { ...v, label: L(q[0] ?? '', 4), above: L(q[1] ?? '', 3), title: L(fit(opts[ai], w), 4),
      sub: L(ai === d?.cursor ? 'Selected now' : '', 1), below1: L(fit(opts[ai + 1] ?? '', w), 2), below2: L(fit(opts[ai + 2] ?? '', w), 1) };
  }
  if (level === 'menu') {
    const acts = usable(item());
    const a = acts[mi];
    return { ...v, label: L(item()?.label ?? '', 2), above: L(fit(acts[mi - 1]?.label ?? '', w), 1),
      title: L(a ? (armed === a.id ? `${a.label}?` : a.label) : '', 4), sub: L(a && armed === a.id ? 'Tap again to confirm' : '', 2),
      below1: L(fit(acts[mi + 1]?.label ?? '', w), 2), below2: L(fit(acts[mi + 2]?.label ?? '', w), 1) };
  }
  // home (bar) and inside a category: the category name or the item is the focus
  const list = items();
  const i = ii();
  const it = list[i];
  const inList = level === 'items';
  return { ...v,
    label: L(cat().label, inList ? 2 : 4),
    above: L(inList && list[i - 1] ? fit(itemTitle(list[i - 1]), w) : '', 1),
    title: L(it ? fit(itemTitle(it), w) : 'Nothing Here', inList ? 4 : 3),
    sub: L(it ? fit(itemSub(it), w) : '', inList ? 2 : 1),
    below1: L(list[i + 1] ? fit(itemTitle(list[i + 1]), w) : '', 2),
    below2: L(list[i + 2] ? fit(itemTitle(list[i + 2]), w) : '', 1) };
}

function wrap(lines: string[], px: number): string[] {
  const out: string[] = [];
  for (let rest of lines) {
    while (getTextWidth(rest) > px) {
      let lo = 1, hi = rest.length - 1;
      while (lo < hi) { const m = (lo + hi + 1) >> 1; if (getTextWidth(rest.slice(0, m)) <= px) lo = m; else hi = m - 1; }
      let cut = rest.lastIndexOf(' ', lo);
      if (cut < lo / 2) cut = lo;
      out.push(rest.slice(0, cut));
      rest = '  ' + rest.slice(cut).trimStart();
    }
    out.push(rest);
  }
  return out;
}

// Live views: a quiet header (name · state) over a rule, then the content.
// Terminal-like views follow the tail; documents start at the top and page.
let viewOpened = 0;
// An open view: a header line (its own container, so a sliding subject only
// resends that line), then a rule and the screen.
function termBody(): string {
  const rows = frame && frame.target === viewing ? wrap(frame.lines, 566) : ['Loading…'];
  const n = VIEW_ROWS - 2 - (keymode ? 1 : 0);
  let start: number;
  scroll = Math.max(0, Math.min(scroll, rows.length - n));
  if (frame?.top) start = scroll;
  else start = Math.max(0, rows.length - scroll - n);
  return ['─'.repeat(Math.floor(566 / (getTextWidth('─') || 10))), ...rows.slice(start, start + n)].join('\n');
}
// "Claude - Opus 5.5 high · ~/Documents · deepseek disk space cleanup     Idle":
// what the agent is working on (its terminal title) after the label; when that
// doesn't fit, it alone slides sideways.
const subjectSlide = { text: '', at: 0 };
let subjectSliding = false;
function termHead(): string {
  subjectSliding = false;
  const rows = frame && frame.target === viewing ? wrap(frame.lines, 566) : [];
  const n = VIEW_ROWS - 2 - (keymode ? 1 : 0);
  const pos = frame?.top && rows.length > n ? `${Math.floor(scroll / (n - 1)) + 1} of ${Math.ceil((rows.length - 1) / (n - 1))}` : '';
  const d = decision();
  const name = cap(frame?.label ?? '');
  const state = isPane() ? (cat()?.id === 'agents' ? item()?.meta ?? '' : '') : pos;
  const hint = keymode ? 'Swipe to choose · tap to send · double-tap when done'
    : d ? `${d.question} — tap to answer`
    : Date.now() - viewOpened < 3500 ? (isPane() ? 'Tap for keys · double-tap to go back' : 'Double-tap to go back') : '';
  if (toastText()) return fit(toastText(), 566);
  if (hint) return fit(hint, 566);
  const subject = frame?.target === viewing ? frame.subject ?? '' : '';
  const room = 566 - getTextWidth(`${name} · `) - (state ? getTextWidth(state) + 24 : 0) - 6;
  if (!subject || room < 80) return spread(name, state, 566);
  if (subjectSlide.text !== subject) { subjectSlide.text = subject; subjectSlide.at = Date.now(); }
  let r = slid(subject, room, subjectSlide.at);
  if (r.over) { subjectSlide.at = Date.now(); r = slid(subject, room, subjectSlide.at); }
  subjectSliding = getTextWidth(subject) > room;
  return spread(`${name} · ${r.text}`, state, 566);
}

// Minimized: one small line top-left. In an agent's view, that agent's state and
// time in it; elsewhere the time and how many agents need you. Alerts only
// change the tag for a moment; they never reopen the full screen.
function miniTag(): Line {
  const t = toastText();
  if (level !== 'menu' && isPane()) {
    if (t) return L(fit(t, 410), 4);
    const agent = cats.find((c) => c.id === 'agents')?.items.find((it) => it.id === viewing);
    const name = agent?.label ?? cap(frame?.label ?? '');
    return L(fit([name, agent?.meta].filter(Boolean).join(' · '), 410), 3);
  }
  return statusLine(); // home: the same top bar as the full Crossbar
}
// All glasses text at one brightness (the user's choice); the per-line levels
// in L(...) are kept but not applied.
const BRIGHT = 4;
const text = (c: { id: number; name: string }, o: Partial<TextContainerProperty>) =>
  new TextContainerProperty({ containerID: c.id, containerName: c.name, content: ' ', borderWidth: 0, paddingLength: 0, ...o, textColor: BRIGHT });

function keyStrip(): string {
  let out = '';
  for (let k = Math.max(0, ki - 6); k < KEY_STRIP.length; k++) out += k === ki ? `[${KEY_STRIP[k][0]}] ` : ` ${KEY_STRIP[k][0]}  `;
  return fit(out, 566);
}

type Page = 'crossbar' | 'term' | 'termkeys' | 'mini';
function layout(page: Page) {
  if (page === 'mini') {
    return { containerTotalNum: 1, textObject: [text(C.mini, { xPosition: 8, yPosition: 0, width: 560, height: 28, textColor: 3, isEventCapture: 1 })] };
  }
  if (page === 'termkeys') {
    return { containerTotalNum: 3, textObject: [
      text(C.head, { xPosition: 0, yPosition: 0, width: 576, height: 28 }),
      text(C.term, { xPosition: 0, yPosition: 28, width: 576, height: 226, isEventCapture: 1 }),
      text(C.keys, { xPosition: 0, yPosition: 256, width: 576, height: 32, borderWidth: 1, borderColor: 8, borderRadius: 8, paddingLength: 2 }),
    ] };
  }
  if (page === 'term') {
    return { containerTotalNum: 2, textObject: [
      text(C.head, { xPosition: 0, yPosition: 0, width: 576, height: 28 }),
      text(C.term, { xPosition: 0, yPosition: 28, width: 576, height: 260, isEventCapture: 1 }),
    ] };
  }
  const col = { xPosition: COL, width: W_ITEMS };
  return {
    containerTotalNum: 11,
    textObject: [
      text(C.status, { xPosition: 8, yPosition: 0, width: 560, height: 28, textColor: 2 }),
      text(C.label, { ...col, yPosition: 98, height: 28 }),
      text(C.above, { ...col, yPosition: 128, height: 27, textColor: 1 }),
      // the selection: one soft rounded outline around the title and its subtitle,
      // which share a container so they always change together
      text(C.box, { xPosition: COL - 12, yPosition: 157, width: W_ITEMS + 12, height: 62, borderWidth: 1, borderColor: 8, borderRadius: 10, isEventCapture: 1 }),
      text(C.title, { xPosition: COL, yPosition: 160, width: W_ITEMS - 8, height: 56 }),
      text(C.below1, { ...col, yPosition: 224, height: 28, textColor: 2 }),
      text(C.below2, { ...col, yPosition: 254, height: 28, textColor: 1 }),
    ],
    imageObject: ICON_SLOTS.map((s) => new ImageContainerProperty({ xPosition: s.x, yPosition: s.y, width: s.size, height: s.size,
      containerID: s.id, containerName: s.name })),
  };
}

let bridge: EvenAppBridge | null = null;
let page: Page | '' = '';
let shown: Record<string, string> = {};
let busy = false;
let dirty = false;

// which icon each slot should show (key includes size/dim/badge, so unchanged slots aren't resent)
function iconPlan() {
  const n = cats.length;
  return ICON_SLOTS.map((s) => {
    if (!n || (s.d && n < 2) || (s.d < 0 && n < 3) || s.d >= n) return { s, key: 'blank' };
    const c = cats[(ci + s.d + n) % n];
    const badge = c.id === 'needs' ? needsCount() : 0;
    return { s, c, badge, key: `${c.id}|${s.size}|${s.d !== 0}|${badge}` };
  });
}

// One update for the selected item's title and subtitle: as two containers, a
// changing list could show one item's title over the previous item's subtitle.
function selection({ title, sub, ...rest }: GlassView): Record<string, Line> {
  return { ...rest, title: { ...title, text: sub.text.trim() ? `${title.text}\n${sub.text}` : title.text } };
}

async function renderGlasses() {
  if (!bridge) return;
  if (device.wearing === false) { shown = {}; return; } // not worn: don't spend BLE/battery
  if (busy) { dirty = true; return; }
  busy = true;
  try {
    const want: Page = mini ? 'mini' : level === 'view' && !ask ? (keymode ? 'termkeys' : 'term') : 'crossbar';
    if (page !== want) {
      if (!(await bridge.rebuildPageContainer(new RebuildPageContainer(layout(want))))) throw new Error('page rebuild rejected');
      page = want; shown = {};
    }
    const content: Record<string, Line> = want === 'mini' ? { mini: miniTag() } : want === 'term' ? { head: L(termHead(), 4), term: L(termBody(), 4) }
      : want === 'termkeys' ? { head: L(termHead(), 4), term: L(termBody(), 4), keys: L(keyStrip(), 4) } : selection(crossbarView());
    for (const [name, { text: value, color }] of Object.entries(content)) {
      const v = value || ' ';
      if (shown[name] === `${color}|${v}`) continue;
      const c = C[name as keyof typeof C];
      await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: c.id, containerName: c.name, content: v, textColor: BRIGHT }));
      shown[name] = `${color}|${v}`;
    }
    if (want === 'crossbar') {
      // icons after text (text is what you read first); one image at a time over BLE
      for (const { s, c, badge, key } of iconPlan().sort((a, b) => Math.abs(a.s.d) - Math.abs(b.s.d))) {
        if (shown[s.name] === key) continue;
        const png = c ? iconPng(c.id, s.size, { badge }) : blankPng(s.size);
        const r = await bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: s.id, containerName: s.name, imageData: png }));
        if (r === ImageRawDataUpdateResult.success) shown[s.name] = key;
        if (dirty) break; // the user moved on: redraw text for the new position first
      }
    }
  } catch (e) {
    $('status').textContent = `glasses: ${e}`;
  } finally {
    busy = false;
    if (dirty) { dirty = false; renderGlasses(); }
  }
}
const blankCache: Record<number, number[]> = {};
const blankPng = (size: number) => (blankCache[size] ??= blankFrom(size));
function blankFrom(size: number): number[] {
  const cv = document.createElement('canvas');
  cv.width = size; cv.height = size;
  const g = cv.getContext('2d')!;
  g.fillStyle = '#000'; g.fillRect(0, 0, size, size);
  return Array.from(atob(cv.toDataURL('image/png').split(',')[1]), (ch) => ch.charCodeAt(0));
}

// --- phone rendering ----------------------------------------------------------------
function renderPhone() {
  $('status').textContent = offline || (mini ? 'Glasses minimized · tap here to restore' : '');
  $('clock').textContent = clock();
  $('notif').textContent = notification();
  $('batt').textContent = battery() ? `G2 ${battery()}` : '';
  const bar = $('cats');
  bar.replaceChildren(...cats.map((c, i) => {
    const b = document.createElement('button');
    b.className = `cat${i === ci ? ' on' : ''}`;
    b.innerHTML = `<img class="icon" alt=""><span class="label"></span>`;
    // drawn at 3x for sharp edges on the phone's retina screen
    (b.querySelector('.icon') as HTMLImageElement).src = iconUrl(c.id, 108, c.id === 'needs' ? needsCount() : 0);
    b.querySelector('.label')!.textContent = c.label;
    b.onclick = () => { ci = i; level = level === 'bar' ? 'bar' : 'items'; render(); };
    return b;
  }));
  // keep the selected category in the fixed Crossbar column
  const on = bar.children[ci] as HTMLElement | undefined;
  if (on) bar.style.transform = `translateX(${-on.offsetLeft}px)`;

  const list = $('items');
  const i = ii();
  list.replaceChildren(...items().map((it, k) => {
    const b = document.createElement('button');
    b.className = `item${k === i ? ' on' : ''}${it.live ? ' live' : ''}${k < i ? ' before' : ''}`;
    b.innerHTML = `<span class="label"></span><span class="meta"></span><span class="sub"></span>`;
    b.querySelector('.label')!.textContent = it.label;
    b.querySelector('.meta')!.textContent = it.meta ?? '';
    b.querySelector('.sub')!.textContent = it.sub;
    b.onclick = () => {
      if (k === i && level !== 'bar') openMenu();
      else { itemIdx[cat().id] = k; level = 'items'; render(); }
    };
    return b;
  }));
  // previous items sit above the bar, the selected one just below it
  const sel = list.children[i] as HTMLElement | undefined;
  list.style.transform = `translateY(${sel ? -sel.offsetTop : 0}px)`;

  const menu = $('menu');
  menu.hidden = level !== 'menu';
  if (level === 'menu') {
    menu.replaceChildren(...usable(item()).map((a, k) => {
      const b = document.createElement('button');
      b.className = `${k === mi ? 'on' : ''}${armed === a.id ? ' armed' : ''}`;
      b.textContent = actionLabel(a);
      b.onclick = () => { if (mi !== k) { mi = k; armed = ''; } runAction(a); };
      return b;
    }));
  }
  $('term').hidden = level !== 'view' && level !== 'answer';
  $('paneinput').hidden = !isPane();
  const d = decision();
  const dec = $('decision');
  dec.hidden = !d;
  if (d && dec.dataset.sig !== d.sig) {
    dec.dataset.sig = d.sig;
    const q = document.createElement('div');
    q.className = 'q';
    q.textContent = d.question;
    dec.replaceChildren(q, ...d.options.map((o, k) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = o.label;
      if (k === d.cursor) b.className = 'cur';
      b.onclick = () => { send({ type: 'answer', index: k, sig: d.sig }); say(`→ ${o.label}`, 4000); };
      return b;
    }));
  }
  if (level === 'view' || level === 'answer') {
    $('termlabel').textContent = frame?.label ?? viewing;
    const pre = $('termtext');
    const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8;
    const body = frame && frame.target === viewing ? frame.lines.join('\n') : 'loading…';
    if (pre.textContent !== body) {
      pre.textContent = body;
      if (!frame?.top && atBottom) pre.scrollTop = pre.scrollHeight; // follow the tail
    }
  }
  const askEl = $('ask');
  askEl.hidden = !ask;
  if (ask) {
    const v = askView();
    $('askhead').textContent = `${ask.agent ?? ''} · ${v.title?.text ?? ''}`;
    $('asktext').textContent = ask.text ?? '';
    ($('asksend') as HTMLButtonElement).hidden = ask.state !== 'pending';
    $('askcancel').textContent = asking() ? 'Cancel' : 'Close';
  }
  $('sheet').hidden = !pendingText;
  if (pendingText) $('sheetlabel').textContent = pendingText.label;
  document.body.dataset.level = level;
}

function render() {
  renderPhone();
  renderGlasses();
}

// --- bridge connection ---------------------------------------------------------------
let ws: WebSocket | null = null;
const send = (msg: object) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));
let retry: ReturnType<typeof setTimeout> | undefined;
const describe = (a: Alert & { decision?: Decision }) =>
  a.decision ? `${a.agent} is asking · ${a.decision.question}` : `${a.agent} ${a.kind === 'approval' ? 'needs approval' : 'finished'}${a.text ? ` · ${a.text}` : ''}`;

function connect() {
  clearTimeout(retry);
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  if (needsSetup()) { offline = ''; render(); return; }
  ws = new WebSocket(wsUrl());
  let opened = false;
  ws.onopen = () => {
    opened = true; offline = '';
    send({ type: 'crossbar' });
    send({ type: 'papers' });
    if (!$('setup').hidden) send({ type: 'setup' });
    if (device.wearing !== undefined) send({ type: 'presence', wearing: device.wearing });
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'setup') { onSetupInfo(msg); return; }
    if (msg.type === 'crossbar') {
      if (msg.error) { offline = `mac: ${msg.error}`; return render(); }
      const keep = cat()?.id;
      const keepItem = item()?.id;
      cats = msg.categories;
      ci = cats.findIndex((c) => c.id === (keep ?? 'agents'));
      if (ci < 0) ci = Math.max(0, cats.findIndex((c) => c.id === 'agents'));
      const k = items().findIndex((it) => it.id === keepItem); // stay on the same item as the list changes
      if (k >= 0) itemIdx[cat().id] = k;
      if (level === 'menu' && k < 0) level = 'items';
    } else if (msg.type === 'papers') {
      papers = msg.papers ?? [];
    } else if (msg.type === 'crossbar-result') {
      if (!msg.ask) say(msg.ok ? msg.message : `failed: ${msg.message}`);
      if (msg.ok && msg.view) { viewing = msg.view; scroll = 0; level = 'view'; frame = null; keymode = false; viewOpened = Date.now(); }
    } else if (msg.type === 'frame') {
      if (frame?.target !== msg.target) scroll = 0;
      frame = msg;
      if (level === 'answer' && !decision()) level = 'view'; // answered (or gone) on the Mac
      if (level !== 'view' && level !== 'answer') return;
    } else if (msg.type === 'alerts') {
      const fresh = msg.fresh as Alert[];
      say(`${describe(fresh[0])}${fresh.length > 1 ? ` +${fresh.length - 1}` : ''}`, 6000);
      return;
    } else if (msg.type === 'away') {
      const list = msg.alerts as Alert[];
      const n = (k: string) => list.filter((a) => a.kind === k).length;
      say(`While away: ${[n('approval') && `${n('approval')} need approval`, n('finished') && `${n('finished')} finished`].filter(Boolean).join(', ')}`, 8000);
      return;
    } else if (msg.type === 'ask') {
      // by the new state only: "sent"/"cancelled" linger 2.5 s, then the Crossbar returns
      const ms = msg.state === 'pending' ? msg.ms : ['listening', 'transcribing'].includes(msg.state) ? 60_000 : 2500;
      ask = { state: msg.state, agent: msg.agent ?? ask?.agent, text: msg.text ?? ask?.text, until: Date.now() + ms };
      setMic(asking());
    } else return;
    render();
  };
  ws.onclose = (e) => {
    // Say exactly what failed: the installed app can't be inspected otherwise.
    offline = `Mac bridge offline (${opened ? 'dropped' : 'no connection'}, code ${e.code}) · ${wsUrl()} · retrying`;
    setupState(opened ? 'Connection dropped, retrying…' : `Can't reach ${wsUrl()}. Is the bridge running, and Tailscale on?`, 'bad');
    if (asking()) { ask = null; setMic(false); }
    render();
    retry = setTimeout(connect, 2000);
  };
}

// Running apps / panes change on their own; refresh while browsing.
setInterval(() => { if ((level !== 'view' && level !== 'menu' && !ask) || mini) send({ type: 'crossbar' }); }, 5000);
// the scrolling paper title in the top bar (renders only send what changed)
setInterval(() => { if (papers.length && (mini ? !(level !== 'menu' && isPane()) : page === 'crossbar')) renderGlasses(); }, STEP_MS);
// an agent's subject sliding in its view's header (only the header is resent)
setInterval(() => { if (subjectSliding && !mini && (page === 'term' || page === 'termkeys')) renderGlasses(); }, STEP_MS);
// toasts, the clock and Ask's countdown / result
setInterval(() => {
  if (toast.text && Date.now() > toast.until) toast = { text: '', until: 0 };
  if (ask && !asking() && Date.now() > ask.until) ask = null;
  render();
}, 1000);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { connect(); shown = {}; send({ type: 'crossbar' }); render(); }
  else if (asking()) send({ type: 'ask-cancel' });
});

// --- phone controls -----------------------------------------------------------------
addEventListener('keydown', (e) => {
  if (['TEXTAREA', 'INPUT'].includes((e.target as HTMLElement).tagName)) return;
  const k = e.key;
  if (k === 'ArrowLeft' && level === 'bar') moveCat(-1);
  else if (k === 'ArrowRight' && level === 'bar') moveCat(1);
  else if (k === 'ArrowLeft' || k === 'ArrowRight') { if (level === 'items') { level = 'bar'; moveCat(k === 'ArrowLeft' ? -1 : 1); } }
  else if (k === 'ArrowUp') step(-1);
  else if (k === 'ArrowDown') step(1);
  else if (k === 'Enter') select();
  else if (k === 'Escape' || k === 'Backspace') { if (level !== 'bar' || ask) back(); }
  else return;
  e.preventDefault();
});
$('back').addEventListener('click', back);
$('status').addEventListener('click', () => { if (mini) { mini = false; render(); } });
$('termback').addEventListener('click', () => { if (level === 'answer') level = 'view'; keymode = false; back(); });
$('compose').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('composetext') as HTMLInputElement;
  if (!input.value) return void send({ type: 'key', key: 'enter' }); // empty send = Enter
  send({ type: 'type', text: input.value });
  input.value = '';
});
for (const b of document.querySelectorAll<HTMLButtonElement>('#tkeys button')) {
  b.addEventListener('click', () => send({ type: 'key', key: b.dataset.key }));
}
$('notif').addEventListener('click', () => jumpTo('needs'));
$('askcancel').addEventListener('click', () => (asking() ? send({ type: 'ask-cancel' }) : dismissAsk()));
$('asksend').addEventListener('click', () => send({ type: 'ask-send' }));
$('sheetcancel').addEventListener('click', () => { pendingText = null; render(); });
$('sheetsend').addEventListener('click', () => {
  const ta = $('sheettext') as HTMLTextAreaElement;
  if (pendingText && ta.value) send({ type: 'crossbar-act', item: pendingText.item, action: pendingText.action, arg: ta.value });
  ta.value = '';
  pendingText = null;
  render();
});

// --- glasses input -------------------------------------------------------------------
let lastScroll = 0;
function onInput(type: OsEventTypeList | undefined) {
  type = type ?? OsEventTypeList.CLICK_EVENT; // protobuf drops CLICK (0)
  if (type === OsEventTypeList.LONG_PRESS_EVENT) { mini = !mini; render(); return; }
  if (mini) {
    // minimized: only long press / double-tap bring it back; nothing else can act
    if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) { mini = false; render(); }
    else if (type === OsEventTypeList.FOREGROUND_ENTER_EVENT) { shown = {}; connect(); send({ type: 'crossbar' }); render(); }
    return;
  }
  if (type === OsEventTypeList.SCROLL_TOP_EVENT || type === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
    if (Date.now() - lastScroll < 250) return; // swipes fire in bursts
    lastScroll = Date.now();
    if (!asking()) step(type === OsEventTypeList.SCROLL_BOTTOM_EVENT ? 1 : -1);
  } else if (type === OsEventTypeList.CLICK_EVENT) select();
  else if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    if (ask?.state === 'pending') send({ type: 'ask-send' });
    else back();
  } else if (type === OsEventTypeList.FOREGROUND_ENTER_EVENT) { shown = {}; connect(); send({ type: 'crossbar' }); render(); }
}

function onDevice(s: { batteryLevel?: number; isCharging?: boolean; isWearing?: boolean } | undefined) {
  if (!s) return;
  const wasWearing = device.wearing;
  device = { battery: s.batteryLevel ?? device.battery, charging: s.isCharging ?? device.charging, wearing: s.isWearing ?? device.wearing };
  if (device.wearing !== wasWearing) {
    send({ type: 'presence', wearing: device.wearing });
    if (device.wearing === false && asking()) send({ type: 'ask-cancel' });
  }
  render();
}

async function initGlasses() {
  const b = await waitForEvenAppBridge();
  // start text-only (as Dense mode learned, image containers are only reliable
  // after a rebuild); the first render rebuilds into the Crossbar page with icons
  const result = await b.createStartUpPageContainer(new CreateStartUpPageContainer(layout('term')));
  if (result !== StartUpPageCreateResult.success && !(await b.rebuildPageContainer(new RebuildPageContainer(layout('term'))))) {
    $('status').textContent = `glasses page failed (${result})`;
    return;
  }
  page = 'term';
  b.onEvenHubEvent((ev) => {
    // 16 kHz s16le mono from the glasses mic, only while asking
    if (ev.audioEvent) { if (asking() && ws?.readyState === WebSocket.OPEN) ws.send(new Uint8Array(ev.audioEvent.audioPcm)); return; }
    const e = ev.textEvent ?? ev.sysEvent;
    if (e) onInput(e.eventType);
  });
  bridge = b;
  b.onDeviceStatusChanged((s) => onDevice(s));
  b.getDeviceInfo().then((d) => onDevice(d?.status)).catch(() => {});
  render();
}

// --- setup screen (phone) -------------------------------------------------------------
// Address of the bridge, a connection test, and the top-line feed (stored on the Mac).
const FEED_PRESETS: [string, string][] = [
  ['AI papers (arXiv)', 'https://export.arxiv.org/api/query?search_query=cat:cs.AI+OR+cat:cs.LG+OR+cat:cs.CL&sortBy=submittedDate&sortOrder=descending&max_results=40'],
  ['Hacker News', 'https://hnrss.org/frontpage'],
  ['The Verge', 'https://www.theverge.com/rss/index.xml'],
  ['BBC News', 'https://feeds.bbci.co.uk/news/rss.xml'],
];
function setupState(text: string, kind: '' | 'ok' | 'bad' = '') {
  const el = $('setupstate');
  el.textContent = text;
  el.className = kind;
}
function openSetup() {
  ($('setupaddr') as HTMLInputElement).value = served ? location.host : address();
  ($('setupcode') as HTMLInputElement).value = code;
  showCode();
  $('setup').hidden = false;
  if (ws?.readyState === WebSocket.OPEN) send({ type: 'setup' });
  else setupState(needsSetup() ? '' : `Not connected to ${wsUrl()}`, needsSetup() ? '' : 'bad');
}
function onSetupInfo(msg: { version: string; mode: string; dns?: string; local?: string; port: number; owner: string; saved?: boolean;
  feed: { urls: string[]; minutes: number } }) {
  setupState(msg.saved ? 'Feed saved' : `Connected to ${msg.dns ?? msg.local ?? 'your Mac'}`, 'ok');
  $('setupinfo').textContent = `Bridge ${msg.version} · ${msg.mode === 'home' ? 'home network, paired' : `Tailscale, ${msg.owner}'s devices only`}`;
  $('feedpart').hidden = false;
  if (!msg.saved) {
    ($('feedurls') as HTMLTextAreaElement).value = msg.feed.urls.join('\n');
    ($('feedmin') as HTMLInputElement).value = String(msg.feed.minutes);
  }
}
async function saveAddress(addr: string, key: string) {
  saved = hostOf(addr);
  code = key.trim();
  for (const [k, v] of [[STORE_KEY, saved], [STORE_CODE, code]]) {
    try { localStorage.setItem(k, v); } catch {}
    // the Even app's WebView may not keep localStorage; its own store does
    await bridge?.setLocalStorage(k, v).catch(() => false);
  }
}
// the pairing code is only for home-network (.local) addresses
const showCode = () => { $('codefield').hidden = !isHome(($('setupaddr') as HTMLInputElement).value); };
$('setupaddr').addEventListener('input', showCode);
$('gear').addEventListener('click', openSetup);
$('setupdone').addEventListener('click', () => { $('setup').hidden = true; render(); });
$('setupform').addEventListener('submit', async (e) => {
  e.preventDefault();
  const addr = ($('setupaddr') as HTMLInputElement).value;
  const key = ($('setupcode') as HTMLInputElement).value;
  if (!toWs(addr, key)) return setupState('Use your Mac\'s Tailscale name (….ts.net) or IP (100.x.y.z), its home name (….local) or localhost', 'bad');
  if (isHome(addr) && !key.trim()) return setupState('Enter the pairing code bin/setup --home printed', 'bad');
  await saveAddress(addr, key);
  setupState(`Connecting to ${hostOf(addr)}…`);
  $('feedpart').hidden = true;
  ws?.close(); ws = null; // reconnects to the new address
  clearTimeout(retry);
  connect();
});
for (const [name, url] of FEED_PRESETS) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = `+ ${name}`;
  b.addEventListener('click', () => {
    const t = $('feedurls') as HTMLTextAreaElement;
    if (!t.value.includes(url)) t.value = `${t.value.trim()}\n${url}`.trim();
  });
  $('feedpresets').append(b);
}
$('feedsave').addEventListener('click', () => {
  const urls = ($('feedurls') as HTMLTextAreaElement).value.split(/\s+/).filter(Boolean);
  const bad = urls.find((u) => !/^https?:\/\//.test(u));
  if (bad) return setupState(`Not a feed URL: ${bad}`, 'bad');
  send({ type: 'setup-feed', feed: { urls, minutes: Number(($('feedmin') as HTMLInputElement).value) || 30 } });
  setupState('Saving…');
});

(async () => {
  // a saved address in the Even app's own store wins over an empty WebView storage
  const b = await Promise.race([waitForEvenAppBridge(), new Promise<null>((r) => setTimeout(() => r(null), 1500))]);
  if (b && !saved) {
    saved = (await b.getLocalStorage(STORE_KEY).catch(() => '')) || '';
    code = (await b.getLocalStorage(STORE_CODE).catch(() => '')) || '';
  }
  connect();
  render();
  if (needsSetup()) openSetup();
})();
initGlasses().catch(() => {}); // plain browser: phone UI only
