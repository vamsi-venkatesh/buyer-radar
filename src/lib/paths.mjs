import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const RUNS_DIR = path.join(ROOT, 'runs');
export const DIGESTS_DIR = path.join(ROOT, 'digests');
export const EXPORTS_DIR = path.join(ROOT, 'exports');
export const DATA_DIR = path.join(ROOT, 'data');
