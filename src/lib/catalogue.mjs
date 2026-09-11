// The supplier's catalogue and its mapping onto Agmarknet commodity names.
//
// Both come from the client profile (config/client.json, or the worked example
// beside it). A null commodity means Agmarknet carries no mandi line for that
// item - the price sheet says "no mandi quote" rather than guessing one - and
// `approx` marks an item priced off a nearby line (zucchini off squash), which
// the price sheet shows with a ~ instead of implying an exact quote.

import { CLIENT } from '../client.mjs';

/** The catalogue in profile order. */
export function catalogueItems() {
  return CLIENT.catalogue.items.map((i) => ({ ...i }));
}

const BY_ID = new Map(CLIENT.catalogue.items.map((i) => [i.id, i]));

export function label(id) {
  const item = BY_ID.get(id);
  if (item) return item.label;
  return id.charAt(0).toUpperCase() + id.slice(1).replace(/-/g, ' ');
}
