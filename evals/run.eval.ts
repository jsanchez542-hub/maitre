import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { respond, type TurnResult } from '../src/agent/agent.js';
import { openRouterModel } from '../src/agent/providers/openai.js';
import { ModelError, type LanguageModel } from '../src/agent/model.js';
import { applySetup } from '../src/demo/replay.js';
import { DEMO_RESTAURANT } from '../src/demo/restaurant.js';
import { BookingEngine, type Session } from '../src/engine.js';
import { randomIds } from '../src/ids.js';
import { MemoryStore } from '../src/store.js';
import { checkScenario } from './checks.js';
import { failureLines, SUMMARY_HEADER, summaryRow, type RunRecord } from './report.js';
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

function setting(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? fallback : value.trim();
}

async function runScenario(model: LanguageModel, scenario: Scenario, run: number): Promise<RunRecord> {
  const store = new MemoryStore();
  const engine = new BookingEngine(DEMO_RESTAURANT, store, { now: () => NOW, ids: randomIds });
  const refs = applySetup(engine, scenario.setup ?? []);
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
  const errors: string[][] = [];
  let transcript: TurnResult['transcript'] = [];
  for (const message of scenario.turns) {
    const seen: string[] = [];
    const result = await respond(engine, model, session, transcript, message, {
      onError: (error) =>
        seen.push(error instanceof ModelError ? `${error.kind} ${error.status ?? ''}`.trim() : error instanceof Error ? error.message.slice(0, 80) : 'error'),
    });
    turns.push(result);
    errors.push(seen);
    transcript = result.transcript;
  }

  const snapshot = store.snapshot();
  const newBookings = snapshot.bookings.filter((booking) => !before.has(booking.id));
  const checks = checkScenario(scenario, {
    turns,
    newBookings,
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
      corrections: turn.corrections,
      errors: errors[index] ?? [],
    })),
    state: { newBookings, allBookings: snapshot.bookings, callbacks: snapshot.callbacks, refs },
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
    ...SUMMARY_HEADER,
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
    summary.push(summaryRow(id, records));
    failures.push(...failureLines(id, records));
  }

  summary.push('', `Spent: $${spent.toFixed(3)} of a $${budget} budget.`, '', '## Failures', '', ...(failures.length ? failures : ['None.']));
  writeFileSync(join(directory, 'summary.md'), `${summary.join('\n')}\n`);
  console.log(`\n${summary.join('\n')}\n\nTranscripts: ${directory}`);
}, 3_600_000);
