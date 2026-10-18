import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFeed } from '../feed.mjs';

const feed = (name) => parseFeed(readFileSync(join(import.meta.dirname, 'fixtures', 'feeds', name), 'utf8'));

test('RSS: titles, CDATA, entities; items without a title are skipped', () => {
  assert.deepEqual(feed('rss.xml').map((i) => i.title), ['First headline', 'Second & bold headline', 'Tom & Jerry\'s "big" day']);
  assert.equal(feed('rss.xml')[0].source, 'Example News');
});

test('Atom: whitespace collapsed', () => {
  assert.deepEqual(feed('atom.xml').map((i) => i.title), ['An entry split over lines', 'Second entry']);
});

test('arXiv API (Atom): wrapped titles joined', () => {
  assert.deepEqual(feed('arxiv.xml').map((i) => i.title), ['Benchmarking Personalized Robotic Manipulation', 'Discovering circuits with large language models']);
});

test('garbage in, nothing out', () => {
  assert.deepEqual(parseFeed('<html><body>not a feed</body></html>'), []);
  assert.deepEqual(parseFeed(''), []);
});
