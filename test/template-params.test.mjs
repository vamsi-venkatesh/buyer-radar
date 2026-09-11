import test from 'node:test';
import { CLIENT } from '../src/client.mjs';
import assert from 'node:assert/strict';
import { templateParams } from '../src/deliver.mjs';
const digest = `${CLIENT.digest.title} - 2026-09-11 - Bengaluru\n\nL1 Copper Chimney - restaurant\n   +918067266455 - listed on OpenStreetMap\n   "Daily peeled garlic."\n\nL2 Dass Suites - hotel\n   +918040918525 - listed\n\nL3 Empire - restaurant\n   +918040414141 - x\n\nL4 Other - hotel\n   +910000000000 - y\n`;
const sheet = `Mandi price sheet - 2026-09-11\nPeeled garlic: Rs 14000/qtl, Bengaluru APMC 11/09/2026\nBroccoli: no mandi quote today\nGreen capsicum: Rs 3100/qtl, Binny Mill 11/09/2026\nCherry tomato ~: Rs 1600/qtl, Binny Mill 11/09/2026\n`;
test('template params: five strings, no newlines, top three with phones, prices short', () => {
  const p = templateParams({ date: '2026-09-11', digestText: digest, priceSheet: sheet, stats: { leads: 154, withPhone: 119 } });
  assert.equal(p.length, 5);
  for (const x of p) assert.ok(!/[\n\t]/.test(x), 'no newlines');
  assert.equal(p[0], 'Friday, 11 September');
  assert.equal(p[1], '154');
  assert.equal(p[2], '119');
  assert.ok(p[3].startsWith('Copper Chimney +918067266455, Dass Suites +918040918525, Empire +918040414141'));
  assert.equal(p[4], 'peeled garlic Rs 14000, green capsicum Rs 3100, cherry tomato Rs 1600 per quintal');
});
test('template params without stats fall back to shown leads', () => {
  const p = templateParams({ date: '2026-09-11', digestText: digest, priceSheet: '' });
  assert.equal(p[1], '4'); assert.equal(p[4], 'no mandi quotes today');
});
