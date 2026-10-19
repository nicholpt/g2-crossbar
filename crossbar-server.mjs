// Crossbar bridge: runs on your Mac (LaunchAgent, see bin/setup). Serves the Crossbar web
// app and a WebSocket for the catalog (crossbar.mjs), actions, live views, agent
// alerts, voice "Ask", photo "Snap", the top-line feed and the setup screen.
// Access (lib.mjs): your own Tailscale devices on the tailnet, or the home
// network with a pairing code; plus this Mac itself on 127.0.0.1.
import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { createCrossbar } from './crossbar.mjs';
import { Segmenter, transcribe } from './voice.mjs';
import { parseFeed } from './feed.mjs';
import { TMUX, HOST, HOSTS, OWNER, MODE, addresses, authorize, run, serveStatic } from './lib.mjs';

const VERSION = JSON.parse(readFileSync(join(import.meta.dirname, 'package.json'), 'utf8')).version;

const DIST = join(import.meta.dirname, 'dist');
// 8787: a port the Even app is known to let installed apps reach (it refused 8790 in testing)
const PORT = Number(process.env.CROSSBAR_PORT || 8787);
const POLL_MS = Number(process.env.POLL_MS || 700);
const WATCH_MS = 3000;
const ASK_DELAY = 3000;      // cancel window before a spoken prompt is typed in
const ASK_SILENCE = 12_000;  // give up if nothing is said
const SNAP_QUESTION = 'Look at this image and tell me what is relevant to what we are working on.';

const crossbar = createCrossbar({ run, tmux: TMUX, onAlert });
const send = (ws, msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));
const broadcast = (msg) => { for (const c of wss.clients) send(c, msg); };
const sendList = (ws) => crossbar.list(ws.focus).then(
  (categories) => send(ws, { type: 'crossbar', categories }),
  (e) => send(ws, { type: 'crossbar', error: e.message.split('\n')[0] }));

// --- live views, one per client ------------------------------------------------------
const views = new Map(); // ws -> { id, key }
let polling = false;
async function pollViews() {
  if (polling) return;
  polling = true;
  try {
    for (const [ws, v] of views) {
      const frame = await crossbar.view(v.id).catch((e) => ({ label: v.id, lines: [`mac: ${e.message.split('\n')[0]}`] }));
      const key = JSON.stringify(frame);
      if (views.get(ws) !== v || key === v.key) continue;
      // Each frame is a Bluetooth write to the glasses: at most one per 1.5 s, and a
      // change that's only a spinner or a ticking timer ("Working (12s") waits 5 s.
      const since = Date.now() - (v.sent ?? 0), gist = key.replace(/\d+/g, '#').replace(/[\u2800-\u28ff✻✽✶✳✢◐◓◑◒]/g, '*');
      if (since < 1500 || (gist === v.gist && since < 5000)) continue;
      Object.assign(v, { key, gist, sent: Date.now() });
      send(ws, { type: 'frame', target: v.id, ...frame });
    }
  } finally { polling = false; }
}
setInterval(() => { if (views.size) pollViews(); }, POLL_MS);
const setView = (ws, id) => { if (id) views.set(ws, { id, key: '' }); else views.delete(ws); pollViews(); };

// --- "Needs you": agent watcher, pushed to everyone ----------------------------------
// Presence: while nobody is wearing the glasses, new alerts are also kept as
// "missed" and summarised when someone puts them back on.
const presence = new Map(); // ws -> wearing
let missed = [];
function onAlert(fresh) {
  if (![...presence.values()].some(Boolean)) missed.push(...fresh);
  broadcast({ type: 'alerts', fresh });
  setTimeout(() => { for (const c of wss.clients) sendList(c); }); // badge + Needs you column
}
setInterval(() => { if (wss.clients.size) crossbar.watch().catch(() => {}); }, WATCH_MS);

// --- top-line feed: headlines from RSS / Atom feeds (default: newest AI papers on arXiv) ----
// Configured in crossbar.json under "feed" (or from the phone's setup screen):
//   { "feed": { "urls": ["https://…/rss"], "minutes": 30, "max": 40 } }   "urls": [] turns it off.
const SETTINGS = process.env.CROSSBAR_CONFIG || join(import.meta.dirname, 'crossbar.json');
const FEED_DEFAULTS = {
  // the arXiv API rather than its RSS: arXiv's RSS is empty on weekends
  urls: ['https://export.arxiv.org/api/query?search_query=cat:cs.AI+OR+cat:cs.LG+OR+cat:cs.CL&sortBy=submittedDate&sortOrder=descending&max_results=40'],
  minutes: 30,
  max: 40,
};
const readSettings = () => { try { return JSON.parse(readFileSync(SETTINGS, 'utf8')); } catch { return {}; } };
const feedSettings = () => {
  const f = { ...FEED_DEFAULTS, ...readSettings().feed };
  return { ...f, urls: (Array.isArray(f.urls) ? f.urls : []).map(String).filter((u) => /^https?:\/\//.test(u)) }; // a hand-edited file too
};
let papers = []; // { title, source } (named for the arXiv default; any feed's items)
let feedRun = 0; // fetches overlap (feeds saved twice quickly): only the newest may set papers
async function fetchFeeds() {
  const run = ++feedRun;
  const { urls, max } = feedSettings();
  const lists = await Promise.all(urls.map((u) => fetch(u, { signal: AbortSignal.timeout(30_000) })
    .then((r) => r.text()).then(parseFeed).catch((e) => { console.log(`[feed] ${u}: ${e.message}`); return []; })));
  // interleave feeds so one busy feed doesn't drown the others
  const next = [];
  for (let i = 0; next.length < max && lists.some((l) => l[i]); i++) for (const l of lists) if (l[i] && next.length < max) next.push(l[i]);
  if (run !== feedRun) return; // settings changed while this one was fetching
  if (next.length || !urls.length) { papers = next; broadcast({ type: 'papers', papers }); }
}
let feedTimer;
function scheduleFeeds() {
  clearInterval(feedTimer);
  fetchFeeds();
  feedTimer = setInterval(fetchFeeds, Math.max(5, Number(feedSettings().minutes) || 30) * 60_000);
}
scheduleFeeds();

// --- setup screen: what the phone may read and change -------------------------------
// offered on the phone's setup screen (the bridge fetches feeds, not the app)
const FEED_PRESETS = [
  ['AI papers (arXiv)', FEED_DEFAULTS.urls[0]],
  ['Hacker News', 'https://hnrss.org/frontpage'],
  ['The Verge', 'https://www.theverge.com/rss/index.xml'],
  ['BBC News', 'https://feeds.bbci.co.uk/news/rss.xml'],
];
function setupInfo() {
  return { type: 'setup', version: VERSION, mode: MODE, ...addresses(), port: PORT, owner: OWNER, feed: feedSettings(), presets: FEED_PRESETS, whisper: !!process.env.WHISPER_MODEL || existsSync(join(import.meta.dirname, 'models')) };
}
function saveFeed(feed) {
  const urls = (Array.isArray(feed?.urls) ? feed.urls : []).map((u) => String(u).trim()).filter((u) => /^https?:\/\//.test(u)).slice(0, 10);
  const minutes = Math.min(1440, Math.max(5, Number(feed?.minutes) || FEED_DEFAULTS.minutes));
  writeFileSync(SETTINGS, `${JSON.stringify({ ...readSettings(), feed: { ...readSettings().feed, urls, minutes } }, null, 2)}\n`);
  scheduleFeeds();
}

// --- Ask: glasses mic → one utterance → Whisper → typed into an agent ----------------
const asks = new Map(); // ws -> { pane, agent, image?, seg, pending?, timer }
function endAsk(ws, state, extra = {}) {
  const a = asks.get(ws);
  if (!a) return;
  clearTimeout(a.timer);
  asks.delete(ws);
  send(ws, { type: 'ask', state, agent: a.agent, ...extra });
}
function startAsk(ws, { pane, agent, image }) {
  endAsk(ws, 'cancelled');
  const a = { pane, agent, image, busy: false };
  a.timer = setTimeout(() => (image ? queue(ws, a, '') : endAsk(ws, 'cancelled', { text: 'nothing heard' })), ASK_SILENCE);
  a.seg = new Segmenter((pcm) => {
    if (a.busy || a.pending !== undefined) return;
    a.busy = true;
    send(ws, { type: 'ask', state: 'transcribing', agent });
    transcribe(pcm).then((text) => {
      a.busy = false;
      if (asks.get(ws) !== a) return;
      text = text.replace(/^[[(].*[\])]$/, '').trim(); // "[BLANK_AUDIO]", "(wind)"
      if (!text) return send(ws, { type: 'ask', state: 'listening', agent });
      if (/^\W*(cancel|stop|never ?mind)\W*$/i.test(text)) return endAsk(ws, 'cancelled', { text });
      queue(ws, a, text);
    }, (e) => endAsk(ws, 'error', { text: `speech: ${e.message}` }));
  });
  asks.set(ws, a);
  send(ws, { type: 'ask', state: 'listening', agent, image: !!image });
}
function queue(ws, a, spoken) {
  clearTimeout(a.timer);
  const text = a.image ? `${spoken || SNAP_QUESTION} (image: ${a.image})` : spoken;
  a.pending = text;
  a.timer = setTimeout(() => fire(ws), ASK_DELAY);
  send(ws, { type: 'ask', state: 'pending', agent: a.agent, text, ms: ASK_DELAY });
}
async function fire(ws) {
  const a = asks.get(ws);
  if (!a || a.pending === undefined) return;
  try {
    await crossbar.typeInto(a.pane, a.pending);
    console.log(`[ask] ${a.agent} ${a.pane} <- ${JSON.stringify(a.pending)}`);
    endAsk(ws, 'sent', { text: a.pending });
  } catch (e) { endAsk(ws, 'error', { text: `send failed: ${e.message.split('\n')[0]}` }); }
}

// --- http + ws ---------------------------------------------------------------------
// One listener for the phone (tailnet IP, or the home network) and one on
// 127.0.0.1 for a browser or the simulator on this Mac.
const wss = new WebSocketServer({ noServer: true, maxPayload: 32 << 20 }); // photos
const hosts = HOST === '0.0.0.0' ? [HOST] : [...new Set([...HOSTS, '127.0.0.1'])]; // 0.0.0.0 already covers loopback
const servers = hosts.map((host) => {
  const server = createServer(serveStatic(DIST, 'crossbar.html'));
  server.on('upgrade', async (req, sock, head) => {
    const ok = req.url.startsWith('/ws') && (await authorize(req));
    console.log(`[ws] ${req.socket.remoteAddress} ${req.url.replace(/key=[^&]*/, 'key=…')} origin=${req.headers.origin ?? '-'} ${ok ? 'accepted' : 'REJECTED'}`);
    if (!ok) { sock.destroy(); return; }
    wss.handleUpgrade(req, sock, head, (ws) => wss.emit('connection', ws));
  });
  return { host, server };
});

wss.on('connection', (ws) => {
  ws.on('close', (code) => { views.delete(ws); asks.delete(ws); presence.delete(ws); console.log(`[ws] closed (${code})`); });
  ws.on('message', (data, isBinary) => {
    if (isBinary) { asks.get(ws)?.seg.push(Buffer.isBuffer(data) ? data : Buffer.concat(data)); return; } // glasses mic PCM
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.type === 'crossbar') { if (msg.focus) ws.focus = msg.focus; sendList(ws); }
    else if (msg.type === 'papers') send(ws, { type: 'papers', papers });
    else if (msg.type === 'setup') send(ws, setupInfo());
    else if (msg.type === 'setup-feed') {
      try { saveFeed(msg.feed); send(ws, { ...setupInfo(), saved: true }); }
      catch (e) { send(ws, { type: 'crossbar-result', ok: false, message: `couldn't save: ${e.message}` }); }
    }
    else if (msg.type === 'view') setView(ws, null); // leaving a view; opening goes through an action
    else if (msg.type === 'ask-cancel') endAsk(ws, 'cancelled');
    else if (['key', 'type', 'answer'].includes(msg.type)) {
      // only into the pane this client is viewing
      const pane = views.get(ws)?.id.match(/^pane:(.+)$/)?.[1];
      const fail = (e) => send(ws, { type: 'crossbar-result', ok: false, message: e.message.split('\n')[0] });
      if (!pane) return fail(new Error('not viewing a pane'));
      console.log(`[${msg.type}] ${pane} <- ${msg.type === 'type' ? JSON.stringify(String(msg.text ?? '').slice(0, 200)) : msg.type === 'key' ? msg.key : `option ${msg.index}`}`);
      const done = (r) => { if (r?.message) send(ws, { type: 'crossbar-result', ok: true, message: r.message }); const v = views.get(ws); if (v) v.sent = 0; pollViews(); }; // show the result now, not after the throttle
      if (msg.type === 'key') crossbar.sendKey(pane, String(msg.key)).then(done, fail);
      else if (msg.type === 'type') crossbar.typeInto(pane, String(msg.text ?? ''), msg.enter !== false).then(() => done({ message: msg.enter === false ? 'typed' : 'sent' }), fail);
      else crossbar.answer(pane, Number(msg.index), String(msg.sig)).then(done, fail);
    }
    else if (msg.type === 'ask-send') fire(ws);
    else if (msg.type === 'presence') {
      const was = [...presence.values()].some(Boolean);
      presence.set(ws, !!msg.wearing);
      if (msg.wearing && !was && missed.length) {
        send(ws, { type: 'away', alerts: missed });
        missed = [];
      }
    } else if (msg.type === 'crossbar-act') {
      const reply = (r) => send(ws, { type: 'crossbar-result', item: msg.item, action: msg.action, ...r });
      if (/^(alert:|pane:)/.test(String(msg.item))) console.log(`[act] ${msg.item} ${msg.action}`); // anything sent to an agent
      crossbar.act(String(msg.item), String(msg.action), msg.arg).then((r) => {
        if (r.view) setView(ws, r.view);
        if (r.ask) startAsk(ws, r.ask);
        reply({ ok: true, ...r });
        setTimeout(() => sendList(ws), 1200); // apps take a moment to launch/quit
      }, (e) => reply({ ok: false, message: e.message.split('\n')[0] }));
    }
  });
});

if (!existsSync(join(DIST, 'crossbar.html'))) {
  console.error('dist/crossbar.html missing — run `npm run build` first.');
  process.exit(1);
}
const who = MODE === 'home' ? 'home network, pairing code required' : `tailnet, ${OWNER}'s devices only`;
for (const { host, server } of servers) {
  server.listen(PORT, host, () => console.log(`crossbar bridge ${VERSION} listening on ${host}:${PORT} (${host === '127.0.0.1' ? 'this Mac' : who})`));
}
