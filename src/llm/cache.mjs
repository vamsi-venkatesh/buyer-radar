import { sha256Hex } from '../lib/hash.mjs';

/**
 * Content-addressed cache for model answers.
 *
 * The key is a hash of everything that could change the answer: the provider,
 * the model, the prompt version and the exact input text. Change any one of them
 * and the key changes, so a cached answer can never be served for a question
 * that was not asked. There is no expiry: the same four inputs describe the same
 * question forever, and a stale answer is impossible by construction.
 */
export function cacheKey({ provider, model, promptVersion, input }) {
  return sha256Hex(
    [
      'buyer-radar/llm-cache/v1',
      String(provider || ''),
      String(model || ''),
      String(promptVersion || ''),
      String(input || ''),
    ].join('\n')
  );
}

/** The hash of the input alone, recorded in receipts so a call can be traced without storing the page. */
export function inputHash(input) {
  return sha256Hex(String(input || ''));
}

/**
 * Cache over any store that implements getLlmCache / putLlmCache.
 * A hit costs nothing and is receipted as llm.cache_hit by the caller.
 */
export function createCache(store) {
  return {
    key: cacheKey,

    async get(parts) {
      const key = cacheKey(parts);
      const row = await store.getLlmCache(key);
      return row ? { key, hit: true, ...row } : { key, hit: false, value: null };
    },

    async put(parts, value, meta = {}) {
      const key = cacheKey(parts);
      await store.putLlmCache({
        key,
        provider: parts.provider,
        model: parts.model,
        prompt_version: parts.promptVersion,
        input_hash: inputHash(parts.input),
        value,
        at: meta.at || new Date().toISOString(),
        input_tokens: meta.inputTokens ?? null,
        output_tokens: meta.outputTokens ?? null,
        cost_inr: meta.costInr ?? null,
      });
      return key;
    },
  };
}
