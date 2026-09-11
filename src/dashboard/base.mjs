/** Optional URL prefix when the dashboard is served under a path (e.g. /radar). */
export const BASE = (process.env.RADAR_BASE_PATH || '').replace(/\/+$/, '');
