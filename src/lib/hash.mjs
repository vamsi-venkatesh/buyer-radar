import { createHash } from 'node:crypto';

export function sha256Hex(input) {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Stable lead id: sha256 over source + " " + external id, first 16 hex chars.
 * Deterministic across runs and machines - the same listing always gets the same id.
 */
export function leadId(source, externalId) {
  return sha256Hex(`${source} ${externalId}`).slice(0, 16);
}
