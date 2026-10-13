import { ModelError, type LanguageModel } from '../model.js';

/**
 * A model that answers with the first one, and with the second when the first
 * fails in a way another model can help with: a provider down, overloaded,
 * rate-limited or stalled. A bad key, a refused request or an exhausted credit
 * would fail the second one too, so those are passed on as they are.
 *
 * The guest never knows: the same conversation, tool results included, goes to
 * the second model. The second one must have passed the same evaluation.
 */
export function withFallback(primary: LanguageModel, fallback: LanguageModel, onFallback?: (error: ModelError) => void): LanguageModel {
  return {
    id: primary.id,
    async complete(request) {
      try {
        return await primary.complete(request);
      } catch (error) {
        if (!(error instanceof ModelError) || !error.retryable) throw error;
        onFallback?.(error);
        return fallback.complete(request);
      }
    },
  };
}
