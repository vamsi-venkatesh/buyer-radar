// Remove the orders we placed ourselves to test the loop.
//
// The register is the owner's book of real buyers, and the weekly report counts
// what is in it. An order placed through the client's own order form to prove
// the loop works end to end is not a buyer, so it must not appear in his week
// as one.
//
// What this removes:
//   - an order row whose contact name is exactly "TEST ORDER";
//   - the matching entries in the lead's extra.orders, and the note lines that
//     name a removed order;
//   - the lead itself, but ONLY when every order against it was one of ours.
//
// What it never touches:
//   - events. Every order.received, order.alert and lead.won stays exactly as
//     it was, and so do the sealed evidence bundles under runs/. Those are the
//     proof that the loop ran; deleting them would be deleting the evidence,
//     which is the opposite of the point. The register is a view of the
//     business; the event log is the record of what happened, and they are
//     allowed to differ for something that never was a real order.
//
// It refuses anything not carrying the marker, it prints exactly what it did,
// and running it twice removes nothing the second time.
//
//   node tools/remove-test-orders.mjs            # say what would go, change nothing
//   node tools/remove-test-orders.mjs --apply    # do it
//   node tools/remove-test-orders.mjs --apply --order ORD-3C384FB0 --order ORD-4577B4D2
//
// DATABASE_URL selects the database, exactly as the rest of the service does.

/** The one marker that makes a row ours to remove. Nothing else qualifies. */
export const TEST_MARKER = 'TEST ORDER';

export function parseArgs(argv) {
  const out = { apply: false, orders: [], databaseUrl: process.env.DATABASE_URL || null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--order') out.orders.push(String(argv[++i] || '').trim());
    else if (a === '--database-url') out.databaseUrl = String(argv[++i] || '').trim();
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  out.orders = out.orders.filter(Boolean);
  return out;
}

/**
 * Which of these orders may be removed, and why the others may not.
 *
 * The marker is checked on the row as it is stored, never on the id: an id is
 * something a caller typed, and a caller can type the wrong one.
 */
export function classifyOrders(rows, onlyIds = []) {
  const wanted = onlyIds.length ? new Set(onlyIds) : null;
  const remove = [];
  const refused = [];
  for (const row of rows) {
    if (wanted && !wanted.has(row.id)) continue;
    if (String(row.contact_name || '') === TEST_MARKER) remove.push(row);
    else refused.push({ id: row.id, contactName: row.contact_name || null, reason: `not marked "${TEST_MARKER}"` });
  }
  if (wanted) {
    const seen = new Set(rows.map((r) => r.id));
    for (const id of wanted) if (!seen.has(id)) refused.push({ id, contactName: null, reason: 'no such order' });
  }
  return { remove, refused };
}

/**
 * Strip the removed orders out of a lead's extra, and say what is left.
 *
 * A lead whose every order was one of ours goes with them; a lead that also has
 * a real order keeps its row and loses only the test entries, because the rest
 * of it is the owner's.
 */
export function planLead(lead, ordersForLead, removedIds) {
  const removed = new Set(removedIds);
  const keptOrders = ordersForLead.filter((o) => !removed.has(o.id));
  const extra = lead.extra && typeof lead.extra === 'object' ? lead.extra : {};
  const entries = Array.isArray(extra.orders) ? extra.orders : [];
  const keptEntries = entries.filter((e) => !removed.has(String(e && e.orderId)));
  const droppedEntries = entries.length - keptEntries.length;

  if (!keptOrders.length) {
    return { leadId: lead.id, name: lead.name, action: 'delete', droppedEntries, keptOrders: 0 };
  }

  const nextExtra = { ...extra };
  if (entries.length) {
    if (keptEntries.length) nextExtra.orders = keptEntries;
    else delete nextExtra.orders;
  }
  const notes = String(lead.notes || '')
    .split('\n')
    .filter((line) => ![...removed].some((id) => line.includes(id)))
    .join('\n');
  return {
    leadId: lead.id,
    name: lead.name,
    action: 'update',
    droppedEntries,
    keptOrders: keptOrders.length,
    extra: nextExtra,
    notes: notes || null,
    notesChanged: notes !== String(lead.notes || ''),
    // The status was set by an order; with a real order still against the lead
    // it stays as it is. Said out loud rather than guessed at.
    status: lead.status,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(
      'node tools/remove-test-orders.mjs [--apply] [--order <id>]... [--database-url <url>]\n' +
        `Removes only orders whose contact name is exactly "${TEST_MARKER}". Events and sealed bundles are never touched.\n`
    );
    return;
  }
  if (!args.databaseUrl) throw new Error('DATABASE_URL is unset: this tool works against the register in Postgres');

  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: args.databaseUrl, max: 2 });
  const out = (s) => process.stdout.write(`${s}\n`);

  try {
    const before = {
      orders: Number((await pool.query('SELECT count(*) FROM orders')).rows[0].count),
      leads: Number((await pool.query('SELECT count(*) FROM leads')).rows[0].count),
      events: Number((await pool.query('SELECT count(*) FROM events')).rows[0].count),
    };
    out(`before: ${before.orders} orders, ${before.leads} leads, ${before.events} events`);

    const allOrders = (await pool.query('SELECT id, contact_name, business_name, lead_id, order_details FROM orders')).rows;
    const { remove, refused } = classifyOrders(allOrders, args.orders);

    for (const r of refused) {
      out(`refused ${r.id}: ${r.reason}${r.contactName ? ` (contact name: ${r.contactName})` : ''}`);
    }
    if (!remove.length) {
      out('nothing to remove: no order carries the marker');
      out(`after:  ${before.orders} orders, ${before.leads} leads, ${before.events} events`);
      return;
    }

    const removedIds = remove.map((r) => r.id);
    for (const r of remove) {
      out(`order   ${r.id}  ${r.business_name || '-'}  ${r.order_details || '-'}`);
    }

    // Every lead any removed order points at, with all of its orders, so a lead
    // that also carries a real order is kept rather than swept along.
    const leadIds = [...new Set(remove.map((r) => r.lead_id).filter(Boolean))];
    const leads = leadIds.length
      ? (await pool.query('SELECT id, name, notes, status, extra FROM leads WHERE id = ANY($1)', [leadIds])).rows
      : [];
    const plans = leads.map((lead) =>
      planLead(lead, allOrders.filter((o) => o.lead_id === lead.id), removedIds)
    );
    for (const p of plans) {
      out(
        p.action === 'delete'
          ? `lead    ${p.leadId}  ${p.name}  delete (every order against it was ours; ${p.droppedEntries} extra.orders entries go with it)`
          : `lead    ${p.leadId}  ${p.name}  keep, ${p.droppedEntries} extra.orders entries removed, ${p.keptOrders} real order(s) remain, status left at ${p.status}`
      );
    }

    if (!args.apply) {
      out('dry run: nothing was changed. Re-run with --apply.');
      out(`after:  ${before.orders} orders, ${before.leads} leads, ${before.events} events (unchanged)`);
      return;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM orders WHERE id = ANY($1)', [removedIds]);
      for (const p of plans) {
        if (p.action === 'delete') {
          await client.query('DELETE FROM leads WHERE id = $1', [p.leadId]);
        } else {
          await client.query('UPDATE leads SET extra = $2, notes = $3 WHERE id = $1', [
            p.leadId,
            JSON.stringify(p.extra),
            p.notes,
          ]);
        }
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const after = {
      orders: Number((await pool.query('SELECT count(*) FROM orders')).rows[0].count),
      leads: Number((await pool.query('SELECT count(*) FROM leads')).rows[0].count),
      events: Number((await pool.query('SELECT count(*) FROM events')).rows[0].count),
    };
    out(
      `removed ${remove.length} order(s), ${plans.filter((p) => p.action === 'delete').length} lead(s); ` +
        `events untouched (${before.events} before, ${after.events} after)`
    );
    out(`after:  ${after.orders} orders, ${after.leads} leads, ${after.events} events`);
    if (after.events !== before.events) throw new Error('events changed: they are the proof and must not');
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`${err.stack || err}\n`);
    process.exitCode = 1;
  });
}
