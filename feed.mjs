// Headlines from RSS 2.0 / RDF (<item>) and Atom (<entry>) feeds, for the
// glasses' top line. Pure (no I/O).
const unxml = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');
// RSS <item> or Atom <entry>; the first <title> inside each is the headline.
export function parseFeed(xml) {
  const source = unxml(xml.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1] ?? '').replace(/\s+/g, ' ').trim();
  return [...xml.matchAll(/<(item|entry)[\s>]([\s\S]*?)<\/\1>/g)]
    .map(([, , body]) => unxml(body.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1] ?? '').replace(/\s+/g, ' ').trim())
    .filter(Boolean).map((title) => ({ title, source }));
}
