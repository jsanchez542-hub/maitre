import { describe, expect, it } from 'vitest';
import type { Fetch, HttpRequest } from '../src/agent/http.js';
import { ModelError, type ModelRequest, type TranscriptEntry } from '../src/agent/model.js';
import { anthropicModel, fromAnthropicAnswer, toAnthropicBody } from '../src/agent/providers/anthropic.js';
import { fromOpenAIAnswer, openRouterModel, toOpenAIBody } from '../src/agent/providers/openai.js';
import { sanitizeReply } from '../src/agent/sanitize.js';
import { TOOL_DEFINITIONS } from '../src/tools.js';

const transcript: TranscriptEntry[] = [
  { role: 'user', text: 'Une table pour 4 vendredi ?' },
  { role: 'user', text: 'À 20 h' },
  {
    role: 'assistant',
    text: '',
    toolCalls: [{ id: 'call-1', name: 'find_table', input: { day: 'friday', time: '20:00', partySize: 4 } }],
  },
  { role: 'tool', callId: 'call-1', name: 'find_table', output: { status: 'available', holdId: 'h1' } },
  { role: 'assistant', text: 'C’est noté. À quel nom ?', toolCalls: [] },
];

const request: ModelRequest = {
  system: { stable: 'RULES', dynamic: 'TODAY', now: 'NOW' },
  transcript,
  tools: TOOL_DEFINITIONS.slice(0, 1),
  maxOutputTokens: 500,
};

describe('Anthropic format', () => {
  it('alternates turns, caches the rules and keeps tool calls with their results', () => {
    const body = toAnthropicBody(request, 'claude-test');
    expect(body['system']).toEqual([
      { type: 'text', text: 'RULES', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'TODAY' },
    ]);
    const messages = body['messages'] as { role: string; content: { type: string }[] }[];
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    // The two guest messages, then the time, after the last one: it changes every minute, so it never comes before what is cached.
    expect(messages[0]?.content).toEqual([
      { type: 'text', text: 'Une table pour 4 vendredi ?' },
      { type: 'text', text: 'À 20 h' },
      { type: 'text', text: 'NOW', cache_control: { type: 'ephemeral' } },
    ]);
    expect(messages[1]?.content.map((block) => block.type)).toEqual(['tool_use']);
    expect(messages[2]?.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'call-1' });
    expect(body['tools']).toEqual([
      { name: 'find_table', description: TOOL_DEFINITIONS[0]?.description, input_schema: TOOL_DEFINITIONS[0]?.inputSchema },
    ]);
  });

  it('reads text, tool calls and every kind of input token', () => {
    expect(
      fromAnthropicAnswer({
        content: [
          { type: 'text', text: 'Je regarde.' },
          { type: 'tool_use', id: 't1', name: 'find_table', input: { time: '20:00' } },
        ],
        usage: { input_tokens: 50, output_tokens: 12, cache_creation_input_tokens: 2000, cache_read_input_tokens: 0 },
      }),
    ).toEqual({
      text: 'Je regarde.',
      toolCalls: [{ id: 't1', name: 'find_table', input: { time: '20:00' } }],
      usage: { inputTokens: 50, cacheWriteTokens: 2000, cachedInputTokens: 0, outputTokens: 12 },
    });
    expect(() => fromAnthropicAnswer({})).toThrow(ModelError);
  });
});

describe('OpenAI format', () => {
  it('puts the stable rules first and sends tool calls and results the OpenAI way', () => {
    const body = toOpenAIBody(request, 'gpt-test', { usage: { include: true } });
    const messages = body['messages'] as Record<string, unknown>[];
    expect(messages[0]).toEqual({ role: 'system', content: 'RULES\n\nTODAY' });
    expect(messages[2]).toEqual({ role: 'user', content: 'À 20 h\n\nNOW' });
    expect(messages.map((message) => message['role'])).toEqual(['system', 'user', 'user', 'assistant', 'tool', 'assistant']);
    expect(messages[3]).toMatchObject({ content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'find_table' } }] });
    expect(messages[4]).toEqual({ role: 'tool', tool_call_id: 'call-1', content: '{"status":"available","holdId":"h1"}' });
    expect(body['usage']).toEqual({ include: true });
  });

  it('keeps provider extras from overriding the request itself', () => {
    const body = toOpenAIBody(request, 'gpt-test', { model: 'something-else', messages: [] });
    expect(body['model']).toBe('gpt-test');
    expect((body['messages'] as unknown[]).length).toBe(6);
  });

  it('marks the cacheable prefix where the provider must be told: the rules, and the guest’s last message', () => {
    const messages = toOpenAIBody(request, 'anthropic/test', {}, true)['messages'] as Record<string, unknown>[];
    expect(messages[0]).toEqual({
      role: 'system',
      content: [
        { type: 'text', text: 'RULES', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'TODAY' },
      ],
    });
    const guests = messages.filter((message) => message['role'] === 'user');
    expect(typeof guests[0]?.['content']).toBe('string');
    expect(guests.at(-1)?.['content']).toEqual([
      { type: 'text', text: 'À 20 h' },
      { type: 'text', text: 'NOW', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('caches the conversation up to the reply that ended the turn before, which the next turn starts with', () => {
    const next: ModelRequest = { ...request, transcript: [...transcript, { role: 'user', text: 'Dupont' }] };
    const messages = toOpenAIBody(next, 'anthropic/test', {}, true)['messages'] as Record<string, unknown>[];
    expect(messages.at(-2)).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'C’est noté. À quel nom ?', cache_control: { type: 'ephemeral' } }] });
    expect(messages.at(-1)).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'Dupont' },
        { type: 'text', text: 'NOW', cache_control: { type: 'ephemeral' } },
      ],
    });
    // Three breakpoints in all, within the four Anthropic allows.
    expect(JSON.stringify(messages).match(/cache_control/g)).toHaveLength(3);
    const anthropic = toAnthropicBody(next, 'claude-test')['messages'] as { role: string; content: Record<string, unknown>[] }[];
    expect(anthropic.at(-2)?.content.at(-1)).toEqual({ type: 'text', text: 'C’est noté. À quel nom ?', cache_control: { type: 'ephemeral' } });
    expect(anthropic.at(-1)?.content.at(-1)).toEqual({ type: 'text', text: 'NOW', cache_control: { type: 'ephemeral' } });
  });

  it('reads cached tokens, the reported cost and malformed arguments', () => {
    const answer = fromOpenAIAnswer({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              { id: 'a', function: { name: 'find_table', arguments: '{"time":"20:00"}' } },
              { id: 'b', function: { name: 'find_table', arguments: '{not json' } },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 3000, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 2500 }, cost: 0.00042 },
      provider: 'Amazon Bedrock',
    });
    expect(answer.toolCalls).toEqual([
      { id: 'a', name: 'find_table', input: { time: '20:00' } },
      { id: 'b', name: 'find_table', input: undefined },
    ]);
    expect(answer.usage).toEqual({ inputTokens: 500, cacheWriteTokens: 0, cachedInputTokens: 2500, outputTokens: 40 });
    expect(answer.costUsd).toBe(0.00042);
    expect(answer.servedBy).toBe('Amazon Bedrock');
  });
});

/** A fetch that answers from a list and records what it was sent. */
function fakeFetch(answers: { status: number; body: string; headers?: Record<string, string> }[]) {
  const sent: { url: string; init: HttpRequest }[] = [];
  const fetch: Fetch = async (url, init) => {
    sent.push({ url, init });
    const answer = answers.shift();
    if (!answer) throw new Error('no more answers');
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      headers: { get: (name: string) => answer.headers?.[name.toLowerCase()] ?? null },
      text: async () => answer.body,
    };
  };
  return { fetch, sent };
}

const OK_ANTHROPIC = JSON.stringify({ content: [{ type: 'text', text: 'Bonjour' }], usage: { input_tokens: 10, output_tokens: 2 } });

describe('calling a provider', () => {
  it('gives up on an answer whose headers came and whose body never does (a call hung 451 s on 12 October)', async () => {
    let calls = 0;
    const stalled: Fetch = async () => {
      calls += 1;
      return { ok: true, status: 200, headers: { get: () => null }, text: () => new Promise<string>(() => undefined) };
    };
    const model = openRouterModel({ apiKey: 'k', model: 'anthropic/claude-haiku-5.5', fetch: stalled, timeoutMs: 50, maxRetries: 1 });
    const started = Date.now();
    const error = (await model.complete(request).catch((caught: unknown) => caught)) as ModelError;
    expect(error).toBeInstanceOf(ModelError);
    expect(error.kind).toBe('timeout');
    // Asked twice, each time cut at its limit, instead of waiting for the connection to die.
    expect(calls).toBe(2);
    // Two 50 ms limits and one short wait; seconds, not minutes, even on a busy machine.
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it('retries when the provider is overloaded, then answers', async () => {
    const { fetch, sent } = fakeFetch([
      { status: 529, body: '{"error":{"message":"Overloaded"}}', headers: { 'retry-after': '0' } },
      { status: 200, body: OK_ANTHROPIC },
    ]);
    const model = anthropicModel({ apiKey: 'test-key-123', model: 'claude-test', fetch, maxRetries: 2 });
    await expect(model.complete(request)).resolves.toMatchObject({ text: 'Bonjour' });
    expect(sent).toHaveLength(2);
    expect(sent[0]?.init.headers['x-api-key']).toBe('test-key-123');
  });

  it('does not retry a bad key, and never puts the key in the error', async () => {
    const { fetch, sent } = fakeFetch([{ status: 401, body: '{"error":{"message":"invalid x-api-key"}}' }]);
    const model = anthropicModel({ apiKey: 'secret-key-should-not-leak', model: 'claude-test', fetch });
    const error = await model.complete(request).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ModelError);
    expect((error as ModelError).kind).toBe('auth');
    expect(String((error as ModelError).message)).not.toContain('secret-key-should-not-leak');
    expect(sent).toHaveLength(1);
  });

  it('tells an exhausted OpenRouter or OpenAI credit apart from a rate limit', async () => {
    const { fetch, sent } = fakeFetch([{ status: 429, body: '{"error":{"code":"insufficient_quota","message":"quota"}}' }]);
    const model = openRouterModel({ apiKey: 'k', model: 'anthropic/claude-haiku-5.5', fetch });
    const error = (await model.complete(request).catch((caught: unknown) => caught)) as ModelError;
    expect(error.kind).toBe('quota');
    expect(sent).toHaveLength(1);
  });

  it('asks OpenRouter for the cost and for providers that keep no data', async () => {
    const { fetch, sent } = fakeFetch([
      { status: 200, body: JSON.stringify({ choices: [{ message: { content: 'Bonjour' } }], usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.0001 } }) },
    ]);
    const model = openRouterModel({ apiKey: 'k', model: 'anthropic/claude-haiku-5.5', fetch });
    const answer = await model.complete(request);
    expect(model.id).toBe('openrouter:anthropic/claude-haiku-5.5');
    expect(answer.costUsd).toBe(0.0001);
    expect(sent[0]?.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    const body = JSON.parse(sent[0]?.init.body ?? '{}') as Record<string, unknown>;
    expect(body['provider']).toEqual({ data_collection: 'deny' });
    expect(body['usage']).toEqual({ include: true });
  });

  it('routes a model to the fastest provider, or to the ones named after an @, still keeping no data', async () => {
    const reply = { status: 200, body: JSON.stringify({ choices: [{ message: { content: 'Bonjour' } }], usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.0001 } }) };
    const sentBody = async (model: string) => {
      const { fetch, sent } = fakeFetch([reply]);
      await openRouterModel({ apiKey: 'k', model, fetch }).complete(request);
      return JSON.parse(sent[0]?.init.body ?? '{}') as Record<string, unknown>;
    };
    expect(await sentBody('openai/gpt-oss-120b@Cerebras, Groq')).toMatchObject({
      model: 'openai/gpt-oss-120b',
      provider: { order: ['Cerebras', 'Groq'], data_collection: 'deny' },
    });
    expect(await sentBody('anthropic/claude-haiku-5.5@latency')).toMatchObject({
      model: 'anthropic/claude-haiku-5.5',
      provider: { sort: 'latency', data_collection: 'deny' },
    });
    // A provider's region is part of its name: the configured route keeps conversations in the EU first.
    expect(await sentBody('anthropic/claude-haiku-5.5@google-vertex/europe,amazon-bedrock/eu-west-1,anthropic')).toMatchObject({
      model: 'anthropic/claude-haiku-5.5',
      provider: { order: ['google-vertex/europe', 'amazon-bedrock/eu-west-1', 'anthropic'], data_collection: 'deny' },
    });
  });

  it('tells Anthropic’s models where to cache, and leaves the others to cache on their own', async () => {
    const reply = { status: 200, body: JSON.stringify({ choices: [{ message: { content: 'Bonjour' } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }) };
    const system = async (model: string) => {
      const { fetch, sent } = fakeFetch([reply]);
      await openRouterModel({ apiKey: 'k', model, fetch }).complete(request);
      return (JSON.parse(sent[0]?.init.body ?? '{}') as { messages: { content: unknown }[] }).messages[0]?.content;
    };
    expect(Array.isArray(await system('anthropic/claude-haiku-5.5@latency'))).toBe(true);
    expect(typeof (await system('google/gemini-3.1-flash-lite'))).toBe('string');
  });
});

describe('reply cleaning', () => {
  it('removes markdown and turns dashes into the punctuation a person would use', () => {
    expect(sanitizeReply('**Parfait** — à vendredi.', 'web')).toBe('Parfait, à vendredi.');
    expect(sanitizeReply('Ouvert de 12–14 h', 'web')).toBe('Ouvert de 12-14 h');
    expect(sanitizeReply('## Horaires\nMidi et soir', 'whatsapp')).toBe('Horaires\nMidi et soir');
  });

  it('turns a list into one spoken sentence on the phone and drops emoji', () => {
    expect(sanitizeReply('Deux options 🙂\n- 19 h\n- 21 h', 'voice')).toBe('Deux options 19 h 21 h');
  });

  it('keeps the non-breaking spaces of French punctuation', () => {
    expect(sanitizeReply('À quel nom ?', 'web')).toBe('À quel nom ?');
  });

  it('puts French punctuation right without touching times or web addresses', () => {
    expect(sanitizeReply('Au nom de qui dois-je réserver ?', 'web', 'fr')).toBe('Au nom de qui dois-je réserver ?');
    expect(sanitizeReply('Parfait!', 'web', 'fr')).toBe('Parfait !');
    expect(sanitizeReply('Le plat « Confit » : sans gluten.', 'web', 'fr')).toBe('Le plat « Confit » : sans gluten.');
    expect(sanitizeReply('À 20:30, voir https://exemple.fr/?q=1', 'web', 'fr')).toBe('À 20:30, voir https://exemple.fr/?q=1');
    // English keeps its own rule: no space before a question mark.
    expect(sanitizeReply('Which name ?', 'web', 'en')).toBe('Which name ?');
  });

  it('keeps one narrow space inside « » when the sheet’s sentence already has it, and gives a time its space back', () => {
    // « Mousse came out as «  Mousse: a wide gap after « and a narrow one before » (seen live, 15 October).
    expect(sanitizeReply('Le plat « Mousse au chocolat » ne précise pas.', 'web', 'fr')).toBe('Le plat « Mousse au chocolat » ne précise pas.');
    expect(sanitizeReply('Le plat « Mousse au chocolat» ne précise pas.', 'web', 'fr')).toBe('Le plat « Mousse au chocolat » ne précise pas.');
    // The model copied the time's no-break spaces and lost the one after it (seen live, 15 October).
    expect(sanitizeReply('Une table à 21 h 30est disponible.', 'web', 'fr')).toBe('Une table à 21 h 30 est disponible.');
    expect(sanitizeReply('Une table à 21 h 30 est disponible.', 'web', 'fr')).toBe('Une table à 21 h 30 est disponible.');
  });

  it('stays fast on hostile input', () => {
    const hostile = `${'*'.repeat(20_000)}${'—'.repeat(20_000)}`;
    const started = Date.now();
    sanitizeReply(hostile, 'voice');
    // A pattern that backtracks would take minutes on this input; the bound leaves room for a busy machine.
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
