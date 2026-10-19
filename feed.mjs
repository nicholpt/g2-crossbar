// Items from RSS 2.0 / RDF (<item>) and Atom (<entry>) feeds, for the glasses'
// top line and the minimized reader. Pure (no I/O).
const unxml = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, '&');
const oneLine = (s) => s.replace(/\s+/g, ' ').trim();
const first = (body, tag) => body.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`))?.[1] ?? '';

// TeX in arXiv abstracts, as plain text: "$\boldsymbol{x_0}$" -> "x0", "$\alpha$" -> "α"
const GREEK = { alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', theta: 'θ', lambda: 'λ', mu: 'μ', pi: 'π', sigma: 'σ', tau: 'τ', phi: 'φ', omega: 'ω', ell: 'ℓ', times: '×', cdot: '·', leq: '≤', geq: '≥', approx: '≈', sim: '~', to: '→', infty: '∞' };
const math = (m) => {
  let s = m;
  for (let prev; prev !== s;) { prev = s; s = s.replace(/\\[a-zA-Z]+\{([^{}]*)\}/g, '$1'); } // \mathbf{x}, nested
  return s.replace(/\\([a-zA-Z]+)/g, (_, n) => GREEK[n] ?? n).replace(/[_^]/g, '').replace(/[{}\\]/g, '').trim();
};
const detex = (s) => s.replace(/\$([^$]+)\$/g, (_, m) => math(m));

// RSS <item> or Atom <entry>. title is the headline; summary, authors and cat
// are there when the feed has them (arXiv: abstract, author list, primary category).
export function parseFeed(xml) {
  const source = oneLine(unxml(first(xml, 'title')));
  return [...xml.matchAll(/<(item|entry)[\s>]([\s\S]*?)<\/\1>/g)].map(([, , body]) => {
    const authors = [...body.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)].map((m) => m[1])
      .concat(first(body, 'dc:creator') || []).map((a) => oneLine(unxml(a))).filter(Boolean);
    const cat = body.match(/<arxiv:primary_category[^>]*term="([^"]+)"/)?.[1] ?? body.match(/<category[^>]*term="([^"]+)"/)?.[1] ?? oneLine(unxml(first(body, 'category')));
    // RSS descriptions are often escaped HTML: decode again if tags or entities are left
    const once = unxml(first(body, 'summary') || first(body, 'description') || first(body, 'content'));
    const summary = oneLine(detex(/<\/?[a-z][^>]*>|&#?\w+;/i.test(once) ? unxml(once) : once));
    return { title: oneLine(detex(unxml(first(body, 'title')))), source, ...(summary && { summary }), ...(authors.length && { authors: authors.join(', ') }), ...(cat && { cat }) };
  }).filter((i) => i.title);
}
