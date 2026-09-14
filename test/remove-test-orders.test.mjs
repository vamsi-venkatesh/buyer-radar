// The test-order cleanup. The decisions it makes are pure functions, so they
// are proven here without a database: what qualifies for removal, what is
// refused, and which lead survives it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyOrders, planLead, parseArgs, TEST_MARKER } from '../tools/remove-test-orders.mjs';

const ours = (id, leadId = 'lead1') => ({
  id,
  contact_name: TEST_MARKER,
  business_name: 'Radar loop test',
  lead_id: leadId,
  order_details: 'Peeled garlic 5 kg',
});
const real = (id, leadId = 'lead1') => ({
  id,
  contact_name: 'Ravi Kumar',
  business_name: 'Copper Chimney',
  lead_id: leadId,
  order_details: '200 kg peeled garlic weekly',
});

test('only the marker qualifies, and an id alone never does', () => {
  const rows = [ours('ORD-A'), real('ORD-B'), ours('ORD-C')];

  const all = classifyOrders(rows);
  assert.deepEqual(all.remove.map((r) => r.id), ['ORD-A', 'ORD-C']);
  assert.deepEqual(all.refused.map((r) => r.id), ['ORD-B']);

  // Naming a real order does not make it removable.
  const named = classifyOrders(rows, ['ORD-B']);
  assert.equal(named.remove.length, 0);
  assert.match(named.refused[0].reason, /not marked/);

  // Naming one that does not exist is said, not silently skipped.
  const missing = classifyOrders(rows, ['ORD-A', 'ORD-NOPE']);
  assert.deepEqual(missing.remove.map((r) => r.id), ['ORD-A']);
  assert.deepEqual(missing.refused, [{ id: 'ORD-NOPE', contactName: null, reason: 'no such order' }]);
});

test('a lead whose every order was ours is deleted with them', () => {
  const lead = {
    id: 'lead1',
    name: 'Radar loop test',
    status: 'won',
    notes: '2026-09-14 won: order ORD-A on greenfieldproduce.example',
    extra: { orders: [{ orderId: 'ORD-A' }, { orderId: 'ORD-C' }], rawPhone: '+91 90000 00001' },
  };
  const plan = planLead(lead, [ours('ORD-A'), ours('ORD-C')], ['ORD-A', 'ORD-C']);
  assert.equal(plan.action, 'delete');
  assert.equal(plan.droppedEntries, 2);
  assert.equal(plan.keptOrders, 0);
});

test('a lead that also has a real order is kept and only loses the test entries', () => {
  const lead = {
    id: 'lead1',
    name: 'Copper Chimney',
    status: 'won',
    notes: '2026-09-14 won: order ORD-A on greenfieldproduce.example\n2026-09-13 won: order ORD-B on greenfieldproduce.example',
    extra: { orders: [{ orderId: 'ORD-A' }, { orderId: 'ORD-B' }], rawPhone: '+91 98450 00001' },
  };
  const plan = planLead(lead, [ours('ORD-A'), real('ORD-B')], ['ORD-A']);
  assert.equal(plan.action, 'update');
  assert.equal(plan.keptOrders, 1);
  assert.equal(plan.droppedEntries, 1);
  assert.deepEqual(plan.extra.orders, [{ orderId: 'ORD-B' }]);
  assert.equal(plan.extra.rawPhone, '+91 98450 00001', 'the rest of the lead is the owner\'s');
  assert.equal(plan.notesChanged, true);
  assert.doesNotMatch(plan.notes, /ORD-A/);
  assert.match(plan.notes, /ORD-B/, 'the real order keeps its note');
  assert.equal(plan.status, 'won');
});

test('running it again removes nothing: there is no marker left to match', () => {
  const rows = [real('ORD-B')];
  const again = classifyOrders(rows, ['ORD-A', 'ORD-C']);
  assert.equal(again.remove.length, 0);
  assert.deepEqual(again.refused.map((r) => r.reason), ['no such order', 'no such order']);
});

test('a lead with no extra.orders at all is handled, not thrown at', () => {
  const plan = planLead({ id: 'lead2', name: 'Bare', status: 'new', notes: null, extra: {} }, [ours('ORD-A', 'lead2')], ['ORD-A']);
  assert.equal(plan.action, 'delete');
  assert.equal(plan.droppedEntries, 0);
});

test('the arguments are read strictly', () => {
  assert.deepEqual(parseArgs(['--apply', '--order', 'ORD-A', '--order', 'ORD-C']).orders, ['ORD-A', 'ORD-C']);
  assert.equal(parseArgs([]).apply, false, 'a dry run is the default');
  assert.throws(() => parseArgs(['--delete-everything']), /unknown argument/);
});
