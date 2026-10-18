// Shared by the bridge (crossbar-server.mjs) and the terminal Crossbar (crossbar-tui.mjs):
// where the bridge listens, who may use it, running commands on this Mac, and
// static files for the web app.
//
// Two modes (CROSSBAR_MODE, written by bin/setup):
//   tailscale (default)  listen on the Mac's tailnet IP; only devices owned by
//                        the same Tailscale user (checked with `tailscale whois`)
//   home                 listen on the home network (reached as <name>.local);
//                        every request needs the pairing code (CROSSBAR_KEY)
// Either way, this Mac itself is also served on 127.0.0.1 (browser, simulator).
import { execFile, execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { timingSafeEqual, createHash } from 'node:crypto';

export const MODE = process.env.CROSSBAR_MODE === 'home' ? 'home' : 'tailscale';
export const TMUX = process.env.CROSSBAR_TMUX || findBin('tmux', ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux']);
const TAILSCALE = process.env.TAILSCALE_BIN || findBin('tailscale', ['/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale']);

function findBin(name, candidates) {
  const hit = candidates.find((p) => existsSync(p));
  if (hit) return hit;
  try { return execFileSync('/bin/sh', ['-c', `command -v ${name}`]).toString().trim() || name; } catch { return name; }
}

// tailscale: the tailnet IPs (IPv4 in 100.64.0.0/10, IPv6 in fd7a:115c:a1e0::/48),
// so the bridge is never on the LAN or public Wi-Fi.
// home: all interfaces (the LAN address changes; <name>.local follows it), behind the pairing code.
const tsIp = (v) => { try { return execFileSync(TAILSCALE, ['ip', v]).toString().trim().split('\n')[0]; } catch { return ''; } };
export const HOST = process.env.BIND || (MODE === 'home' ? '0.0.0.0' : tsIp('-4'));
/** Every address to listen on (tailscale mode also takes the tailnet IPv6 address). */
export const HOSTS = process.env.BIND || MODE === 'home' ? [HOST] : [HOST, tsIp('-6')].filter(Boolean);
const loginOf = (json) => JSON.parse(json).UserProfile.LoginName;
export const OWNER = MODE === 'tailscale' ? loginOf(execFileSync(TAILSCALE, ['whois', '--json', HOST])) : '';
const KEY = process.env.CROSSBAR_KEY || '';
if (MODE === 'home' && KEY.length < 8) throw new Error('home mode needs a pairing code: CROSSBAR_KEY (bin/setup --home makes one)');

/** This Mac's names, for the setup screen: { dns: "mac.tailnet.ts.net" } or { local: "mac.local" }. */
export function addresses() {
  try {
    if (MODE === 'tailscale') return { dns: JSON.parse(execFileSync(TAILSCALE, ['status', '--json']).toString()).Self.DNSName.replace(/\.$/, '') };
    return { local: `${execFileSync('scutil', ['--get', 'LocalHostName']).toString().trim()}.local` };
  } catch { return {}; }
}

const isLoopback = (ip) => ip === '127.0.0.1' || ip === '::1';
const seen = new Map(); // ip -> { ok, at }
function isOwnDevice(ip) {
  const hit = seen.get(ip);
  if (hit && Date.now() - hit.at < 60_000) return Promise.resolve(hit.ok);
  return new Promise((resolve) => {
    execFile(TAILSCALE, ['whois', '--json', ip], { timeout: 5000 }, (err, out) => {
      let ok = false;
      try { ok = !err && loginOf(out) === OWNER; } catch {}
      seen.set(ip, { ok, at: Date.now() });
      resolve(ok);
    });
  });
}
const digest = (s) => createHash('sha256').update(String(s)).digest();
/** The pairing code from ?key= or the cookie the bridge set when the page was opened with it. */
function keyOf(req) {
  const url = new URL(req.url, 'http://x');
  return url.searchParams.get('key') || req.headers.cookie?.match(/(?:^|;\s*)crossbar_key=([^;]+)/)?.[1] || '';
}
/** May this request use the bridge? */
export function authorize(req) {
  const ip = String(req.socket.remoteAddress).replace(/^::ffff:/, '');
  if (isLoopback(ip)) return Promise.resolve(true);
  if (MODE === 'home') return Promise.resolve(timingSafeEqual(digest(decodeURIComponent(keyOf(req))), digest(KEY)));
  return isOwnDevice(ip);
}

// Run a shell command on this Mac.
export function run(cmd) {
  return new Promise((resolve, reject) => {
    execFile('/bin/sh', ['-c', cmd], { timeout: 10_000, maxBuffer: 4 << 20 }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout));
  });
}

// Static files for the web app, only to allowed devices. A page opened with
// ?key=… (home mode) gets it as a cookie so its own requests carry it.
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

export function serveStatic(dir, index) {
  return async (req, res) => {
    if (!(await authorize(req))) { res.writeHead(403).end('forbidden'); return; }
    const url = new URL(req.url, 'http://x');
    const file = normalize(join(dir, url.pathname === '/' ? index : url.pathname));
    if (!file.startsWith(dir) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end(); return; }
    const headers = { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' };
    const key = url.searchParams.get('key');
    if (key) headers['set-cookie'] = `crossbar_key=${encodeURIComponent(key)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`;
    res.writeHead(200, headers);
    res.end(readFileSync(file));
  };
}
