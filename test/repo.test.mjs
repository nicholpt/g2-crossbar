// Repo hygiene: nothing personal in tracked files (screen captures pick up
// emails, home folders and tailnet addresses), and one version everywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
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

test('docs/SBOM.md lists every package in package.json, at its locked version', () => {
  const doc = read('docs/SBOM.md');
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
    const v = lock.packages[`node_modules/${name}`].version;
    assert.ok(doc.includes(`| \`${name}\` | ${v} |`), `${name} ${v}`);
  }
});

test('the SBOM has the npm packages and the system pieces, and one Whisper model hash', () => {
  mkdirSync(join(ROOT, '.run'), { recursive: true });
  const out = join(ROOT, '.run', 'sbom.test.cdx.json');
  execFileSync(process.execPath, [join(ROOT, 'bin/sbom.mjs'), out]);
  const bom = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(bom.bomFormat, 'CycloneDX');
  const names = new Set(bom.components.map((c) => c.name));
  for (const name of ['ws', '@evenrealities/even_hub_sdk', 'vite', 'Node.js', 'tmux', 'Tailscale', 'whisper.cpp']) assert.ok(names.has(name), name);
  const model = bom.components.find((c) => c.type === 'machine-learning-model');
  assert.ok(read('docs/SBOM.md').includes(model.hashes[0].content), 'docs/SBOM.md has the model hash bin/sbom.mjs records');
});

test('the built app names no URL: it only talks to the bridge (the store checks its whitelist against them)', () => {
  const dir = join(ROOT, 'dist', 'assets');
  const files = readdirSync(dir).map((f) => join(dir, f)).concat(join(ROOT, 'dist', 'crossbar.html'));
  const urls = files.flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/\b(?:https?|wss?):\/\/[\w.-]+/g)].map((m) => m[0]));
  assert.deepEqual([...new Set(urls)], []);
});
