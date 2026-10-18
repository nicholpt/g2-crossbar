// Who may use the bridge, in home mode (no Tailscale needed to test it).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

let authorize;
before(async () => {
  process.env.CROSSBAR_MODE = 'home';
  process.env.CROSSBAR_KEY = 'pairing-code-123';
  process.env.BIND = '127.0.0.1';
  ({ authorize } = await import('../lib.mjs'));
});
const req = (ip, url = '/ws', cookie) => ({ socket: { remoteAddress: ip }, url, headers: cookie ? { cookie } : {} });

test('this Mac itself is always allowed', async () => {
  assert.equal(await authorize(req('127.0.0.1')), true);
  assert.equal(await authorize(req('::ffff:127.0.0.1')), true);
  assert.equal(await authorize(req('::1')), true);
});

test('another device needs the pairing code', async () => {
  assert.equal(await authorize(req('192.168.1.20')), false);
  assert.equal(await authorize(req('192.168.1.20', '/ws?key=wrong')), false);
  assert.equal(await authorize(req('192.168.1.20', '/ws?key=pairing-code-1234')), false);
  assert.equal(await authorize(req('192.168.1.20', '/ws?key=pairing-code-123')), true);
});

test('or the cookie set when the page was opened with it', async () => {
  assert.equal(await authorize(req('192.168.1.20', '/', 'a=1; crossbar_key=pairing-code-123')), true);
  assert.equal(await authorize(req('192.168.1.20', '/', 'crossbar_key=nope')), false);
});
