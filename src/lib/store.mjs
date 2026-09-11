import { createJsonStore } from './store-json.mjs';

/**
 * Pick a store. Postgres when DATABASE_URL is present, otherwise the JSON file
 * store under data/ so the pipeline runs with no database at all.
 */
export async function openStore({
  databaseUrl = process.env.DATABASE_URL,
  dataDir = process.env.RADAR_DATA_DIR || undefined,
} = {}) {
  let store;
  if (databaseUrl) {
    const { createPgStore } = await import('./store-pg.mjs');
    store = await createPgStore(databaseUrl);
  } else {
    store = createJsonStore(dataDir ? { dataDir } : {});
  }
  await store.init();
  return store;
}
