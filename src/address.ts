// Which addresses the phone app may connect to, and the bridge's WebSocket URL
// for one. Only addresses that can be your own Mac: its MagicDNS name
// (*.ts.net) or a Tailscale IP (the only ranges Tailscale assigns:
// 100.64.0.0/10 and fd7a:115c:a1e0::/48), its home-network name (*.local, with
// the pairing code) or localhost. Pure, so it's unit-tested.
export const PORT = 8787;

const NAMED = /^(localhost|127\.0\.0\.1|[a-z0-9-]+(\.[a-z0-9-]+)*\.(ts\.net|local))(:\d+)?$/i;
const TAILNET_IP = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.(25[0-5]|2[0-4]\d|1?\d?\d)\.(25[0-5]|2[0-4]\d|1?\d?\d)(:\d+)?$/; // 100.64.0.0/10
const TAILNET_IP6 = /^\[fd7a:115c:a1e0(:[0-9a-f]{0,4}){1,5}\](:\d+)?$/i; // fd7a:115c:a1e0::/48, in brackets as in a URL
export const allowed = (host: string) => NAMED.test(host) || TAILNET_IP.test(host) || TAILNET_IP6.test(host);

/** The host[:port] part of what someone typed; a bare IPv6 address gets its URL brackets. */
export const hostOf = (addr: string) => {
  const h = addr.trim().replace(/^(https?|wss?):\/\//, '').replace(/\/.*$/, '').toLowerCase();
  return /^[0-9a-f:]+$/.test(h) && h.includes('::') ? `[${h}]` : h;
};
/** A home-network (.local) address, which needs the pairing code. */
export const isHome = (addr: string) => /\.local(:\d+)?$/.test(hostOf(addr));

/** "my-mac.tailnet.ts.net", "100.101.102.103", "my-mac.local:8787", "localhost" → the bridge's WebSocket URL ('' if not allowed). */
export function toWs(addr: string, key = ''): string {
  const host = hostOf(addr);
  if (!allowed(host)) return '';
  const q = isHome(host) && key ? `?key=${encodeURIComponent(key)}` : '';
  const hasPort = host.startsWith('[') ? /\]:\d+$/.test(host) : /:\d+$/.test(host);
  return `ws://${hasPort ? host : `${host}:${PORT}`}/ws${q}`;
}
