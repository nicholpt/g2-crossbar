// The phone app only connects to addresses that can be your own Mac.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toWs, isHome, allowed, hostOf } from '../src/address.ts';

test('accepted addresses and their WebSocket URLs', () => {
  const cases = {
    'my-mac.tail1234.ts.net': 'ws://my-mac.tail1234.ts.net:8787/ws',
    'https://My-Mac.tail1234.ts.net/': 'ws://my-mac.tail1234.ts.net:8787/ws',
    '100.64.0.1': 'ws://100.64.0.1:8787/ws',
    '100.127.255.255:8797': 'ws://100.127.255.255:8797/ws',
    'fd7a:115c:a1e0::5b35:a633': 'ws://[fd7a:115c:a1e0::5b35:a633]:8787/ws',
    '[fd7a:115c:a1e0::1]:8797': 'ws://[fd7a:115c:a1e0::1]:8797/ws',
    'localhost': 'ws://localhost:8787/ws',
    '127.0.0.1:8787': 'ws://127.0.0.1:8787/ws',
  };
  for (const [addr, url] of Object.entries(cases)) assert.equal(toWs(addr), url, addr);
});

test('home (.local) addresses carry the pairing code; others never do', () => {
  assert.equal(toWs('My-Mac.local', 'a b&c'), 'ws://my-mac.local:8787/ws?key=a%20b%26c');
  assert.equal(toWs('my-mac.tail1234.ts.net', 'secret'), 'ws://my-mac.tail1234.ts.net:8787/ws');
  assert.ok(isHome('mac.local:8797'));
  assert.ok(!isHome('mac.ts.net'));
});

test('everything else is refused', () => {
  for (const addr of ['', '192.168.1.5', '10.0.0.2', '100.63.255.255', '100.128.0.1', '100.100.300.1', '8.8.8.8',
    'evil.com', 'ts.net.evil.com', 'mac.ts.net.evil.com', 'local', 'fd00::1', '[fd7a:115d::1]', 'javascript:alert(1)'])
    assert.equal(toWs(addr), '', addr);
});

test('hostOf strips schemes and paths', () => {
  assert.equal(hostOf(' ws://mac.local:8787/ws?key=x '), 'mac.local:8787');
  assert.ok(allowed(hostOf('http://100.100.1.1/')));
});
