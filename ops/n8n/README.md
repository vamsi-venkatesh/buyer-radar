# n8n — B2B Order Operations

The automation workflow that sits between the client's own order form and this
radar, exported before and after the order-loop change of 2026-09-14. Both files
are `n8n export:workflow` output with the owning-project block, the workflow and
version ids, the credential **ids**, the owner's own number and every real
address removed. The credential *names* are kept, because a name is what a
reader needs and an id is not. No credential value has ever been in these files.

Addresses, the radar's hostname and the WhatsApp number are placeholders. Put
your own in before importing.

| File | What it is |
| --- | --- |
| `order-operations.before.json` | The workflow as it stood: never executed, a placeholder WhatsApp node and a placeholder Google Sheets node, both disabled and both marked CONFIGURE. |
| `order-operations.after.json` | The workflow as it now runs, exported back out of the live instance after the import. |

## What changed

- **Added `Radar: record order`** — an HTTP Request node posting the order to
  `https://<your radar host>/radar/orders`, authenticated with an
  `httpHeaderAuth` credential (**Radar Orders Key**) carrying the
  `x-farmquick-automation-key` header. The value is the radar's own
  `RADAR_ORDERS_KEY`.
- **Removed the placeholder WhatsApp node.** The radar sends the owner's message
  now, from the number already connected to it, and falls back to email when
  Meta refuses.
- **Configured the Google Sheets node** (`Register order in Google Sheets`):
  `appendOrUpdate`, matched on `order_id`, all fourteen columns mapped, the
  spreadsheet id and sheet name taken from `ORDERS_SHEET_ID` and
  `ORDERS_SHEET_NAME` in the n8n environment by way of the Validate node. It
  runs on its own branch after the radar node with **Continue (using regular
  output)** on error, so a missing Google credential cannot stop the radar or
  the emails — proved in practice by an execution that reported success while
  this node failed with `Can not get sheet 'By ID' with a value of ''`.
- **Extended the Validate node's output** with `business_name`, `business_type`,
  `frequency`, `volume`, `source_path`, `sheet_id`, `sheet_name` and
  `radar_order`. Every field the email nodes already used is untouched.
- Two sticky notes: the two-minute Google credential steps, and a note saying
  the owner is told by the radar rather than from here.

## Restoring or re-applying

```sh
docker exec -i <n8n container> sh -c 'cat > /tmp/wf.json && n8n import:workflow --input=/tmp/wf.json; rm -f /tmp/wf.json' < order-operations.after.json
docker exec <n8n container> n8n update:workflow --id=<workflow id> --active=true
docker restart <n8n container>
```

The credential ids are stripped from these files, so after an import the two
credentials have to be selected on their nodes. `n8n import:workflow` on a
running instance deactivates the workflow; the `update:workflow` and the restart
above are what make it live again.
