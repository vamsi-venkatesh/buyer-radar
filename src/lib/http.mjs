import { USER_AGENT } from '../config.mjs';

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export class HttpError extends Error {
  constructor(status, url, bodySample) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.bodySample = bodySample;
  }
}

/**
 * Minimal polite fetch wrapper. Always sends the project User-Agent and always
 * uses an AbortController timeout. Returns the response body as text plus the
 * final URL, so a redirect is visible to the caller rather than silent.
 */
export async function request(url, { method = 'GET', body, headers = {}, timeoutMs = 60000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const res = await fetch(url, {
      method,
      body,
      signal: ac.signal,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept-Language': 'en-IN,en;q=0.9',
        ...headers,
      },
    });
    const text = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      url: res.url || url,
      text,
      ms: Date.now() - startedAt,
      headers: res.headers,
    };
  } finally {
    clearTimeout(timer);
  }
}
