// Crossbar (PSP-style) catalog of this Mac: what the browser lists, what each
// item can do, and the live "views" items open. Shared by the Crossbar bridge
// (glasses + phone) and crossbar-tui.mjs. Everything runs through `run` (a shell
// on the Mac); actions only resolve against the latest scan, so clients can
// only ask for things the catalog itself offered.
import { readFileSync, writeFileSync, mkdirSync, statSync, readdirSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { clean } from './text.mjs';

const HOME = homedir();
const ROOT = import.meta.dirname;
const SESSION = 'agents';
const APP_DIRS = ['/Applications', '/Applications/Utilities', '/System/Applications', '/System/Applications/Utilities', '"$HOME/Applications"'];
const REPO_ROOTS = ['Documents', 'src', 'code', 'Developer', 'Projects'];
const PATH = 'export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
const SPARK = '▁▂▃▄▅▆▇█';
const SUP = '⁰¹²³⁴⁵⁶⁷⁸⁹';

// User settings: crossbar.json next to this file (see crossbar.example.json), or
// CROSSBAR_CONFIG. Every key is optional.
export const CONFIG = process.env.CROSSBAR_CONFIG || join(ROOT, 'crossbar.json');
const DEFAULTS = {
  agents: ['claude', 'codex', 'agy', 'kimi'], // CLI commands that count as agents (tmux panes running them)
  newAgents: ['claude', 'codex'],                 // offered as "New … Here" on projects
  prompts: ['continue', 'run the tests and fix any failures', '/review', 'commit your changes with a clear message',
    'summarize what you did in 3 short bullet points'],
  logs: [join(ROOT, '.run/crossbar.log')],
  vaults: [join(HOME, 'Documents/Obsidian Vault')],
};
function settings() {
  let s = DEFAULTS;
  try { s = { ...DEFAULTS, ...JSON.parse(readFileSync(CONFIG, 'utf8')) }; } catch {}
  const home = (p) => { const x = String(p).replace(/^~(?=\/|$)/, HOME); return x.startsWith('/') ? x : join(ROOT, x); };
  return { ...s, logs: s.logs.map(home), vaults: s.vaults.map(home) };
}
const AGENTS = settings().agents; // read once: restart the bridge after changing it

const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
// the Mac App Store build of Tailscale isn't on PATH; bin/setup passes where it is
const tailscaleBin = () => sq(process.env.TAILSCALE_BIN || 'tailscale');
const appName = (path) => path.replace(/\/$/, '').split('/').pop().replace(/\.app$/, '');
const AGENT_RE = new RegExp(`(^|[\\s/])(${AGENTS.join('|')})(\\s|$)`);
const sup = (n) => String(n).split('').map((d) => SUP[d]).join('');
const tilde = (p) => p.replace(/^\/Users\/[^/]+/, '~');
const ago = (sec) => {
  const s = Math.max(0, Date.now() / 1000 - sec);
  return s < 90 ? 'just now' : s < 5400 ? `${Math.round(s / 60)}m ago` : s < 129600 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
};
const spark = (vals, max = 100) => vals.map((v) => SPARK[Math.max(0, Math.min(7, Math.round((v / (max || 1)) * 7)))]).join('');
const bytes = (n) => (n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`);


// --- agent state from the bottom of a pane ------------------------------------------
// Approval prompts (Claude Code / Codex / generic y/n), and "working" markers
// so a working → idle transition reads as "finished".
const APPROVAL = /do you want to (proceed|make this edit|create|run|allow)|would you like to (run|make|apply|allow)|allow (this|command|once)|yes, proceed|\(y\/n\)|\[y\/n\]|press enter to (confirm|continue)/i;
// (agy shows only a braille spinner while it edits: "⣟  Editing files...")
const WORKING = /esc to interrupt|\(esc to cancel|working \(|thinking…|thinking\.\.\.|^\s*[⠁-⣿]\s+\S/im;
// A multiple-choice prompt at the bottom of a pane (Claude Code, Codex, Gemini /
// agy, Kimi…): a cursor line (❯ › > ▶ ➤, or ● on numbered lists) plus sibling
// options whose text starts in the same column. Box borders are blanked first
// so dialogs drawn in │…│ frames parse the same. Returns
// { question, options: [{ label }], cursor, sig } or null.
const POINTER = /^(\s*)(❯|›|>|▶|➤|→|●)\s+(\S.*)$/;
const NUMBERED = /^\(?\d{1,2}[.)]\s+/;
const HINT = /navigate|enter to|enter (select|confirm)|esc to|to (select|confirm|cancel)\b/i; // key hints under a menu, not options
export function parseDecision(raw) {
  const lines = raw.split('\n').slice(-40).map((l) => l.replace(/^(\s*)[│┃║]/, '$1 ').replace(/\s*[│┃║]\s*$/, '').trimEnd());
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  const text = (l, col) => (l.length > col && /^\s*$/.test(l.slice(0, col)) && /\S/.test(l[col]) ? l.slice(col) : null);
  for (let c = lines.length - 1; c >= Math.max(0, lines.length - 30); c--) {
    const m = lines[c].match(POINTER);
    if (!m) continue;
    const col = m[1].length + lines[c].slice(m[1].length).match(/^\S+\s+/)[0].length; // where option text starts
    const opts = [{ line: c, label: m[3] }];
    // siblings: same text column. A deeper-indented line under a long (wrapped)
    // option continues it; under a short one it's a description (Claude's
    // questions), left out.
    const numbered = NUMBERED.test(m[3]);
    const sibling = (i) => {
      const t = text(lines[i], col);
      if (t !== null) return /^[└├│─╰╭…]/.test(t) || HINT.test(t) || (numbered && !NUMBERED.test(t)) ? false : t;
      if (lines[i].trim() && /^\s*$/.test(lines[i].slice(0, col + 1))) return i > 0 && lines[i - 1].length >= 60 ? 'cont' : 'desc';
      // hard-wrapped by the agent itself (agy wraps long options to column 0)
      if (i > 0 && lines[i - 1].length >= 60 && lines[i].trim() && !POINTER.test(lines[i]) && !/^\s*[?▸●•⏺✻─━═╭╰]/.test(lines[i])) return 'cont';
      return false;
    };
    // a gap the menu continues across: blank lines between options (kimi), or a
    // divider before a last numbered option (Claude's "5. Chat about this")
    const gap = (i, step) => {
      const next = lines[i + step] === undefined ? false : sibling(i + step);
      if (typeof next !== 'string') return false;
      return !lines[i].trim() || (numbered && /^\s*[─━═╌]{3,}\s*$/.test(lines[i]));
    };
    let group = 0; // blank-separated groups, for kimi's option + description pairs
    let wrapped = []; // continuation lines seen while scanning up, for the option above them
    for (let i = c - 1; i >= 0; i--) {
      const t = sibling(i);
      if (t === false) { if (gap(i, -1)) { if (!lines[i].trim()) group--; continue; } break; }
      if (t === 'desc') continue;
      if (t === 'cont') { wrapped.unshift(lines[i].trim()); continue; }
      opts.unshift({ line: i, label: [t, ...wrapped].join(' '), group });
      wrapped = [];
    }
    opts.at(-1).group = 0;
    group = 0;
    for (let i = c + 1; i < lines.length; i++) {
      const t = sibling(i);
      if (t === false) { if (gap(i, 1)) { if (!lines[i].trim()) group++; continue; } break; }
      if (t === 'desc') continue;
      if (t === 'cont') { opts.at(-1).label += ` ${lines[i].trim()}`; continue; }
      opts.push({ line: i, label: t, group });
    }
    // every blank-separated group is an option and its description: keep the option
    const groups = Object.groupBy(opts, (o) => o.group);
    if (Object.keys(groups).length > 1 && Object.values(groups).every((g) => g.length === 2)) {
      opts.splice(0, opts.length, ...Object.values(groups).map((g) => g[0]).sort((a, b) => a.line - b.line));
    }
    const cursorIdx = opts.findIndex((o) => o.line === c || (o.group === 0 && opts.every((p) => p.line !== c)));
    if (opts.length < 2 || opts.length > 12) continue;
    // a live menu is the last thing on screen: below it only hints, rules and footers.
    // Agent output, a working status or an input prompt below means it's history
    // (codex echoes past messages with "›").
    const after = lines.slice(opts.at(-1).line + 1).map((l) => l.trim()).filter((l) => l && !/^[─━═╭╮╰╯┌┐└┘-]+$/.test(l));
    if (after.length > 6 || after.some((l) => /^[•⏺✻✶✢▸●»❯›>]\s/.test(l) || WORKING.test(l))) continue;
    // ● is also a bullet (tool calls, list items): only trust it on numbered menus
    if (m[2] === '●' && !opts.every((o) => NUMBERED.test(o.label))) continue;
    if (!opts.some((o) => NUMBERED.test(o.label)) && opts.some((o) => lines[o.line].trim().length > 160)) continue; // prose, not a menu
    // the question: the first sentence ending in "?" in the text block above the
    // menu (up to a divider or an agent bullet). Taking the topmost skips the
    // explanation under it and codex's "Reason: … with network access?".
    let question = '';
    let nearest = '';
    let command = ''; // what codex asks to run ("$ git push …")
    let ruled = false; // a divider straight above the "options": an input box or echoed message
    for (let i = opts[0].line - 1; i >= Math.max(0, opts[0].line - 12); i--) {
      const t = lines[i].trim();
      if (/^[─━═╌┄╭╰┌└-]{3,}/.test(t)) { if (!nearest) ruled = true; break; }
      if (!t) continue;
      if (/^[•⏺●▸❯›»>]\s/.test(t)) break;
      if (!nearest) nearest = t;
      if (/^\$ /.test(t)) command = t;
      const q = t.replace(/^\?\s+/, "").match(/^.*?\?(?=\s|$)/);
      if (q) question = q[0];
    }
    question = question.replace(/^Question \d+\/\d+:\s*/, '');
    if (question && command) question += ` ${command}`;
    // unnumbered lists need a real question above them
    if (!numbered && (ruled || !(question || /:\s*$/.test(nearest)))) continue;
    if (!question) question = nearest;
    const options = opts.map((o) => ({ label: clean(o.label).join(' ').trim() }));
    const q = clean(question).join(' ').trim().replace(/^\?\s*/, '');
    return { question: q || 'Choose an option', options, cursor: cursorIdx, sig: JSON.stringify([q, options.map((o) => o.label)]) };
  }
  return null;
}

// What the agent last said, in one line (for "finished" alerts and agent
// subtitles). Harness-agnostic: codex's "↳ Recap:" if there is one, else the
// last message bullet that isn't a tool call (• codex/kimi, ⏺ claude, ● agy/
// gemini) with its wrapped lines joined, else the last line that isn't chrome.
const MESSAGE = /^[•⏺●]\s+(\S.*)$/;
// tool calls and their summaries, not things the agent said
const TOOL = /^(Ran|Explored|Edited|Read|Interacted|Updated|Searched|Listed|Called|Waited|Wrote|Added|Deleted|Created)\b|^[\w.-]+\(/;
const joinPara = (lines, from) => {
  const out = [lines[from]];
  for (let i = from + 1; i < lines.length && /^\s+\S/.test(lines[i]) && !/^\s*[└⎿]/.test(lines[i]); i++) out.push(lines[i].trim());
  return out.join(' ');
};
const oneLine = (text) => clean(text).join(' ').replace(/\s+/g, ' ').trim().slice(0, 140);
// footers and hints under the input box (agy/gemini/claude/codex)
const FOOTER = /^(esc to cancel|\? for shortcuts)\b|· (high|medium|low)$|no sandbox|^~\/\S*\s{2,}/i;
// Claude Code's feedback survey under its answer: not something it said
const SURVEY = /^\s*●\s+How is Claude doing\b|^\s*1: Bad\s+2: Fine\b/;
export function lastLine(screen) {
  const lines = screen.split('\n').map((l) => (SURVEY.test(l) ? '' : l.trimEnd()));
  // whichever is later: a recap quoted in some other output must not win over a newer message
  const recap = lines.findLastIndex((l) => /^\s*↳ Recap:/.test(l));
  const msg = lines.findLastIndex((l) => MESSAGE.test(l) && !TOOL.test(l.match(MESSAGE)[1]) && !/^[•⏺●]\s+Queued follow-up/.test(l) && !WORKING.test(l));
  if (recap >= 0 && recap > msg) return oneLine(joinPara(lines, recap).replace(/^\s*↳ Recap:\s*/, ''));
  if (msg >= 0) return oneLine(joinPara(lines, msg).replace(/^[•⏺●]\s+/, ''));
  // the input box at the bottom (between dividers) holds your own or queued text, not the agent's
  const box = lines.findIndex((l, i) => i >= lines.length - 15 && /^\s*[─━═]{10,}/.test(l));
  const top = box >= 0 ? lines.slice(0, box) : lines;
  // the last line that's something the agent said: not chrome, and not inside a
  // tool call's raw output (agy's "● Bash(curl …)" then output indented 4, or
  // Claude's "⎿"; codex's one-line "└ Read x.py" summaries stay)
  const said = [];
  let tool = -1; // indent of the tool call whose output we're in
  top.forEach((raw, i) => {
    const indent = raw.match(/^\s*/)[0].length;
    if (tool >= 0 && (!raw.trim() || indent >= tool + 4 || /^\s*⎿/.test(raw))) return;
    tool = -1;
    const bullet = raw.trim().match(MESSAGE);
    if (bullet && TOOL.test(bullet[1])) { tool = indent; return; }
    const l = clean(raw).join(' ').trim().replace(/^[•●◦·*]\s+/, '');
    if (l && !/^\s*[─━═]{3,}/.test(raw) && !/^\s*[⠀-⣿]/.test(raw) && !/^[»❯>›]/.test(l) && !/^[─━═-]{3,}/.test(l)
      && !/shortcuts|to queue message|Press up to edit|alt\+m|context left|tab to|Queued follow-up|to answer$|^\+ (Show details|\d+ lines?)|ctrl\+o to expand|background terminal|\/ps to view|auto mode|\/artifact to review|^\d+ tokens$|^Tip:/i.test(l) && !FOOTER.test(l)
      && !WORKING.test(l) && !/^(Working|Thinking|Compacting)\b.*\(\d/.test(l) && !/^\S+ for \d+[smh]/.test(l) // spinner/status lines ("Brewed for 5s · done", "Sautéed for 11s")
      && !/· ~\/|^(GPT|gpt|o\d|Gemini|Claude|Opus|Sonnet|Haiku|Fable|Kimi)[-\s].*·/.test(l)) said.push({ i, indent, l, bullet: /^\s*[•●◦·*]\s/.test(raw) });
  });
  if (!said.length) return '';
  // with the rest of its paragraph: earlier wrapped lines at the same indent, back to a bullet
  let k = said.length - 1;
  while (k > 0 && !said[k].bullet && said[k - 1].i === said[k].i - 1 && top[said[k - 1].i].length >= 60
    && (said[k - 1].indent === said[k].indent || (said[k - 1].bullet && said[k - 1].indent === said[k].indent - 2))) k--;
  return oneLine(said.slice(k).map((s) => s.l).join(' '));
}

// The model and effort an agent runs with, from its own footer: codex
// "GPT-6.1-Sol ultra · ~/Documents · …", agy "auto · Gemini 4 Argon · high",
// kimi "K3 thinking: high". Claude Code doesn't show it: see claudeModel.
export function agentModel(agent, screen) {
  const tail = screen.split('\n').map((l) => l.trim()).filter(Boolean).slice(-8);
  if (agent === 'codex') return tail.findLast((l) => /^\S[^·]*\s·\s+[~/]/.test(l))?.split(/\s+·\s+/)[0] ?? '';
  if (agent === 'agy') {
    const parts = tail.findLast((l) => /·\s+(low|medium|high|xhigh|max)$/.test(l))?.split(/\s+·\s+/);
    return parts && parts.length >= 3 ? parts.slice(-2).join(' ') : '';
  }
  if (agent === 'kimi') { const m = screen.match(/\b(K\d[\w.-]*) thinking: (\w+)/); return m ? `${m[1]} ${m[2]}` : ''; }
  return '';
}

// Claude Code: the model of the newest reply in the newest session started in
// this folder (~/.claude/projects/<folder with - for />/*.jsonl), and the
// effort level from its settings
export function claudeModel(cwd, home = HOME) {
  try {
    const dir = join(home, '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
    const newest = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0];
    if (!newest) return '';
    const fd = openSync(join(dir, newest.f), 'r');
    const size = statSync(join(dir, newest.f)).size;
    const buf = Buffer.alloc(Math.min(size, 256 * 1024));
    readSync(fd, buf, 0, buf.length, size - buf.length);
    closeSync(fd);
    const id = [...buf.toString('utf8').matchAll(/"model":"([^"<][^"]*)"/g)].at(-1)?.[1];
    if (!id) return '';
    // claude-opus-5-5 → Opus 5.5; a proxied "claude-proxy/codex/gpt-6.1-sol" → gpt-6.1-sol
    const last = id.split('/').at(-1);
    const name = /^claude-[a-z]+-\d/.test(last) ? last.slice(7).replace(/-(\d+)-(\d+)(?=-|$)/, ' $1.$2').replace(/^\w/, (c) => c.toUpperCase()) : last;
    let effort = '';
    try { effort = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')).effortLevel ?? ''; } catch {}
    return [name, effort].filter(Boolean).join(' ');
  } catch { return ''; }
}

export function paneState(raw) {
  const lines = raw.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim()).slice(-25);
  const tail = lines.join('\n');
  const decision = parseDecision(raw);
  if (decision) return { state: 'approval', detail: decision.question, decision };
  // codex parks its questions behind the input box until you open them
  if (/\d+ questions?\s*\n.*⇧← to answer/.test(tail)) return { state: 'approval', detail: 'Has a question for you', key: 'open' };
  if (APPROVAL.test(tail)) {
    const q = [...lines].reverse().find((l) => /\?\s*$/.test(l.trim())) || lines.find((l) => APPROVAL.test(l)) || '';
    // Codex marks its yes option "(y)"; Claude Code's menu takes "1"; else y + Enter
    const key = /\(y\)/.test(tail) ? 'y' : /^\s*(❯|>)?\s*1\.\s*yes/im.test(tail) ? '1' : 'y-enter';
    return { state: 'approval', detail: clean(q).join(' ').trim(), key };
  }
  return { state: WORKING.test(tail) ? 'working' : 'idle' };
}

export function createCrossbar({ run, tmux, onAlert = () => {} }) {
  let index = new Map(); // item id -> item (with action closures) from the latest scan
  const watch = new Map(); // pane -> { agent, state, alert?: { kind, text, key?, at } }
  const cache = new Map(); // key -> { at, value }
  const cached = (key, ms, fn) => {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ms) return hit.value;
    const value = fn();
    value.catch(() => cache.delete(key));
    cache.set(key, { at: Date.now(), value });
    return value;
  };
  const sh = (cmd) => run(`${PATH}\n${cmd}`);

  async function typeInto(pane, text, enter = true) {
    const literal = String(text).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 2000);
    await run([`T=${tmux}`, `$T send-keys -t ${sq(pane)} -l -- ${sq(literal)}`, ...(enter ? ['sleep 0.3', `$T send-keys -t ${sq(pane)} Enter`] : [])].join(' && '));
  }

  async function startAgent(agent, cwd) {
    const pane = (await run([
      `T=${tmux}`,
      `$T has-session -t ${SESSION} 2>/dev/null || $T new-session -d -s ${SESSION}`,
      `P=$($T new-window -d -P -F '#{session_name}:#{window_index}.#{pane_index}' -t ${SESSION}: -n ${sq(cwd ? `${agent}:${basename(cwd)}` : agent)}${cwd ? ` -c ${sq(cwd)}` : ''})`,
      // typed into a fresh login shell so the user's PATH and aliases apply
      `sleep 0.5; $T send-keys -t "$P" -l ${agent}; $T send-keys -t "$P" Enter`,
      'echo "$P"',
    ].join('; '))).trim();
    return { view: `pane:${pane}`, message: `started ${agent} in ${pane}` };
  }

  // --- answering prompts ------------------------------------------------------------------
  // Re-reads the pane and only answers if the same prompt (sig) is still up;
  // moves the menu cursor with arrows from where it is now, then Enter.
  async function answer(pane, index, sig) {
    const d = parseDecision(await run(`${tmux} capture-pane -p -J -t ${sq(pane)}`));
    if (!d || d.sig !== sig) throw new Error('that prompt has changed, look again');
    const opt = d.options[index];
    if (!opt) throw new Error('no such option');
    const delta = index - d.cursor;
    // one key per send: some TUIs drop arrows that arrive in a single read
    const moves = Array(Math.abs(delta)).fill(`$T send-keys -t ${sq(pane)} ${delta > 0 ? 'Down' : 'Up'}; sleep 0.08; `).join('');
    await run(`T=${tmux}; ${moves}sleep 0.15; $T send-keys -t ${sq(pane)} Enter`);
    const w = watch.get(pane);
    if (w) w.alert = undefined;
    return { message: `chose: ${opt.label.slice(0, 60)}` };
  }
  const optionLabel = (l) => l.replace(/^\(?\d{1,2}[.)]\s+/, '').replace(/\s+\((y|a|n|esc)\)$/i, '');
  const optionActions = (pane, d) => d.options.map((o, i) => ({
    id: `opt:${i}`, label: optionLabel(o.label), run: () => answer(pane, i, d.sig),
  }));
  const escIt = (pane) => ({ id: 'esc', label: 'Dismiss', run: async () => { await run(`${tmux} send-keys -t ${sq(pane)} Escape`); return { message: 'Esc sent' }; } });

  // Keys the glasses key strip / phone buttons may send to the pane being viewed.
  const KEYS = { up: 'Up', down: 'Down', left: 'Left', right: 'Right', enter: 'Enter', esc: 'Escape', tab: 'Tab', 'shift-tab': 'BTab',
    space: 'Space', bspace: 'BSpace', 'ctrl-c': 'C-c', 1: '1', 2: '2', 3: '3', 4: '4', y: 'y', n: 'n' };
  async function sendKey(pane, key) {
    const k = KEYS[key];
    if (!k) throw new Error('unknown key');
    await run(`${tmux} send-keys -t ${sq(pane)} ${k}`);
  }

  // --- agents: panes + their state (also the "Needs you" watcher) ------------------
  async function scanPanes() {
    const out = await run([
      `T=${tmux}`,
      `$T list-panes -a -F '#{session_name}:#{window_index}.#{pane_index}\t#{window_name}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_tty}' 2>/dev/null | ` +
      `while IFS=$(printf '\\t') read -r id name cmd path tty; do printf '__P__\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$id" "$name" "$cmd" "$path" "$(ps -o args= -t "\${tty#/dev/}" | tr '\\n' ' ')"; ` +
      // visible screen only: agents redraw in place, scrollback holds stale prompts
      `$T capture-pane -p -J -t "$id" 2>/dev/null | tail -n 40; done`,
      'true',
    ].join('\n'));
    const panes = [];
    for (const block of out.split('__P__\t').slice(1)) {
      const nl = block.indexOf('\n');
      const [id, name, cmd, path = '', procs = ''] = block.slice(0, nl).split('\t');
      panes.push({ id, name, cmd, path, agent: procs.match(AGENT_RE)?.[2], screen: block.slice(nl + 1) });
    }
    // watcher: approval prompts, and working → idle ("finished")
    const fresh = [];
    const now = Date.now();
    for (const p of panes) {
      if (!p.agent) continue;
      const st = paneState(p.screen);
      const prev = watch.get(p.id);
      let alert = prev?.alert;
      if (st.state === 'approval') {
        if (alert?.kind !== 'approval' || alert.text !== st.detail || alert.decision?.sig !== st.decision?.sig) {
          alert = { kind: 'approval', text: st.detail, key: st.key, decision: st.decision, at: now };
          fresh.push({ pane: p.id, agent: p.agent, ...alert });
        }
      } else if (alert?.kind === 'approval') alert = undefined; // answered on the Mac
      if (prev?.state === 'working' && st.state === 'idle') {
        const last = lastLine(p.screen);
        alert = { kind: 'finished', text: last, at: now };
        fresh.push({ pane: p.id, agent: p.agent, ...alert });
      }
      if (st.state === 'working' && alert?.kind === 'finished') alert = undefined;
      watch.set(p.id, { agent: p.agent, state: st.state, alert, since: prev && prev.state === st.state ? prev.since : now, last: lastLine(p.screen) });
    }
    for (const id of watch.keys()) if (!panes.some((p) => p.id === id)) watch.delete(id);
    if (fresh.length) onAlert(fresh); // from whichever scan saw it first
    return { panes, fresh };
  }
  // the agent's latest real output line (skips its input box, footers, rules)
  const dur = (ms) => { const m = Math.floor((Date.now() - ms) / 60000); return m < 1 ? '' : m < 60 ? ` · ${m} min` : ` · ${Math.floor(m / 60)} hr${m % 60 ? ` ${m % 60} min` : ''}`; };
  const STATE = { working: 'Working', idle: 'Idle', approval: 'Needs approval' };
  const alerts = () => [...watch.entries()].filter(([, w]) => w.alert).map(([pane, w]) => ({ pane, agent: w.agent, ...w.alert }));

  // --- cached slow sources ---------------------------------------------------------------
  const projects = () => cached('projects', 60_000, async () => {
    const roots = REPO_ROOTS.map((d) => `"$HOME/${d}"`).join(' ');
    const out = await sh(`for g in $(find ${roots} -maxdepth 3 -name .git -type d -not -path '*/.*/.git' 2>/dev/null); do r=\${g%/.git}; ` +
      `printf '%s\\t%s\\t%s\\t%s\\t%s\\n' "$r" "$(git -C "$r" rev-parse --abbrev-ref HEAD 2>/dev/null)" "$(git -C "$r" status --porcelain 2>/dev/null | wc -l | tr -d ' ')" ` +
      `"$(git -C "$r" log -1 --format='%ct|%s' 2>/dev/null)" "$(git -C "$r" rev-list --left-right --count @{u}...HEAD 2>/dev/null | tr '\\t' ' ')"; done`);
    return out.split('\n').filter(Boolean).map((l) => {
      const [path, branch, dirty, last = '', ab = ''] = l.split('\t');
      const [ct, ...subj] = last.split('|');
      const [behind, ahead] = ab.split(' ').map(Number);
      return { path, branch, dirty: Number(dirty), time: Number(ct) || 0, subject: subj.join('|'), behind, ahead };
    }).sort((a, b) => b.time - a.time);
  });

  const notes = () => cached('notes', 60_000, async () => {
    const vaults = settings().vaults.map((v) => sq(v)).join(' ');
    const out = await sh(`find ${vaults} -name '*.md' -not -path '*/.obsidian/*' -not -path '*/.trash/*' -type f -exec stat -f '%m\t%N' {} + 2>/dev/null | sort -rn | head -60`);
    return out.split('\n').filter(Boolean).map((l) => { const [m, path] = l.split('\t'); return { path, mtime: Number(m) }; });
  });

  const tailnet = () => cached('tailnet', 15_000, async () => {
    const j = JSON.parse(await sh(`${tailscaleBin()} status --json 2>/dev/null`));
    const me = j.Self?.UserID;
    // only this user's own devices (other people share the tailnet)
    return [j.Self, ...Object.values(j.Peer || {})].filter((d) => d && d.UserID === me).map((d) => ({
      // DNS name, not HostName: iPhones report HostName "localhost"
      name: d.DNSName?.split('.')[0] || d.HostName, os: d.OS,
      ip: d.TailscaleIPs?.[0], online: d === j.Self || !!d.Online, self: d === j.Self,
      seen: d.LastSeen && !d.LastSeen.startsWith('0001') ? Date.parse(d.LastSeen) / 1000 : 0,
    })).sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  });

  const containers = () => cached('docker', 10_000, async () => {
    const out = await sh(`docker ps -a --format '{{.Names}}\t{{.State}}\t{{.Status}}\t{{.Image}}' 2>/dev/null || true`);
    return out.split('\n').filter(Boolean).map((l) => { const [name, state, status, image] = l.split('\t'); return { name, running: state === 'running', status, image }; });
  });

  // Spotify over Apple Events: needs a one-time Automation approval on the Mac.
  const music = () => cached('music', 2000, async () => {
    const out = await sh(`osascript -e 'with timeout of 4 seconds' -e 'tell application "Spotify"' -e 'set t to current track' ` +
      `-e 'return (player state as text) & tab & (name of t) & tab & (artist of t) & tab & (album of t) & tab & (player position as integer) & tab & ((duration of t) div 1000) & tab & sound volume & tab & shuffling' ` +
      `-e 'end tell' -e 'end timeout' 2>&1 || true`);
    if (/-1743|not allowed|Not authorized/i.test(out)) return { error: 'permission' };
    if (/-1712|timed out/i.test(out)) return { error: 'waiting' };
    const [state, track, artist, album, pos, dur, vol, shuffle] = out.trim().split('\t');
    if (!track) return { error: out.trim().slice(0, 80) || 'nothing playing' };
    return { state, track, artist, album, pos: Number(pos), dur: Number(dur), vol: Number(vol), shuffle: shuffle === 'true' };
  });
  function musicHint(err) {
    if (err === 'permission') return 'Spotify control is blocked: on the Mac, System Settings › Privacy & Security › Automation › node › allow Spotify.';
    if (err === 'waiting') return 'Waiting for permission: click Allow on the "node wants to control Spotify" prompt on the Mac screen.';
    return err;
  }

  // --- live views (glasses / phone / TUI): id -> { label, lines, top? } ---------------
  const history = { cpu: [], gpu: [], mem: [], rx: [], tx: [] };
  let netPrev = null;
  const vitals = () => cached('vitals', 1800, async () => {
    const out = await sh([
      "echo CPU $(ps -A -o %cpu= | awk '{s+=$1} END {print s}') $(sysctl -n hw.ncpu)",
      "echo GPU $(ioreg -r -d 1 -w 0 -c IOAccelerator | grep -o '\"Device Utilization %\"=[0-9]*' | head -1 | cut -d= -f2)",
      "echo MEM $(sysctl -n hw.memsize) $(vm_stat | awk '/page size of/ {ps=$8} /Pages active/ {a=$3} /Pages wired/ {w=$4} /occupied by compressor/ {c=$5} END {print (a+w+c)*ps}')",
      "IF=$(route -n get default 2>/dev/null | awk '/interface:/ {print $2}'); echo NET $(netstat -ibn -I \"$IF\" | awk 'NR==2 {print $7, $10}')",
      "echo LOAD $(sysctl -n vm.loadavg | tr -d '{}')",
      "echo DISK $(df -k / | awk 'NR==2 {print $4*1024, $2*1024}')",
    ].join('\n'));
    const v = Object.fromEntries(out.split('\n').filter(Boolean).map((l) => { const [k, ...r] = l.trim().split(/\s+/); return [k, r]; }));
    const push = (k, x) => { history[k].push(x); if (history[k].length > 24) history[k].shift(); };
    const cpu = Math.min(100, Number(v.CPU?.[0]) / Number(v.CPU?.[1] || 1));
    push('cpu', cpu);
    push('gpu', Number(v.GPU?.[0]) || 0);
    const memTotal = Number(v.MEM?.[0]), memUsed = Number(v.MEM?.[1]);
    push('mem', (memUsed / memTotal) * 100);
    const [ib, ob] = (v.NET || []).map(Number);
    let rx = 0, tx = 0;
    if (netPrev && ib >= netPrev.ib) { const dt = (Date.now() - netPrev.at) / 1000; rx = (ib - netPrev.ib) / dt; tx = (ob - netPrev.ob) / dt; }
    netPrev = { ib, ob, at: Date.now() };
    push('rx', rx); push('tx', tx);
    const netMax = Math.max(...history.rx, ...history.tx, 1);
    const [free, size] = (v.DISK || []).map(Number);
    return {
      label: 'Mac vitals', lines: [
        `CPU  ${spark(history.cpu)} ${Math.round(cpu)}%`,
        `GPU  ${spark(history.gpu)} ${history.gpu.at(-1)}%`,
        `MEM  ${spark(history.mem)} ${Math.round(history.mem.at(-1))}%  ${bytes(memUsed)} / ${bytes(memTotal)}`,
        `NET↓ ${spark(history.rx, netMax)} ${bytes(rx)}/s`,
        `NET↑ ${spark(history.tx, netMax)} ${bytes(tx)}/s`,
        `LOAD ${(v.LOAD || []).join(' ')}`,
        `DISK ${bytes(free)} free of ${bytes(size)}`,
      ],
    };
  });

  const bar = (frac, n = 24) => '━'.repeat(Math.round(frac * n)) + '─'.repeat(n - Math.round(frac * n));
  const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  async function view(id) {
    if (id.startsWith('pane:')) {
      const pane = id.slice(5);
      const out = await run(`T=${tmux}; $T display -p -t ${sq(pane)} '#{window_name}' 2>/dev/null || echo __GONE__; echo __G2__; $T capture-pane -p -J -t ${sq(pane)} -S -300 2>/dev/null; true`);
      const [head, body = ''] = out.split('__G2__\n');
      if (head.includes('__GONE__')) return { label: `${pane} (closed)`, lines: ['That pane has closed.'] };
      return { label: head.trim() || pane, lines: clean(body), decision: parseDecision(body) ?? undefined };
    }
    if (id === 'vitals') return vitals();
    if (id === 'music') {
      const m = await music();
      if (m.error) return { label: 'Spotify', lines: [musicHint(m.error)] };
      return { label: `Spotify · ${m.state}`, lines: [m.track, m.artist, m.album, '', `${bar(m.dur ? m.pos / m.dur : 0)} ${mmss(m.pos)} / ${mmss(m.dur)}`, '', `volume ${m.vol}%${m.shuffle ? ' · shuffle' : ''}`] };
    }
    if (id === 'clip') {
      const out = await run('pbpaste 2>/dev/null | head -c 4000');
      return { label: 'Mac clipboard', lines: out.trim() ? clean(out) : ['(clipboard is empty)'], top: true };
    }
    if (id.startsWith('log:')) {
      const path = id.slice(4);
      if (!settings().logs.includes(path)) return { label: 'log', lines: ['not a configured log'] };
      return { label: basename(path), lines: clean(await run(`tail -n 200 ${sq(path)} 2>&1`)) };
    }
    if (id.startsWith('dlog:')) {
      const name = id.slice(5);
      if (!(await containers()).some((c) => c.name === name)) return { label: name, lines: ['no such container'] };
      return { label: `docker logs ${name}`, lines: clean(await sh(`docker logs --tail 200 ${sq(name)} 2>&1`)) };
    }
    if (id.startsWith('diff:')) {
      const path = id.slice(5);
      if (!(await projects()).some((p) => p.path === path)) return { label: 'diff', lines: ['not a known project'] };
      const out = await sh(`cd ${sq(path)} && git status -sb && echo && git diff --stat HEAD 2>/dev/null | tail -n 40 && echo && git log --oneline -8`);
      return { label: `${basename(path)} changes`, lines: clean(out), top: true };
    }
    if (id.startsWith('note:')) {
      const path = id.slice(5);
      if (!(await notes()).some((n) => n.path === path)) return { label: 'note', lines: ['not a known note'] };
      const md = (await run(`cat ${sq(path)}`))
        .replace(/^---\n[\s\S]*?\n---\n/, '')                        // front matter
        .replace(/!\[\[[^\]]*\]\]|!\[[^\]]*\]\([^)]*\)/g, '')          // embeds / images
        .replace(/\[\[([^\]|]*)\|?([^\]]*)\]\]/g, (_, a, b) => b || a) // wiki links
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')                       // md links
        .replace(/^#{1,6}\s+(.*)$/gm, (_, h) => h.toUpperCase())       // headings
        .replace(/\*\*|__|`/g, '')
        .replace(/^\s*[-*]\s+\[ \]/gm, '  □').replace(/^\s*[-*]\s+\[x\]/gim, '  ■').replace(/^\s*[-*]\s+/gm, '  • ');
      return { label: basename(path, '.md'), lines: clean(md), top: true };
    }
    return { label: id, lines: ['unknown view'] };
  }

  function saveImage(img) {
    if (!img?.data) throw new Error('no image');
    const ext = /png/.test(img.mime) ? 'png' : /heic/.test(img.mime) ? 'heic' : 'jpg';
    const dir = join(ROOT, '.run', 'snaps');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `snap-${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`);
    writeFileSync(path, Buffer.from(String(img.data).replace(/^data:[^,]*,/, ''), 'base64'));
    if (statSync(path).size < 100) throw new Error('image was empty');
    return path;
  }

  // --- the catalog ----------------------------------------------------------------------
  async function scan() {
    const items = new Map();
    const add = (cat, item) => { items.set(item.id, item); cat.items.push(item); };
    const cfg = settings();
    const safe = (p, fallback) => p.catch(() => fallback);
    const [{ panes }, base, projs, noteList, devices, ctrs] = await Promise.all([
      scanPanes(),
      sh([
        'echo __RUNNING__',
        `for a in $(lsappinfo visibleProcessList | grep -oE 'ASN:0x[0-9a-f]+-0x[0-9a-f]+-'); do lsappinfo info -only bundlepath "\${a%-}:"; done | sed -n 's/.*="\\(.*\\)"/\\1/p'`,
        'echo __APPS__',
        // find, not globs: zsh (the login shell over ssh) aborts on a glob with no match
        `find ${APP_DIRS.join(' ')} -maxdepth 1 -name '*.app' ! -name '.*' 2>/dev/null`,
        'echo __SYS__',
        'sysctl -n vm.loadavg', 'uptime', 'df -h / | tail -1',
        `osascript -e 'set v to get volume settings' -e '(output volume of v as text) & " " & (output muted of v as text)' 2>/dev/null`,
        'echo __CLIP__', 'pbpaste 2>/dev/null | head -c 200 | tr "\\n\\t" "  "; echo',
        'true',
      ].join('\n')),
      safe(projects(), []), safe(notes(), []), safe(tailnet(), []), safe(containers(), []),
    ]);
    const parts = {};
    let cur = '';
    for (const line of base.split('\n')) {
      const m = line.match(/^__([A-Z]+)__$/);
      if (m) cur = m[1];
      else if (cur && line) (parts[cur] ||= []).push(line);
    }
    const part = (name) => parts[name] || [];
    const agentPanes = panes.filter((p) => p.agent);

    // ※ Needs you
    const list = alerts().sort((x, y) => Number(y.kind === 'approval') - Number(x.kind === 'approval') || y.at - x.at);
    const needs = { id: 'needs', label: 'Needs You', icon: `※${list.length ? sup(list.length) : ''}`, items: [] };
    for (const a of list) {
      const viewIt = { id: 'view', label: 'View', run: async () => ({ view: `pane:${a.pane}` }) };
      add(needs, {
        id: `alert:${a.pane}`, label: `${a.agent} ${a.decision || a.key === 'open' ? 'is asking' : a.kind === 'approval' ? 'needs approval' : 'finished'}`, sub: a.text || '', live: a.kind === 'approval', attention: a.kind === 'approval', meta: ago(a.at / 1000),
        actions: a.decision ? [viewIt, ...optionActions(a.pane, a.decision), escIt(a.pane)] : a.key === 'open' ? [
          viewIt,
          // shows codex's question as a menu, which then gets its own options here
          { id: 'open', label: 'Show Question', run: async () => { await run(`${tmux} send-keys -t ${sq(a.pane)} S-Left`); return { message: 'opened' }; } },
        ] : a.kind === 'approval' ? [
          viewIt,
          { id: 'approve', label: 'Approve', confirm: true, run: async () => {
            const k = a.key === '1' ? '1' : 'y';
            await run(`${tmux} send-keys -t ${sq(a.pane)} -l ${k}${a.key === 'y-enter' ? ` && ${tmux} send-keys -t ${sq(a.pane)} Enter` : ''}`);
            return { message: `approved ${a.agent}` };
          } },
          { id: 'deny', label: 'Deny', run: async () => { await run(`${tmux} send-keys -t ${sq(a.pane)} Escape`); return { message: `denied ${a.agent}` }; } },
        ] : [
          viewIt,
          { id: 'dismiss', label: 'Dismiss', run: async () => { const w = watch.get(a.pane); if (w) w.alert = undefined; return { message: 'dismissed' }; } },
        ],
      });
    }
    if (!list.length) add(needs, { id: 'needs:none', label: 'All Quiet', sub: 'Agents that need you show up here', actions: [] });

    // ☉ System
    const sys = { id: 'system', label: 'System', icon: '☉', items: [] };
    add(sys, { id: 'sys:vitals', label: 'Vitals', sub: 'CPU, GPU, memory and network', actions: [{ id: 'view', label: 'View', run: async () => ({ view: 'vitals' }) }] });
    const clip = (part('CLIP')[0] || '').trim();
    add(sys, {
      id: 'sys:clip', label: 'Clipboard', sub: clip ? clip.slice(0, 80) : 'Empty',
      actions: [
        { id: 'view', label: 'View', run: async () => ({ view: 'clip' }) },
        { id: 'set', label: 'Copy From Phone', needs: 'text', run: async (text) => {
          await run(`printf %s ${sq(String(text ?? '').slice(0, 20000))} | pbcopy`);
          return { message: 'copied to the Mac clipboard' };
        } },
        ...agentPanes.map((p) => ({ id: `paste:${p.id}`, label: `Paste Into ${p.agent}`, run: async () => {
          const text = await run('pbpaste 2>/dev/null | head -c 2000');
          if (!text.trim()) return { message: 'clipboard is empty' };
          await typeInto(p.id, text.replace(/\s*\n\s*/g, ' '), false); // left unsent, to review
          return { message: `pasted into ${p.agent}, not sent` };
        } })),
      ],
    });
    const osa = (script, msg) => async () => { await run(`osascript -e ${sq(script)}`); return { message: msg }; };
    const [load = '', up = '', df = '', vol = ''] = part('SYS');
    const [volume, muted] = vol.split(' ');
    if (volume && volume !== 'missing') {
      add(sys, {
        id: 'sys:volume', label: `Volume ${volume}%${muted === 'true' ? ' (muted)' : ''}`, sub: 'Mac audio output',
        actions: [
          { id: 'up', label: 'Volume Up', run: osa('set volume output volume ((output volume of (get volume settings)) + 10)', 'volume up') },
          { id: 'down', label: 'Volume Down', run: osa('set volume output volume ((output volume of (get volume settings)) - 10)', 'volume down') },
          { id: 'mute', label: muted === 'true' ? 'Unmute' : 'Mute', run: osa('set volume output muted (not (output muted of (get volume settings)))', 'mute toggled') },
        ],
      });
    }
    add(sys, { id: 'sys:display', label: 'Display sleep', sub: 'turn the displays off',
      actions: [{ id: 'sleep', label: 'Sleep Displays', run: async () => { await run('pmset displaysleepnow'); return { message: 'displays asleep' }; } }] });
    for (const path of cfg.logs) {
      add(sys, { id: `log:${path}`, label: basename(path), sub: tilde(dirname(path)), actions: [{ id: 'view', label: 'Tail', run: async () => ({ view: `log:${path}` }) }] });
    }
    const dfc = df.split(/\s+/);
    add(sys, { id: 'sys:load', label: `Load ${load.replace(/[{}]/g, '').trim()}`, sub: 'CPU load (1, 5, 15 min)', actions: [] });
    add(sys, { id: 'sys:uptime', label: `Up ${up.match(/up\s+(.*?),\s+\d+ users?/)?.[1].replace(/\s+/g, ' ') ?? '?'}`, sub: 'since last restart', actions: [] });
    if (dfc[3]) add(sys, { id: 'sys:disk', label: `Disk ${dfc[3]} free`, sub: `of ${dfc[1]} on /`, actions: [] });

    // ★ Agents
    const agents = { id: 'agents', label: 'Agents', icon: '★', items: [] };
    for (const p of [...panes].sort((a, b) => Number(!a.agent) - Number(!b.agent))) {
      const keys = (key, msg) => async () => { await run(`${tmux} send-keys -t ${sq(p.id)} ${key}`); return { message: msg }; };
      const w = watch.get(p.id);
      add(agents, {
        // "codex - GPT-6.1-Sol ultra · ~/Documents"
        id: `pane:${p.id}`, label: p.agent ? `${p.agent} - ${[p.agent === 'claude' ? claudeModel(p.path) : agentModel(p.agent, p.screen), p.path.replace(HOME, '~')].filter(Boolean).join(' · ')}` : p.cmd, live: !!p.agent,
        meta: w ? `${w.alert?.decision ? 'Asking' : STATE[w.state] ?? w.state}${dur(w.since)}` : '',
        attention: !!w?.alert && w.alert.kind === 'approval',
        sub: (w?.alert?.kind === 'approval' && w.alert.text) || w?.last || p.name, // the question while it's asking
        actions: [
          { id: 'view', label: 'View', run: async () => ({ view: `pane:${p.id}` }) },
          ...(w?.alert?.decision ? optionActions(p.id, w.alert.decision) : []),
          { id: 'type', label: 'Type…', needs: 'text', run: async (text) => { await typeInto(p.id, String(text ?? '')); return { message: `sent to ${p.agent || p.cmd}` }; } },
          ...(p.agent ? [
            { id: 'ask', label: 'Ask', needs: 'mic', run: async () => ({ ask: { pane: p.id, agent: p.agent } }) },
            { id: 'snap', label: 'Snap a Photo', needs: 'camera', run: async (img) => ({ ask: { pane: p.id, agent: p.agent, image: saveImage(img) } }) },
            { id: 'album', label: 'Send a Photo', needs: 'album', run: async (img) => ({ ask: { pane: p.id, agent: p.agent, image: saveImage(img) } }) },
            ...cfg.prompts.map((text, i) => ({ id: `prompt:${i}`, label: text[0].toUpperCase() + text.slice(1), run: async () => { await typeInto(p.id, text); return { message: `sent to ${p.agent}` }; } })),
          ] : []),
          { id: 'esc', label: 'Escape', run: keys('Escape', `Esc → ${p.id}`) },
          { id: 'interrupt', label: 'Interrupt', run: keys('C-c', `Ctrl-C → ${p.id}`) },
          // Destructive: clients ask for a second selection before sending it.
          { id: 'kill', label: 'End Agent', confirm: true, run: async () => {
            await run(`${tmux} kill-pane -t ${sq(p.id)}`); // closes its window too if it was the only pane
            return { message: `ended ${p.agent || p.cmd} (${p.id})` };
          } },
        ],
      });
    }
    for (const a of AGENTS) {
      add(agents, { id: `new:${a}`, label: `New ${a[0].toUpperCase()}${a.slice(1)}`, sub: `Starts in tmux “${SESSION}”`, actions: [{ id: 'start', label: `Start ${a}`, run: () => startAgent(a) }] });
    }

    // ▣ Projects
    const projCat = { id: 'projects', label: 'Projects', icon: '▣', items: [] };
    for (const r of projs) {
      const ab = [r.ahead ? `↑${r.ahead}` : '', r.behind ? `↓${r.behind}` : ''].filter(Boolean).join(' ');
      add(projCat, {
        id: `proj:${r.path}`, label: basename(r.path), live: r.dirty > 0,
        meta: [r.dirty ? `±${r.dirty}` : '', r.ahead ? `↑${r.ahead}` : '', r.behind ? `↓${r.behind}` : ''].filter(Boolean).join(' ') || (r.time ? ago(r.time) : ''),
        sub: `${r.branch}${r.dirty ? ` · ${r.dirty} changed` : ''}${ab ? ` · ${ab}` : ''} · ${r.time ? ago(r.time) : ''}: ${r.subject}`,
        actions: [
          ...settings().newAgents.map((a) => ({ id: a, label: `New ${a[0].toUpperCase()}${a.slice(1)} Here`, run: () => startAgent(a, r.path) })),
          { id: 'diff', label: 'Changes', run: async () => ({ view: `diff:${r.path}` }) },
          { id: 'pull', label: 'Pull', confirm: true, run: async () => {
            const out = await sh(`git -C ${sq(r.path)} pull --ff-only 2>&1 | tail -1`);
            cache.delete('projects');
            return { message: out.trim().slice(0, 80) || 'pulled' };
          } },
        ],
      });
    }

    // ● Running / ◆ Apps
    const running = new Set(part('RUNNING').map((p) => p.replace(/(\.app)\/.*$/, '$1')));
    const quit = (path) => async () => {
      // Graceful Apple Event quit (apps can still ask to save); path via argv.
      await run(`osascript -e 'on run argv' -e 'tell application (item 1 of argv) to quit' -e 'end run' ${sq(path)}`);
      return { message: `quit ${appName(path)}` };
    };
    const open = (path) => async () => { await run(`open -a ${sq(path)}`); return { message: `opened ${appName(path)}` }; };
    const appItem = (prefix, path) => ({
      id: `${prefix}:${path}`, label: appName(path), sub: path.replace(/\/[^/]+$/, ''), live: running.has(path), meta: running.has(path) ? 'running' : '',
      actions: [
        { id: 'open', label: running.has(path) ? 'Bring to Front' : 'Open', run: open(path) },
        ...(running.has(path) ? [{ id: 'quit', label: 'Quit', run: quit(path) }] : []),
      ],
    });
    const byName = (a, b) => appName(a).localeCompare(appName(b), 'en', { sensitivity: 'base' });
    const runningCat = { id: 'running', label: 'Running', icon: '●', items: [] };
    for (const p of [...running].sort(byName)) add(runningCat, appItem('run', p));
    const appsCat = { id: 'apps', label: 'Apps', icon: '◆', items: [] };
    const seen = new Set();
    for (const p of part('APPS').sort(byName)) {
      if (seen.has(appName(p))) continue; // e.g. Safari in /Applications and /System
      seen.add(appName(p));
      add(appsCat, appItem('app', p));
    }

    // ◎ Music (Spotify)
    const musicCat = { id: 'music', label: 'Music', icon: '◎', items: [] };
    if (![...running].some((p) => appName(p) === 'Spotify')) {
      add(musicCat, { id: 'music:open', label: 'Spotify is not running', sub: 'open it on the Mac',
        actions: [{ id: 'open', label: 'Open Spotify', run: async () => { await run('open -a Spotify'); return { message: 'opening Spotify' }; } }] });
    } else {
      const m = await music().catch((e) => ({ error: e.message }));
      const tell = (cmd, msg) => async () => {
        await sh(`osascript -e 'with timeout of 4 seconds' -e ${sq(`tell application "Spotify" to ${cmd}`)} -e 'end timeout'`);
        cache.delete('music');
        return { message: msg };
      };
      if (m.error) add(musicCat, { id: 'music:error', label: 'Spotify needs permission', sub: musicHint(m.error), actions: [{ id: 'view', label: 'Details', run: async () => ({ view: 'music' }) }] });
      else {
        add(musicCat, {
          id: 'music:now', label: `${m.state === 'playing' ? '▶' : '■'} ${m.track}`, sub: `${m.artist} · ${m.album}`, live: m.state === 'playing', meta: `${mmss(m.pos)}/${mmss(m.dur)}`,
          actions: [
            { id: 'view', label: 'Now Playing', run: async () => ({ view: 'music' }) },
            { id: 'toggle', label: m.state === 'playing' ? 'Pause' : 'Play', run: tell('playpause', 'play/pause') },
            { id: 'next', label: 'Next Track', run: tell('next track', 'next') },
            { id: 'prev', label: 'Previous Track', run: tell('previous track', 'previous') },
          ],
        });
        add(musicCat, {
          id: 'music:vol', label: `Spotify volume ${m.vol}%`, sub: m.shuffle ? 'shuffle on' : 'shuffle off',
          actions: [
            { id: 'up', label: 'Volume Up', run: tell('set sound volume to (sound volume + 10)', 'volume up') },
            { id: 'down', label: 'Volume Down', run: tell('set sound volume to (sound volume - 10)', 'volume down') },
            { id: 'shuffle', label: m.shuffle ? 'Shuffle off' : 'Shuffle on', run: tell(`set shuffling to ${!m.shuffle}`, 'shuffle toggled') },
          ],
        });
      }
    }

    // ⇔ Network: own tailnet devices + Docker containers
    const net = { id: 'network', label: 'Network', icon: '⇔', items: [] };
    for (const d of devices) {
      add(net, {
        id: `dev:${d.name}`, label: `${d.name}${d.self ? ' (this Mac)' : ''}`, live: d.online, meta: d.online ? 'online' : 'offline',
        sub: `${d.os} · ${d.ip}${d.online ? '' : ` · last seen ${d.seen ? ago(d.seen) : '?'}`}`,
        actions: d.self || !d.ip ? [] : [{ id: 'ping', label: 'Ping', run: async () => {
          const out = await sh(`${tailscaleBin()} ping -c 1 --timeout 3s ${sq(d.ip)} 2>&1 | tail -1`);
          return { message: out.trim().slice(0, 80) };
        } }],
      });
    }
    for (const c of ctrs) {
      const dk = (cmd, msg) => async () => { await sh(`docker ${cmd} ${sq(c.name)}`); cache.delete('docker'); return { message: msg }; };
      add(net, {
        id: `ctr:${c.name}`, label: `docker ${c.name}`, sub: `${c.status} · ${c.image}`, live: c.running, meta: c.running ? 'up' : 'stopped',
        actions: [
          { id: 'logs', label: 'Logs', run: async () => ({ view: `dlog:${c.name}` }) },
          ...(c.running ? [
            { id: 'restart', label: 'Restart', confirm: true, run: dk('restart', `restarted ${c.name}`) },
            { id: 'stop', label: 'Stop', confirm: true, run: dk('stop', `stopped ${c.name}`) },
          ] : [{ id: 'start', label: 'Start', run: dk('start', `started ${c.name}`) }]),
        ],
      });
    }

    // ▤ Notes (Obsidian, most recently edited first)
    const notesCat = { id: 'notes', label: 'Notes', icon: '▤', items: [] };
    for (const n of noteList) {
      add(notesCat, { id: `note:${n.path}`, label: basename(n.path, '.md'), meta: ago(n.mtime), sub: tilde(dirname(n.path)),
        actions: [{ id: 'read', label: 'Read', run: async () => ({ view: `note:${n.path}` }) }] });
    }
    if (!noteList.length) add(notesCat, { id: 'notes:none', label: 'No notes found', sub: `vaults: ${cfg.vaults.map(tilde).join(', ')} (set in crossbar.json)`, actions: [] });

    index = items;
    // Needs You right before Agents (where it opens), work next, then the Mac, System last
    return [needs, agents, projCat, notesCat, runningCat, appsCat, musicCat, net, sys];
  }

  return {
    /** Fresh catalog, actions stripped (safe to send to clients). */
    async list() {
      const cats = await scan();
      return cats.map((c) => ({ ...c, items: c.items.map(({ actions, ...i }) => ({ ...i, actions: actions.map(({ id, label, confirm, needs }) => ({ id, label, confirm, needs })) })) }));
    },
    /** Run an action offered by the latest scan: { message?, view?, ask? }. */
    async act(itemId, actionId, arg) {
      const action = index.get(itemId)?.actions.find((a) => a.id === actionId);
      if (!action) throw new Error('no longer available, refresh');
      return action.run(arg);
    },
    /** Live view content: { label, lines, top? }. */
    view,
    /** Cheap agent-only rescan for the watcher; new alerts go to onAlert. */
    async watch() { await scanPanes(); },
    typeInto,
    answer,
    sendKey,
  };
}
