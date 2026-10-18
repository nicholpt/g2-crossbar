// Repo hygiene: nothing personal in tracked files (screen captures pick up
// emails, home folders and tailnet addresses), and one version everywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const read = (f) => readFileSync(join(ROOT, f), 'utf8');

// only the made-up examples the docs and tests use
const OK_EMAIL = /@(example\.com|users\.noreply\.github\.com)$|^noreply@anthropic\.com$/;
const OK_HOME = new Set(['/Users/me', '/home/me']);
const OK_IP = new Set(['100.64.0.0', '100.64.0.1', '100.127.255.255', '100.100.1.1', '100.63.255.255', '100.128.0.1',
  '100.100.300.1', '100.101.102.103']);
const OK_TSNET = /^(my-)?mac\.(tail(net(-1234)?|1234)\.)?ts\.net$/i;

test('no personal details in tracked files', () => {
  let files;
  try {
    files = execFileSync('git', ['ls-files'], { cwd: ROOT }).toString().split('\n');
  } catch {
    return; // not a git checkout (e.g. an unpacked release): nothing to check
  }
  const found = [];
  for (const f of files.filter((f) => f && !/\.(png|gif|jpe?g|ico|ehpk)$/i.test(f))) {
    const text = read(f);
    const hit = (what, m) => found.push(`${f}: ${what} ${m}`);
    for (const [m] of text.matchAll(/[\w.%+-]+@[\w-]+(\.[\w-]+)*\.[a-z]{2,}/gi)) if (!OK_EMAIL.test(m)) hit('email', m);
    for (const [m] of text.matchAll(/\/(Users|home)\/[\w.-]+/g)) if (!OK_HOME.has(m)) hit('home folder', m);
    for (const [m] of text.matchAll(/\b100\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g)) if (!OK_IP.has(m)) hit('tailnet IP', m);
    for (const [m] of text.matchAll(/[\w-]+(\.[\w-]+)*\.ts\.net\b/gi)) if (!OK_TSNET.test(m)) hit('tailnet name', m);
  }
  assert.deepEqual(found, [], 'replace these with made-up examples (see docs/TESTING.md)');
});

test('app.json, package.json and package-lock.json agree on the version', () => {
  const v = JSON.parse(read('app.json')).version;
  assert.equal(JSON.parse(read('package.json')).version, v, 'package.json');
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(lock.version, v, 'package-lock.json');
  assert.equal(lock.packages[''].version, v, 'package-lock.json packages[""]');
  assert.match(read('CHANGELOG.md'), new RegExp(`^## ${v.replaceAll('.', '\\.')}\\b`, 'm'), `CHANGELOG.md has no "## ${v}" section`);
});
