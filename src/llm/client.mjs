// Provider-agnostic chat call. This module talks to a model endpoint and
// returns text plus token counts. It knows nothing about leads, scoring or the
// digest, and it never decides whether a call is allowed - the cache and the
// budget do that before it is reached.

export const LLM_TIMEOUT_MS = 45000;
export const RETRY_BACKOFF_MS = 2000;

export class LlmError extends Error {
  constructor(message, { status = null, provider = null, retriable = false, body = null } = {}) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
    this.provider = provider;
    this.retriable = retriable;
    this.bodySample = body ? String(body).slice(0, 300) : null;
  }
}

/**
 * Provider table. Both entries speak the OpenAI chat-completions shape, which is
 * what DeepSeek publishes, so one request builder and one response reader serve
 * them. A provider that did not would get its own pair of functions here rather
 * than a branch inside the caller.
 */
export const PROVIDERS = {
  deepseek: {
    id: 'deepseek',
    defaultBaseUrl: 'https://api.deepseek.com',
    pathname: '/chat/completions',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    baseUrlEnv: 'DEEPSEEK_BASE_URL',
    defaultModel: 'deepseek-chat',
  },
  'openai-compatible': {
    id: 'openai-compatible',
    defaultBaseUrl: null,
    pathname: '/chat/completions',
    apiKeyEnv: 'LLM_API_KEY',
    baseUrlEnv: 'LLM_BASE_URL',
    defaultModel: null,
  },
};

export function providerSpec(provider) {
  const spec = PROVIDERS[provider];
  if (!spec) {
    throw new LlmError(`unknown provider: ${provider} (known: ${Object.keys(PROVIDERS).join(', ')})`);
  }
  return spec;
}

/** Resolve endpoint, key and model for a provider from the environment. */
export function resolveProvider(provider, env = process.env) {
  const spec = providerSpec(provider);
  const baseUrl = (env[spec.baseUrlEnv] || spec.defaultBaseUrl || '').replace(/\/+$/, '');
  return {
    provider: spec.id,
    baseUrl,
    url: baseUrl ? `${baseUrl}${spec.pathname}` : null,
    apiKey: env[spec.apiKeyEnv] || null,
    apiKeyEnv: spec.apiKeyEnv,
    model: env.LLM_MODEL || spec.defaultModel || null,
  };
}

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 429 and 5xx are worth one more try. 400, 401, 403 and 404 never are. */
export function isRetriable(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

function readUsage(json, fallbackText) {
  const u = (json && json.usage) || {};
  const inputTokens = Number.isFinite(u.prompt_tokens) ? u.prompt_tokens : null;
  const outputTokens = Number.isFinite(u.completion_tokens) ? u.completion_tokens : null;
  return {
    // A provider that returns no usage block still has to be charged for, so
    // fall back to a rough 4-characters-per-token estimate and mark it as such.
    inputTokens,
    outputTokens,
    estimated: inputTokens === null || outputTokens === null,
    estimatedOutputTokens: Math.ceil(String(fallbackText || '').length / 4),
  };
}

/**
 * One chat call. Returns { text, inputTokens, outputTokens, ms, estimated }.
 *
 * fetchImpl is injected so every test in this repo runs against a stub and no
 * test can reach a real endpoint by accident.
 */
export async function chat(
  { provider = 'deepseek', model, messages, maxTokens = 700, temperature = 0, jsonMode = false },
  { fetchImpl = globalThis.fetch, env = process.env, timeoutMs = LLM_TIMEOUT_MS, backoffMs = RETRY_BACKOFF_MS, sleep = sleepMs } = {}
) {
  const resolved = resolveProvider(provider, env);
  const useModel = model || resolved.model;
  if (!resolved.url) throw new LlmError(`provider ${provider} has no base URL (set ${providerSpec(provider).baseUrlEnv})`, { provider });
  if (!resolved.apiKey) throw new LlmError(`provider ${provider} has no API key (set ${resolved.apiKeyEnv})`, { provider });
  if (!useModel) throw new LlmError(`provider ${provider} has no model (set LLM_MODEL)`, { provider });
  if (!Array.isArray(messages) || !messages.length) throw new LlmError('messages must be a non-empty array', { provider });

  const body = JSON.stringify({
    model: useModel,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: false,
    ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
  });

  const attempt = async () => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const t0 = Date.now();
    try {
      const res = await fetchImpl(resolved.url, {
        method: 'POST',
        signal: ac.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${resolved.apiKey}`,
        },
        body,
      });
      const text = await res.text();
      return { status: res.status, ok: res.ok, text, ms: Date.now() - t0 };
    } finally {
      clearTimeout(timer);
    }
  };

  let res = await attempt();
  if (!res.ok && isRetriable(res.status)) {
    await sleep(backoffMs);
    const second = await attempt();
    second.ms += res.ms;
    second.retried = true;
    res = second;
  }

  if (!res.ok) {
    throw new LlmError(`${provider} responded ${res.status}`, {
      status: res.status,
      provider,
      retriable: isRetriable(res.status),
      body: res.text,
    });
  }

  let json;
  try {
    json = JSON.parse(res.text);
  } catch {
    throw new LlmError(`${provider} returned a body that is not JSON`, { provider, status: res.status, body: res.text });
  }

  const text = json?.choices?.[0]?.message?.content;
  if (typeof text !== 'string') {
    throw new LlmError(`${provider} returned no message content`, { provider, status: res.status, body: res.text });
  }

  const usage = readUsage(json, text);
  return {
    text,
    model: json.model || useModel,
    provider,
    inputTokens: usage.inputTokens ?? Math.ceil(body.length / 4),
    outputTokens: usage.outputTokens ?? usage.estimatedOutputTokens,
    tokensEstimated: usage.estimated,
    ms: res.ms,
    retried: Boolean(res.retried),
  };
}
