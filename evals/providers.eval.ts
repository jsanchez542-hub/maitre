import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { ModelRequest } from '../src/agent/model.js';
import { buildSystemPrompt } from '../src/agent/prompt.js';
import { toOpenAIBody } from '../src/agent/providers/openai.js';
import { DEMO_RESTAURANT } from '../src/demo/restaurant.js';
import { TOOL_DEFINITIONS } from '../src/tools.js';

/**
 * How fast each provider of a model answers the phone's real request, through
 * OpenRouter: the rules, the tools and a caller asking for a table, which the
 * model answers with a tool call.
 *
 *   npm run eval:providers
 *
 * For every route it measures, per call, the first byte, the tool's name (when
 * the phone's short line could be said) and the end, with the cached tokens
 * and the provider that served it. The first call of a route writes the cache;
 * the next ones read it, as the turns of a call do.
 *
 * Settings, from the environment or from .env:
 *   OPENROUTER_API_KEY        required
 *   MAITRE_BENCH_MODEL        default anthropic/claude-haiku-5.5
 *   MAITRE_BENCH_ROUTES       semicolon-separated: "latency", or providers in order ("google-vertex/europe")
 *   MAITRE_BENCH_CALLS        calls per route (default 4)
 */

const DEFAULT_ROUTES = ['latency', 'google-vertex/europe', 'amazon-bedrock/eu-west-1', 'azure/global', 'anthropic'];

function setting(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? fallback : value.trim();
}

interface Timing {
  route: string;
  call: number;
  servedBy?: string;
  firstByteMs?: number;
  toolNameMs?: number;
  totalMs: number;
  cachedTokens?: number;
  promptTokens?: number;
  costUsd?: number;
  error?: string;
}

/** One streamed call, timed as its bytes arrive. */
async function timedCall(apiKey: string, body: Record<string, unknown>, route: string, call: number): Promise<Timing> {
  const started = performance.now();
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', 'X-Title': 'Maitre benchmark' },
    body: JSON.stringify(body),
  });
  if (!response.ok || !response.body) return { route, call, totalMs: performance.now() - started, error: `${response.status} ${(await response.text()).slice(0, 200)}` };
  const timing: Timing = { route, call, totalMs: 0 };
  const decoder = new TextDecoder();
  let buffered = '';
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    timing.firstByteMs ??= performance.now() - started;
    buffered += decoder.decode(chunk, { stream: true });
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
      const event = JSON.parse(line.slice(6)) as {
        provider?: string;
        error?: { message?: string };
        choices?: { delta?: { tool_calls?: { function?: { name?: string } }[] } }[];
        usage?: { prompt_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }; cost?: number };
      };
      if (event.error) timing.error = String(event.error.message ?? 'error');
      if (event.provider) timing.servedBy = event.provider;
      if (timing.toolNameMs === undefined && event.choices?.[0]?.delta?.tool_calls?.some((toolCall) => toolCall.function?.name)) {
        timing.toolNameMs = performance.now() - started;
      }
      if (event.usage) {
        if (event.usage.prompt_tokens !== undefined) timing.promptTokens = event.usage.prompt_tokens;
        timing.cachedTokens = event.usage.prompt_tokens_details?.cached_tokens ?? 0;
        if (event.usage.cost !== undefined) timing.costUsd = event.usage.cost;
      }
    }
  }
  timing.totalMs = performance.now() - started;
  return timing;
}

function median(values: number[]): number | undefined {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return undefined;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

const seconds = (ms: number | undefined): string => (ms === undefined ? '-' : `${(ms / 1000).toFixed(2)} s`);

it('times each provider on the phone’s real request', async () => {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const apiKey = process.env['OPENROUTER_API_KEY'];
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is missing: put it in .env');
  const model = setting('MAITRE_BENCH_MODEL', 'anthropic/claude-haiku-5.5');
  const routes = setting('MAITRE_BENCH_ROUTES', DEFAULT_ROUTES.join(';')).split(';').map((route) => route.trim()).filter(Boolean);
  const calls = Number(setting('MAITRE_BENCH_CALLS', '4'));

  const request: ModelRequest = {
    system: buildSystemPrompt(DEMO_RESTAURANT, 'fr', 'voice', new Date()),
    transcript: [{ role: 'user', text: 'Bonsoir, je voudrais réserver une table pour quatre personnes vendredi à vingt heures.' }],
    tools: TOOL_DEFINITIONS,
    maxOutputTokens: 700,
  };
  const timings: Timing[] = [];
  for (const route of routes) {
    const provider = route === 'latency' ? { sort: 'latency' } : { order: route.split(',').map((name) => name.trim()), allow_fallbacks: false };
    const body = toOpenAIBody(request, model, { usage: { include: true }, stream: true, provider: { ...provider, data_collection: 'deny' } }, model.startsWith('anthropic/'));
    for (let call = 0; call < calls; call += 1) timings.push(await timedCall(apiKey, body, route, call));
  }

  const lines = [
    `# Provider latency, ${model}, ${new Date().toISOString()}`,
    '',
    'Medians over the calls after the first, which read the cache as a call’s later turns do. The first call writes it.',
    '',
    '| Route | Served by | First byte | Tool name | End | First call’s end | Cached tokens | Errors |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const route of routes) {
    const all = timings.filter((timing) => timing.route === route);
    const warm = all.filter((timing) => timing.call > 0 && !timing.error);
    const servedBy = [...new Set(all.map((timing) => timing.servedBy).filter(Boolean))].join(', ') || '-';
    lines.push(
      `| ${route} | ${servedBy} | ${seconds(median(warm.map((t) => t.firstByteMs ?? Number.NaN)))} | ${seconds(median(warm.map((t) => t.toolNameMs ?? Number.NaN)))} | ${seconds(median(warm.map((t) => t.totalMs)))} | ${seconds(all[0]?.totalMs)} | ${median(warm.map((t) => t.cachedTokens ?? Number.NaN)) ?? '-'} | ${all.filter((t) => t.error).length}/${all.length} |`,
    );
  }
  const spent = timings.reduce((sum, timing) => sum + (timing.costUsd ?? 0), 0);
  lines.push('', `Spent: $${spent.toFixed(4)}.`);
  for (const failed of timings.filter((timing) => timing.error)) lines.push(`- ${failed.route} call ${failed.call}: ${failed.error}`);

  const directory = join('evals', 'runs');
  mkdirSync(directory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  writeFileSync(join(directory, `${stamp}-providers.md`), lines.join('\n'));
  writeFileSync(join(directory, `${stamp}-providers.json`), JSON.stringify(timings, null, 2));
  console.log(lines.join('\n'));
  expect(timings.length).toBe(routes.length * calls);
});
