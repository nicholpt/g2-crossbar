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

test('RSS: description (escaped HTML) as plain text, creator and category', () => {
  const [a, b] = feed('rss.xml');
  assert.deepEqual({ summary: a.summary, authors: a.authors, cat: a.cat }, { summary: 'The whole story here.', authors: 'A. Writer', cat: 'World' });
  assert.deepEqual([b.summary, b.authors, b.cat], [undefined, undefined, undefined]); // only what the feed has
});

test('Atom: whitespace collapsed', () => {
  assert.deepEqual(feed('atom.xml').map((i) => i.title), ['An entry split over lines', 'Second entry']);
});

test('arXiv API (Atom): wrapped titles joined', () => {
  assert.deepEqual(feed('arxiv.xml').map((i) => i.title), ['Benchmarking Personalized Robotic Manipulation', 'Discovering circuits with large language models']);
});

test('arXiv API (Atom): abstract with its TeX as plain text, authors and primary category', () => {
  const [a] = feed('arxiv.xml');
  assert.equal(a.summary, 'We replace u-prediction with x0-prediction at α = 0.5 & compare.');
  assert.equal(a.authors, 'Ada Example, Grace Sample');
  assert.equal(a.cat, 'cs.RO');
});

test('untrusted text: prices stay, bad entities and prototype names are harmless, long items capped', () => {
  const item = (summary, title = 'T') => parseFeed(`<feed><title>F</title><entry><title>${title}</title><summary>${summary}</summary></entry></feed>`)[0];
  assert.equal(item('Costs $5 vs $10 a month').summary, 'Costs $5 vs $10 a month');
  assert.equal(item('A &amp;#99999999999; B &#xFFFFFFFF; C').summary, 'A &#99999999999; B &#xFFFFFFFF; C');
  assert.equal(item('$\\constructor$ and $\\toString$').summary, 'constructor and toString');
  assert.equal(item('x'.repeat(5000), 'y'.repeat(900)).summary.length, 2000);
  assert.equal(item('s', 'y'.repeat(900)).title.length, 300);
});

test('garbage in, nothing out', () => {
  assert.deepEqual(parseFeed('<html><body>not a feed</body></html>'), []);
  assert.deepEqual(parseFeed(''), []);
});
