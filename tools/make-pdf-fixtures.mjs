// Build the three synthetic PDF fixtures the extractor is tested against.
//
// They are synthetic on purpose and are labelled as such in the test: a real
// tender PDF is half a megabyte and belongs in a repository about as much as a
// video does. What they test is the three cases the extractor has to tell
// apart - an uncompressed content stream, a FlateDecode one, and a page with an
// image and no text at all - each held to the same output.
//
//   node tools/make-pdf-fixtures.mjs
//
// The real-PDF evidence lives beside them as institutions-iith-notice.txt: the
// actual text this extractor pulled out of the IIT Hyderabad wet canteen notice
// on 2026-09-11, kept so the contact, date and quantity readers are regression
// tested against a real document's real wording.

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { ROOT } from '../src/lib/paths.mjs';

const FIXTURES = path.join(ROOT, 'test', 'fixtures');

export const NOTICE_LINES = [
  'INDIAN INSTITUTE OF TECHNOLOGY EXAMPLE',
  'Kandi, Sangareddy (Dist), Telangana - 502284',
  'NOTICE INVITING TENDER',
  'Ref: EXAMPLE/MS/VEG/2026 dated 01.09.2026',
  'Sealed tenders are invited for the supply of fresh vegetables to the hostel mess',
  'for the year 2026-27. The estimated requirement is 1,500 kg vegetables per month.',
  'Last Date & Time of submission of bids: 30/09/2026 up to 15:00 hrs',
  'Date of opening of bids: 02/10/2026 at 11:00 hrs',
  'Contact Person: Shri R. K. Sharma, Deputy Registrar (Stores)',
  'Phone: 040-2301 6773   Mobile: +91 98450 12345',
  'Email: stores[at]example[dot]ac[dot]in',
];

function escapePdf(s) {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/** A content stream that paints the notice, one line per Td. */
export function contentStream(lines = NOTICE_LINES) {
  const body = lines
    .map((line, i) => `BT /F1 11 Tf 60 ${760 - i * 20} Td (${escapePdf(line)}) Tj ET`)
    .join('\n');
  return `${body}\n`;
}

function assemble(objects) {
  let pdf = '%PDF-1.4\n';
  objects.forEach((body, i) => {
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  pdf += `trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

function pageObjects(streamDict, streamBytes) {
  return [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `${streamDict}\nstream\n${streamBytes.toString('latin1')}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
}

async function main() {
  const plain = Buffer.from(contentStream(), 'latin1');
  await writeFile(
    path.join(FIXTURES, 'pdf-notice-uncompressed.pdf'),
    assemble(pageObjects(`<< /Length ${plain.length} >>`, plain))
  );

  const deflated = zlib.deflateSync(plain);
  await writeFile(
    path.join(FIXTURES, 'pdf-notice-flate.pdf'),
    assemble(pageObjects(`<< /Length ${deflated.length} /Filter /FlateDecode >>`, deflated))
  );

  // A scanned page: one image, no text operator anywhere. This is what a great
  // many real municipal notices are, and the extractor must call it unreadable
  // rather than return the empty string as if the page said nothing.
  const image = zlib.deflateSync(Buffer.alloc(4096, 0x80));
  const scanned = assemble([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length 44 >>\nstream\nq 595 0 0 842 0 0 cm /Im1 Do Q\nendstream`,
    `<< /Type /XObject /Subtype /Image /Width 64 /Height 64 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${image.length} >>\nstream\n${image.toString('latin1')}\nendstream`,
  ]);
  await writeFile(path.join(FIXTURES, 'pdf-scanned-no-text.pdf'), scanned);

  process.stderr.write('wrote pdf-notice-uncompressed.pdf, pdf-notice-flate.pdf, pdf-scanned-no-text.pdf\n');
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err}\n`);
  process.exit(1);
});
