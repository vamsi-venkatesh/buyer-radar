// Reading the text out of a PDF, with nothing but node:zlib.
//
// A tender notice is very often a PDF, so a demand lane that cannot read one
// reads nothing. This is not a PDF renderer and does not pretend to be: it finds
// the content streams, inflates the ones that are deflated, and pulls the
// strings that a text-showing operator would have painted. Glyph positions,
// fonts, columns and tables are all lost; the words survive in reading order.
//
// The one thing it must never do is hand back confident nonsense. A scanned
// page carries an image and no text operators; a subset-encoded font paints
// bytes that mean nothing outside its own encoding table. Both come back as
// `{ ok: false, reason: 'unreadable' }` rather than as a string of rubbish that
// a model would then dutifully summarise.

import zlib from 'node:zlib';

export const PDF_MAGIC = '%PDF-';

export function looksLikePdf(buf) {
  if (!buf || !buf.length) return false;
  return Buffer.from(buf).subarray(0, 1024).toString('latin1').includes(PDF_MAGIC);
}

// ------------------------------------------------------------------ streams

/**
 * Every `<< dict >> stream ... endstream` block in the file, with its raw bytes.
 * The dict is captured as text so the caller can see the filters without
 * parsing PDF objects properly.
 */
export function findStreams(buf) {
  const bytes = Buffer.from(buf);
  const s = bytes.toString('latin1');
  const out = [];
  const re = /<<([\s\S]{0,8000}?)>>\s*stream(\r\n|\r|\n)/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const start = m.index + m[0].length;
    const end = s.indexOf('endstream', start);
    if (end === -1) continue;
    let stop = end;
    // The EOL before `endstream` belongs to the keyword, not to the data.
    if (s[stop - 1] === '\n') stop -= 1;
    if (s[stop - 1] === '\r') stop -= 1;
    out.push({ dict: m[1], data: bytes.subarray(start, stop), at: m.index });
    re.lastIndex = end + 9;
  }
  return out;
}

/** Inflate one stream's bytes according to its dict, or say why it could not. */
export function decodeStream({ dict, data }) {
  const filters = String(dict || '');
  if (/\/Subtype\s*\/Image\b/.test(filters)) return { ok: false, reason: 'image stream' };
  if (/\/(DCTDecode|JPXDecode|CCITTFaxDecode|JBIG2Decode)\b/.test(filters)) {
    return { ok: false, reason: 'image stream' };
  }
  if (/\/FlateDecode\b/.test(filters)) {
    for (const inflate of [zlib.inflateSync, zlib.inflateRawSync]) {
      try {
        return { ok: true, text: inflate(data).toString('latin1'), encoding: 'FlateDecode' };
      } catch {
        /* try the next shape, then give up on this stream */
      }
    }
    return { ok: false, reason: 'FlateDecode failed' };
  }
  if (/\/(LZWDecode|RunLengthDecode|ASCII85Decode|ASCIIHexDecode|Crypt)\b/.test(filters)) {
    return { ok: false, reason: `unsupported filter in ${filters.match(/\/\w+Decode/)?.[0] || 'stream'}` };
  }
  // No filter entry at all: an uncompressed content stream.
  return { ok: true, text: data.toString('latin1'), encoding: 'none' };
}

// ------------------------------------------------------------------ strings

const ESCAPES = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };

/** Read a PDF literal string starting at `s[i] === '('`. Returns { value, end }. */
export function readLiteralString(s, i) {
  let depth = 1;
  let out = '';
  let k = i + 1;
  while (k < s.length && depth > 0) {
    const c = s[k];
    if (c === '\\') {
      const next = s[k + 1];
      if (next >= '0' && next <= '7') {
        let oct = '';
        let j = k + 1;
        while (j < s.length && oct.length < 3 && s[j] >= '0' && s[j] <= '7') oct += s[j++];
        out += String.fromCharCode(parseInt(oct, 8) & 0xff);
        k = j;
        continue;
      }
      if (next === '\n') { k += 2; continue; } // line continuation
      if (next === '\r') { k += s[k + 2] === '\n' ? 3 : 2; continue; }
      out += ESCAPES[next] ?? next ?? '';
      k += 2;
      continue;
    }
    if (c === '(') depth += 1;
    else if (c === ')') { depth -= 1; if (depth === 0) { k += 1; break; } }
    out += c;
    k += 1;
  }
  return { value: out, end: k };
}

/** Read a PDF hex string starting at `s[i] === '<'`. Returns { value, end }. */
export function readHexString(s, i) {
  const close = s.indexOf('>', i + 1);
  if (close === -1) return { value: '', end: s.length };
  const hex = s.slice(i + 1, close).replace(/[^0-9a-fA-F]/g, '');
  const padded = hex.length % 2 ? `${hex}0` : hex;
  let out = '';
  for (let k = 0; k < padded.length; k += 2) out += String.fromCharCode(parseInt(padded.slice(k, k + 2), 16));
  return { value: out, end: close + 1 };
}

/**
 * Decode the bytes a PDF string carries into characters.
 *
 * A leading UTF-16BE byte-order mark means exactly that. Everything else is
 * treated as one byte per character, which is right for the WinAnsi and
 * Standard encodings simple fonts use, and is wrong - unavoidably - for a
 * subset font with its own encoding. The readability check below is what
 * catches the second case.
 */
export function decodePdfText(raw) {
  if (raw.length >= 2 && raw.charCodeAt(0) === 0xfe && raw.charCodeAt(1) === 0xff) {
    let out = '';
    for (let i = 2; i + 1 < raw.length; i += 2) {
      out += String.fromCharCode((raw.charCodeAt(i) << 8) | raw.charCodeAt(i + 1));
    }
    return out;
  }
  return raw;
}

const SHOW_ONE = new Set(['Tj', "'", '"']);
const NEWLINE_OPS = new Set(['Td', 'TD', 'T*', 'ET', 'BT', "'", '"']);

/**
 * How far apart two runs inside one TJ array have to be pushed before the gap
 * is a word space rather than kerning.
 *
 * A TJ array interleaves strings with adjustments in thousandths of an em, and
 * a great many PDF writers emit the space between words as an adjustment rather
 * than as a space character. Without this, "Supply of veg" comes out as
 * "Supply ofveg" and every phrase match downstream fails on real documents.
 * Kerning pairs are tens; an inter-word gap is hundreds.
 */
export const TJ_SPACE_THRESHOLD = -120;

/** Pull the shown strings out of one decoded content stream, in painting order. */
export function textFromContentStream(content) {
  const s = String(content || '');
  const lines = [];
  let line = '';
  let pending = [];

  const flushLine = () => {
    const t = line.replace(/[ \t]+/g, ' ').trim();
    if (t) lines.push(t);
    line = '';
  };

  let depth = 0;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '[') { depth += 1; i += 1; continue; }
    if (c === ']') { depth = Math.max(0, depth - 1); i += 1; continue; }
    if (depth > 0 && (c === '-' || c === '.' || (c >= '0' && c <= '9'))) {
      let j = i;
      while (j < s.length && /[-.0-9]/.test(s[j])) j += 1;
      const value = Number(s.slice(i, j));
      if (Number.isFinite(value) && value <= TJ_SPACE_THRESHOLD && pending.length && !/\s$/.test(pending[pending.length - 1])) {
        pending.push(' ');
      }
      i = j;
      continue;
    }
    if (c === '(') {
      const { value, end } = readLiteralString(s, i);
      pending.push(decodePdfText(value));
      i = end;
      continue;
    }
    if (c === '<' && s[i + 1] !== '<') {
      const { value, end } = readHexString(s, i);
      pending.push(decodePdfText(value));
      i = end;
      continue;
    }
    if (/[A-Za-z'"*]/.test(c)) {
      let j = i;
      while (j < s.length && /[A-Za-z0-9*'"]/.test(s[j])) j += 1;
      const op = s.slice(i, j);
      if (SHOW_ONE.has(op) || op === 'TJ') {
        line += pending.join('');
        pending = [];
      }
      if (NEWLINE_OPS.has(op)) flushLine();
      if (!SHOW_ONE.has(op) && op !== 'TJ') pending = [];
      i = j;
      continue;
    }
    i += 1;
  }
  line += pending.join('');
  flushLine();
  return lines.join('\n');
}

// --------------------------------------------------------------- readability

// Whitespace is not noise. A tender PDF laid out one word per line decodes to
// text that is a third newlines, and counting those against it called a
// perfectly readable notice - with the office phone and email on page one -
// unreadable. The ratio is therefore measured over the non-whitespace
// characters only.
const READABLE = /[A-Za-z0-9.,\-/:()&'"%@+#*;?!\[\]]/;

export const READABLE_RATIO = 0.85;

/** Share of the non-whitespace characters that are ordinary text characters. */
export function readableRatio(text) {
  const dense = String(text || '').replace(/\s+/g, '');
  if (!dense.length) return 0;
  let good = 0;
  for (const ch of dense) if (READABLE.test(ch)) good += 1;
  return good / dense.length;
}

/**
 * Is this string words, or is it a font's private encoding leaking out?
 *
 * Real notice text is overwhelmingly letters, digits and punctuation and
 * contains ordinary words. Subset-font output is high-entropy bytes - NULs and
 * accented Latin-1 - with almost no ordinary words in it.
 *
 * The test is applied per content stream, not to the document as a whole,
 * because real tender PDFs are mixtures: the IIT Hyderabad wet canteen notice
 * has its office phone and email in plain text on page one and a subset-encoded
 * annexure later, and judging the two together threw away a genuine contact.
 * A document is readable when any of its streams is; the streams that are not
 * are dropped rather than pasted in as noise.
 */
export function isReadableText(text, { minChars = 40, minWords = 8 } = {}) {
  const t = String(text || '');
  if (t.replace(/\s+/g, '').length < minChars) return false;
  if (readableRatio(t) < READABLE_RATIO) return false;
  const words = t.match(/\b[A-Za-z]{3,}\b/g) || [];
  return words.length >= minWords;
}

/**
 * Read a PDF buffer into plain text.
 *
 * Returns `{ ok: true, text, streams, decoded, chars }` or
 * `{ ok: false, reason: 'unreadable' | ..., detail }`. `unreadable` is the
 * honest answer for a scanned page and for a page whose fonts we cannot map;
 * the caller records it and moves on rather than guessing at the contents.
 */
export function pdfToText(buf, { maxChars = 20000 } = {}) {
  if (!looksLikePdf(buf)) return { ok: false, reason: 'not a pdf' };
  const streams = findStreams(buf);
  if (!streams.length) return { ok: false, reason: 'unreadable', detail: 'no stream objects found' };

  const parts = [];
  let decoded = 0;
  let unreadableStreams = 0;
  const failures = [];
  for (const stream of streams) {
    const d = decodeStream(stream);
    if (!d.ok) {
      failures.push(d.reason);
      continue;
    }
    decoded += 1;
    if (!/\bTj\b|\bTJ\b|\bBT\b/.test(d.text)) continue;
    const text = textFromContentStream(d.text);
    if (!text) continue;
    if (readableRatio(text) < READABLE_RATIO) {
      unreadableStreams += 1;
      continue;
    }
    parts.push(text);
  }

  const joined = parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!joined) {
    return {
      ok: false,
      reason: 'unreadable',
      detail: decoded
        ? unreadableStreams
          ? `every one of the ${unreadableStreams} text streams decoded to bytes that are not words - the fonts carry their own encoding`
          : 'streams decoded but carried no text operators - the page is an image'
        : `no stream could be decoded (${[...new Set(failures)].join(', ') || 'no filters recognised'})`,
      streams: streams.length,
      decoded,
      unreadableStreams,
    };
  }
  if (!isReadableText(joined)) {
    return {
      ok: false,
      reason: 'unreadable',
      detail: 'text operators decoded to bytes that are not words - the fonts carry their own encoding',
      streams: streams.length,
      decoded,
      chars: joined.length,
    };
  }
  const clipped = joined.length > maxChars ? joined.slice(0, maxChars) : joined;
  return {
    ok: true,
    text: clipped,
    streams: streams.length,
    decoded,
    unreadableStreams,
    chars: joined.length,
    truncated: clipped.length < joined.length,
  };
}
