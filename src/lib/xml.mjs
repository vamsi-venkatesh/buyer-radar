// Tiny, dependency-free readers for the two markup shapes this project consumes.
// Deliberately narrow: they read the specific feeds and pages we fetch, nothing more.

export function decodeEntities(s) {
  if (!s) return '';
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

export function stripTags(html) {
  return decodeEntities(
    String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function tagValue(block, tag) {
  const m = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? decodeEntities(m[1]).trim() : '';
}

function tagAttr(block, tag, attr) {
  const m = block.match(new RegExp(`<${tag}\\s[^>]*${attr}="([^"]*)"`, 'i'));
  return m ? decodeEntities(m[1]).trim() : '';
}

/** Parse an RSS 2.0 document into plain item objects. */
export function parseRssItems(xml) {
  const items = [];
  for (const m of String(xml).matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const block = m[1];
    items.push({
      title: tagValue(block, 'title'),
      link: tagValue(block, 'link'),
      pubDate: tagValue(block, 'pubDate'),
      guid: tagValue(block, 'guid'),
      source: tagValue(block, 'source'),
      sourceUrl: tagAttr(block, 'source', 'url'),
      description: tagValue(block, 'description'),
    });
  }
  return items;
}

/**
 * Parse an Atom document into the same plain item objects.
 *
 * Atom puts the article URL in an attribute rather than in the element body, so
 * `<link rel="alternate" href="...">` - or the first link with no rel at all -
 * is the one a reader would follow. `rel="self"` points back at the feed and is
 * never the article.
 */
export function parseAtomEntries(xml) {
  const items = [];
  for (const m of String(xml).matchAll(/<entry[\s>][\s\S]*?<\/entry>/gi)) {
    const block = m[0];
    let link = '';
    for (const l of block.matchAll(/<link\b[^>]*>/gi)) {
      const tag = l[0];
      const rel = (tag.match(/\brel="([^"]*)"/i) || [])[1] || '';
      const href = (tag.match(/\bhref="([^"]*)"/i) || [])[1] || '';
      if (!href) continue;
      if (rel && rel.toLowerCase() !== 'alternate') continue;
      link = decodeEntities(href);
      break;
    }
    items.push({
      title: tagValue(block, 'title'),
      link: link || tagValue(block, 'id'),
      pubDate: tagValue(block, 'published') || tagValue(block, 'updated'),
      guid: tagValue(block, 'id'),
      source: '',
      sourceUrl: '',
      description: tagValue(block, 'summary') || tagValue(block, 'content'),
    });
  }
  return items;
}

/**
 * Read a feed whichever of the two shapes it is published in.
 *
 * A publisher's own feed is RSS about four times out of five and Atom the rest
 * of the time, and which one it is is not something we get to choose. Reading
 * only `<item>` would have dropped every Atom publisher silently - a feed with
 * items would have looked like a feed with none.
 */
export function parseFeedItems(xml) {
  const rss = parseRssItems(xml);
  return rss.length ? rss : parseAtomEntries(xml);
}

/** Read every input element on an HTML page as name/value/type. */
export function parseInputs(html) {
  const out = [];
  for (const m of String(html).matchAll(/<input\b[^>]*>/gi)) {
    const tag = m[0];
    const name = (tag.match(/\bname="([^"]*)"/i) || [])[1] || '';
    const value = (tag.match(/\bvalue="([^"]*)"/i) || [])[1] || '';
    const type = (tag.match(/\btype="([^"]*)"/i) || [])[1] || 'text';
    out.push({ name, value: decodeEntities(value), type });
  }
  return out;
}

/** Read HTML table rows as arrays of cell text. */
export function parseTableRows(html) {
  const rows = [];
  for (const m of String(html).matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [];
    for (const c of m[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)) {
      cells.push(stripTags(c[1]));
    }
    if (cells.length) rows.push(cells);
  }
  return rows;
}

/** Collect hrefs paired with their anchor text. */
export function parseLinks(html) {
  const out = [];
  for (const m of String(html).matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    out.push({ href: decodeEntities(m[1]), text: stripTags(m[2]) });
  }
  return out;
}
