// The glasses freeze if one Bluetooth command is never answered: every command
// gets a time limit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answered, NoAnswer } from '../src/answered.ts';

test('an answer in time passes through', async () => {
  assert.equal(await answered(Promise.resolve(true), 50), true);
  await assert.rejects(answered(Promise.reject(new Error('rejected')), 50), /rejected/);
});

test('no answer: NoAnswer after the limit', async () => {
  const t0 = Date.now();
  await assert.rejects(answered(new Promise(() => {}), 50), (e) => e instanceof NoAnswer);
  assert.ok(Date.now() - t0 >= 45);
});
