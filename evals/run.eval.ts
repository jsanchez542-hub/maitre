import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { respond, type TurnResult } from '../src/agent/agent.js';
import { openRouterModel } from '../src/agent/providers/openai.js';
import type { LanguageModel } from '../src/agent/model.js';
import { BookingEngine, type Session } from '../src/engine.js';
import { randomIds } from '../src/ids.js';
import { MemoryStore } from '../src/store.js';
import { checkScenario, type Check } from './checks.js';
import { EVAL_RESTAURANT } from './restaurant.js';
import { NOW, SCENARIOS, type Scenario } from './scenarios.js';

/**
 * Runs every scenario against real models through OpenRouter.
 *
 *   npm run eval
 *
 * Settings, from the environment or from .env:
 *   OPENROUTER_API_KEY        required
 *   MAITRE_EVAL_MODELS        comma-separated OpenRouter ids
 *   MAITRE_EVAL_RUNS          runs per scenario (default 3; a scenario passes when every run passes)
 *   MAITRE_EVAL_BUDGET_USD    stop starting new runs past this spend (default 2)
 *   MAITRE_EVAL_ONLY          comma-separated scenario ids
 *   MAITRE_EVAL_CONCURRENCY   conversations at once per model (default 3)
 *
 * Transcripts go to evals/runs/, which git ignores.
 */

const DEFAULT_MODELS = ['anthropic/claude-haiku-5.5', 'openai/gpt-6-luna', 'mistralai/mistral-small-2603'];

interface RunRecord {
  scenario: string;
  category: string;
  run: number;
  passed: boolean;
  skipped?: string;
  checks: Check[];
  costUsd: number;
  turns: {
    guest: string;
    reply: string;
    outcome: string;
    latencyMs: number;
    modelMs: number[];
    tools: { name: string; input: unknown; output: unknown }[];
    costUsd?: number;
  }[];
}

function setting(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? fallback : value.trim();
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] ?? 0;
}

async function runScenario(model: LanguageModel, scenario: Scenario, run: number): Promise<RunRecord> {
  const store = new MemoryStore();
  const engine = new BookingEngine(EVAL_RESTAURANT, store, { now: () => NOW, ids: randomIds });
  const refs = scenario.setup?.(engine) ?? {};
  const before = new Set(store.snapshot().bookings.map((booking) => booking.id));
  const session: Session = {
    id: `eval-${scenario.id}-${run}`,
    channel: scenario.channel,
    language: scenario.language,
    ...(scenario.phone
      ? { phone: { e164: scenario.phone, source: scenario.channel === 'voice' ? 'caller_id' : scenario.channel === 'whatsapp' ? 'whatsapp' : 'form' } }
      : {}),
  };

  const turns: TurnResult[] = [];
  let transcript: TurnResult['transcript'] = [];
  for (const message of scenario.turns) {
    const result = await respond(engine, model, session, transcript, message);
    turns.push(result);
    transcript = result.transcript;
  }

  const snapshot = store.snapshot();
  const checks = checkScenario(scenario, {
    turns,
    newBookings: snapshot.bookings.filter((booking) => !before.has(booking.id)),
    allBookings: snapshot.bookings,
    callbacks: snapshot.callbacks,
    refs,
    phone: scenario.phone,
  });
  return {
    scenario: scenario.id,
    category: scenario.category,
    run,
    passed: checks.every((check) => check.ok),
    checks,
    costUsd: turns.reduce((sum, turn) => sum + (turn.costUsd ?? 0), 0),
    turns: turns.map((turn, index) => ({
      guest: scenario.turns[index] ?? '',
      reply: turn.reply,
      outcome: turn.outcome,
      latencyMs: turn.latencyMs,
      modelMs: turn.modelMs,
      tools: turn.tools.map(({ name, input, output }) => ({ name, input, output })),
      ...(turn.costUsd === undefined ? {} : { costUsd: turn.costUsd }),
    })),
  };
}

/** Runs tasks with at most `limit` at once, in order of submission. */
async function pool<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < tasks.length) {
      const index = next;
      next += 1;
      const task = tasks[index];
      if (task) results[index] = await task();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

it('runs the evaluation against real models', async () => {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const apiKey = process.env['OPENROUTER_API_KEY'];
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is missing: put it in .env');

  const models = setting('MAITRE_EVAL_MODELS', DEFAULT_MODELS.join(',')).split(',').map((id) => id.trim()).filter(Boolean);
  const runs = Number(setting('MAITRE_EVAL_RUNS', '3'));
  const budget = Number(setting('MAITRE_EVAL_BUDGET_USD', '2'));
  const concurrency = Number(setting('MAITRE_EVAL_CONCURRENCY', '3'));
  const only = setting('MAITRE_EVAL_ONLY', '').split(',').map((id) => id.trim()).filter(Boolean);
  const scenarios = only.length ? SCENARIOS.filter((scenario) => only.includes(scenario.id)) : SCENARIOS;
  expect(scenarios.length).toBeGreaterThan(0);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const directory = join('evals', 'runs', stamp);
  mkdirSync(directory, { recursive: true });

  let spent = 0;
  const summary: string[] = [
    `# Evaluation ${stamp}`,
    '',
    `${scenarios.length} scenarios, ${runs} runs each. A scenario passes when every run passes.`,
    '',
    '| Model | Scenarios passed | Runs passed | Turn latency p50 | p95 | Cost |',
    '|---|---|---|---|---|---|',
  ];
  const failures: string[] = [];

  for (const id of models) {
    const model = openRouterModel({ apiKey, model: id });
    const tasks = scenarios.flatMap((scenario) =>
      Array.from({ length: runs }, (_, run) => async (): Promise<RunRecord> => {
        if (spent >= budget) {
          return { scenario: scenario.id, category: scenario.category, run, passed: false, skipped: 'budget', checks: [], costUsd: 0, turns: [] };
        }
        try {
          const record = await runScenario(model, scenario, run + 1);
          spent += record.costUsd;
          return record;
        } catch (error) {
          return {
            scenario: scenario.id,
            category: scenario.category,
            run,
            passed: false,
            skipped: error instanceof Error ? error.message.slice(0, 200) : 'error',
            checks: [],
            costUsd: 0,
            turns: [],
          };
        }
      }),
    );
    const records = await pool(tasks, concurrency);
    writeFileSync(join(directory, `${id.replace(/[/:]/g, '_')}.json`), JSON.stringify(records, null, 2));

    const byScenario = new Map<string, RunRecord[]>();
    for (const record of records) byScenario.set(record.scenario, [...(byScenario.get(record.scenario) ?? []), record]);
    const scenariosPassed = [...byScenario.values()].filter((group) => group.every((record) => record.passed)).length;
    const runsPassed = records.filter((record) => record.passed).length;
    const latencies = records.flatMap((record) => record.turns.map((turn) => turn.latencyMs));
    const cost = records.reduce((sum, record) => sum + record.costUsd, 0);
    summary.push(
      `| ${id} | ${scenariosPassed}/${byScenario.size} | ${runsPassed}/${records.length} | ${(percentile(latencies, 0.5) / 1000).toFixed(1)} s | ${(percentile(latencies, 0.95) / 1000).toFixed(1)} s | $${cost.toFixed(3)} |`,
    );
    for (const record of records.filter((candidate) => !candidate.passed)) {
      const failed = record.skipped ? [`skipped: ${record.skipped}`] : record.checks.filter((check) => !check.ok).map((check) => `${check.name}${check.detail ? ` (${check.detail})` : ''}`);
      failures.push(`- ${id} · ${record.scenario} · run ${record.run}: ${failed.join('; ')}`);
    }
  }

  summary.push('', `Spent: $${spent.toFixed(3)} of a $${budget} budget.`, '', '## Failures', '', ...(failures.length ? failures : ['None.']));
  writeFileSync(join(directory, 'summary.md'), `${summary.join('\n')}\n`);
  console.log(`\n${summary.join('\n')}\n\nTranscripts: ${directory}`);
}, 3_600_000);
