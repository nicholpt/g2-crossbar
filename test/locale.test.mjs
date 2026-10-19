// A LaunchAgent starts the bridge with no locale, and tmux then writes "_" for
// tabs and non-ASCII: the bridge must give its commands a UTF-8 one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const SOCKET = 'crossbar-locale-test';

test('commands the bridge runs see tabs and "❯" from tmux, even with no locale', (t) => {
  const tmux = execFileSync('sh', ['-c', 'command -v tmux']).toString().trim();
  execFileSync(tmux, ['-L', SOCKET, 'new-session', '-d', '-s', 'locale', 'sleep 30'], { env: { ...process.env, LANG: 'en_US.UTF-8' } });
  t.after(() => { try { execFileSync(tmux, ['-L', SOCKET, 'kill-server']); } catch {} });
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(LANG|LC_)/.test(k)));
  const out = execFileSync(process.execPath, ['--input-type=module', '-e',
    `const { run } = await import(${JSON.stringify(join(ROOT, 'lib.mjs'))});
     process.stdout.write(await run(\`${tmux} -L ${SOCKET} display -p -t locale '#{session_name}\\t❯'\`));`],
  { env: { ...env, CROSSBAR_MODE: 'home', BIND: '127.0.0.1', CROSSBAR_KEY: 'test-pairing-code' } }).toString();
  assert.equal(out.trim(), 'locale\t❯');
});
