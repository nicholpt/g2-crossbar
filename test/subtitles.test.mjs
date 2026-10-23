// Subtitles: rolling captions from the glasses mic (voice.mjs Captioner).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Captioner, caption } from '../voice.mjs';

const FRAME = 480; // 30 ms at 16 kHz
const pcm = (ms, amp) => {
  const b = Buffer.alloc(Math.round(ms / 30) * FRAME * 2);
  for (let i = 0; i < b.length / 2; i++) b.writeInt16LE(Math.round(amp * Math.sin(i / 3)), i * 2);
  return b;
};
const talk = (ms) => pcm(ms, 8000);
const quiet = (ms) => pcm(ms, 0);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("Whisper's non-speech labels are dropped", () => {
  assert.equal(caption(' [BLANK_AUDIO] '), '');
  assert.equal(caption('(wind) so we ship it  [Music] friday'), 'so we ship it friday');
});

test('words while someone talks, then the whole phrase at the pause', async (t) => {
  const got = [];
  let n = 0;
  const c = new Captioner(async (p) => `call ${++n} (${Math.round(p.length / 32)} ms)`, (m) => got.push(m), { everyMs: 1e9 });
  t.after(() => c.stop());
  c.push(quiet(300));
  c.push(talk(900));
  c.partial(); // the ticker's job
  await wait(10);
  assert.deepEqual(got.map((m) => m.final), [false]);
  c.push(quiet(800)); // a pause ends the phrase
  await wait(10);
  assert.deepEqual(got.map((m) => m.final), [false, true]);
  assert.ok(got[1].text.startsWith('call 2'), got[1].text);
});

test("a partial for a phrase that already ended isn't shown", async (t) => {
  const got = [];
  let release;
  const c = new Captioner((p) => (p.length < 40000 ? new Promise((r) => { release = () => r('stale words'); }) : Promise.resolve('whole phrase')),
    (m) => got.push(m), { everyMs: 1e9 });
  t.after(() => c.stop());
  c.push(talk(900));
  c.partial(); // in flight...
  c.push(talk(600));
  c.push(quiet(800)); // ...when the phrase ends
  release();
  await wait(10);
  assert.deepEqual(got, [{ text: 'whole phrase', final: true }]);
});

test('a long stretch of talk is cut into phrases', async (t) => {
  const got = [];
  const c = new Captioner(async () => 'words', (m) => got.push(m), { everyMs: 1e9, maxMs: 3000 });
  t.after(() => c.stop());
  c.push(talk(7000));
  await wait(10);
  assert.ok(got.filter((m) => m.final).length >= 2, JSON.stringify(got));
});

test('no speech for idleMs: onIdle', async (t) => {
  let idle = false;
  const c = new Captioner(async () => '', () => {}, { everyMs: 1e9, idleMs: 30, onIdle: () => { idle = true; } });
  t.after(() => c.stop());
  c.push(quiet(300));
  await wait(80);
  assert.ok(idle);
});
