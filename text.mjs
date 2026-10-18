// Terminal text cleanup for the glasses font: shared by both bridges, the
// Crossbar catalog and its TUI. Pure (no I/O).
const HISTORY = Number(process.env.HISTORY || 300);

// --- terminal text cleanup -------------------------------------------------
// TUIs (claude/codex/kimi) draw borders and glyphs the glasses font can't show
// and that waste the tiny display. Keep the words, drop the chrome.
const GLYPHS = { '⏺': '•', '●': '•', '⎿': ' ', '✻': '*', '✳': '*', '❯': '>', '›': '>', '…': '...', '↵': '',
  '✓': '+', '✔': '+', '✗': 'x', '✘': 'x', '→': '->', '←': '<-', '↑': '^', '↓': 'v' };
export function clean(raw) {
  const out = [];
  for (let line of raw.split('\n')) {
    line = line
      .replace(/[─-▟]/g, ' ')            // box drawing + block elements
      .replace(/[⏺●⎿✻✳❯›…↵✓✔✗✘→←↑↓]/g, (c) => GLYPHS[c])
      .replace(/[⠀-⣿]/g, '')             // braille spinners
      .replace(/[\p{So}\p{Cs}]/gu, '')             // remaining symbols/emoji: not in the glasses font
      .replace(/\t/g, '  ')
      .replace(/\s+$/, '');
    const indent = Math.min(line.match(/^ */)[0].length, 2);
    line = ' '.repeat(indent) + line.trim().replace(/ {3,}/g, '  ');
    if (/^\s*Tip: /.test(line)) continue; // Codex's rotating tips ("└ Tip: Run /review …")
    if (!line.trim()) { if (out.length && out[out.length - 1] !== '') out.push(''); continue; }
    out.push(line);
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  // Codex's footer: keep "model · folder", drop "· Enable YOLO mode · …" and the
  // key-hint line under it (only at the bottom, not in scrollback).
  for (let i = out.length - 1; i >= Math.max(0, out.length - 4); i--) {
    const at = out[i].indexOf('Enable YOLO mode');
    if (at < 0) continue;
    const kept = out[i].slice(0, at).replace(/[\s·•]+$/, '');
    out.splice(i, out.length - i, ...(kept.trim() ? [kept] : []));
    while (out.length && out[out.length - 1] === '') out.pop();
    break;
  }
  // Claude Code's footer: "? for shortcuts" and the permission-mode hint line.
  const CLAUDE_HINTS = /\? for shortcuts|shift\+tab to cycle|bypass permissions on|accept edits on|plan mode on/;
  for (let n = 0; n < 4 && out.length; n++) {
    const last = out[out.length - 1];
    if (last === '') out.pop();
    else if (CLAUDE_HINTS.test(last)) out.pop();
    else break;
  }
  return out.slice(-HISTORY);
}

