// The source table, in one place.
//
// The pipeline and the tool registry both need to know which sources exist and
// which of them are a fetch. Two copies of that list is two chances to add a
// source an agent cannot reach, so there is one copy and it lives here.

import * as overpass from './overpass.mjs';
import * as news from './news.mjs';
import * as cppp from './cppp.mjs';
import * as agmarknet from './agmarknet.mjs';
import * as institutions from './institutions.mjs';
import * as gem from './gem.mjs';
import * as registrations from './registrations.mjs';
import * as exporters from './exporters.mjs';
import * as openings from './openings.mjs';

/** Sources that go and fetch something. */
export const SOURCES = { overpass, news, cppp, agmarknet, institutions, gem, registrations, exporters };

/**
 * Lanes that are not a fetch. `openings` upgrades news signals the run already
 * holds, inside the model stage, so it is named in --sources like any other
 * source but never appears in the fetch loop.
 */
export const STAGES = { openings };

export const SOURCE_NAMES = Object.keys(SOURCES);
export const STAGE_NAMES = Object.keys(STAGES);
