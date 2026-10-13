import { describe, expect, it } from 'vitest';
import { ModelError, type LanguageModel, type ModelRequest } from '../src/agent/model.js';
import { withFallback } from '../src/agent/providers/fallback.js';
import { buildSystemPrompt } from '../src/agent/prompt.js';
import { TOOL_DEFINITIONS } from '../src/tools.js';
import { TEST_CONFIG } from './fixtures.js';

const request: ModelRequest = {
  system: buildSystemPrompt(TEST_CONFIG, 'fr', 'web', new Date('2026-10-14T08:00:00Z')),
  transcript: [{ role: 'user', text: 'Bonjour' }],
  tools: TOOL_DEFINITIONS,
  maxOutputTokens: 100,
};

function model(id: string, answer: () => Promise<string>): LanguageModel & { calls: number } {
  return {
    id,
    calls: 0,
    async complete() {
      this.calls += 1;
      const text = await answer();
      return { text, toolCalls: [], usage: { inputTokens: 1, cacheWriteTokens: 0, cachedInputTokens: 0, outputTokens: 1 } };
    },
  };
}

const failing = (kind: ConstructorParameters<typeof ModelError>[0]) => () => Promise.reject(new ModelError(kind, `primary: ${kind}`));

describe('a model with a fallback', () => {
  it('answers with the second model when the first is down, stalled or overloaded, and says so', async () => {
    for (const kind of ['timeout', 'network', 'rate_limited', 'overloaded', 'server'] as const) {
      const heard: ModelError[] = [];
      const primary = model('openrouter:primary', failing(kind));
      const fallback = model('openrouter:fallback', async () => 'Bonjour, que puis-je faire pour vous ?');
      const answer = await withFallback(primary, fallback, (error) => heard.push(error)).complete(request);
      expect(answer.text, kind).toBe('Bonjour, que puis-je faire pour vous ?');
      expect(heard.map((error) => error.kind)).toEqual([kind]);
      expect(fallback.calls).toBe(1);
    }
  });

  it('leaves the second model alone when the first answers', async () => {
    const primary = model('openrouter:primary', async () => 'Bonjour.');
    const fallback = model('openrouter:fallback', async () => 'Ne devrait pas répondre.');
    const both = withFallback(primary, fallback);
    expect((await both.complete(request)).text).toBe('Bonjour.');
    expect(fallback.calls).toBe(0);
    // Reports name the model that was chosen, not the one kept in reserve.
    expect(both.id).toBe('openrouter:primary');
  });

  it('passes on what another model could not fix: a bad key, a refused request, an exhausted credit', async () => {
    for (const kind of ['auth', 'bad_request', 'quota'] as const) {
      const fallback = model('openrouter:fallback', async () => 'Ne devrait pas répondre.');
      const error = await withFallback(model('openrouter:primary', failing(kind)), fallback)
        .complete(request)
        .catch((caught: unknown) => caught);
      expect((error as ModelError).kind, kind).toBe(kind);
      expect(fallback.calls).toBe(0);
    }
  });
});
