import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { Replay, type Recording } from '../src/demo/replay.js';
import { DEMO_RESTAURANT } from '../src/demo/restaurant.js';
import { restaurantFingerprint } from './fingerprint.js';
import type { RunMeta, RunRecord } from './report.js';
import { NOW, SCENARIOS } from './scenarios.js';

/**
 * Writes src/demo/recordings.ts from one model's conversations in a run: for
 * each scenario, the first run that passed every check. The public demo plays
 * them again on the real engine, so it shows real replies of a real model
 * without calling one.
 *
 *   MAITRE_EVAL_EXPORT=evals/runs/<stamp>/<model>.json npm run eval:export
 */

/** What a replay needs of a tool's recorded answer: its status, where it put the table, and the identifiers it made. */
const KEPT = new Set(['status', 'holdId', 'reference', 'date', 'time', 'partySize', 'booking', 'bookings']);

function trim(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(trim);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => KEPT.has(key))
      .map(([key, item]) => [key, trim(item)]),
  );
}

it('exports recorded conversations for the demo', () => {
  const file = process.env['MAITRE_EVAL_EXPORT']?.trim() ?? '';
  if (!file || !existsSync(file)) throw new Error('Set MAITRE_EVAL_EXPORT to one model of a run, such as evals/runs/<stamp>/<model>.json');
  const records = JSON.parse(readFileSync(file, 'utf8')) as RunRecord[];
  // Files are named after the model, with its "/" written "_".
  const model = basename(file, '.json').replace('_', '/');
  const metaFile = join(dirname(file), 'meta.json');
  if (!existsSync(metaFile)) throw new Error(`${metaFile} is missing: there is no telling which restaurant this run talked about`);
  const meta = JSON.parse(readFileSync(metaFile, 'utf8')) as RunMeta;
  const restaurant = restaurantFingerprint(DEMO_RESTAURANT);
  if (meta.restaurant !== restaurant) {
    throw new Error(`This run talked about another version of the restaurant (${meta.restaurant}; now ${restaurant}). Run the evaluation again.`);
  }

  const recordings: Recording[] = [];
  const missing: string[] = [];
  for (const scenario of SCENARIOS) {
    const record = records.find((candidate) => candidate.scenario === scenario.id && candidate.passed);
    if (!record?.state || scenario.channel === 'staff') {
      missing.push(scenario.id);
      continue;
    }
    recordings.push({
      id: scenario.id,
      description: scenario.description,
      language: scenario.language,
      channel: scenario.channel,
      phone: scenario.phone,
      at: NOW.toISOString(),
      setup: scenario.setup ?? [],
      refs: record.state.refs,
      model,
      turns: record.turns.map((turn) => ({
        guest: turn.guest,
        reply: turn.reply,
        latencyMs: turn.latencyMs,
        ...(turn.costUsd === undefined ? {} : { costUsd: turn.costUsd }),
        tools: turn.tools.map(({ name, input, output }) => ({ name, input, output: trim(output) })),
      })),
    });
  }
  expect(recordings.length).toBeGreaterThan(0);

  // Nothing is written unless every conversation plays back on today's engine.
  for (const recording of recordings) {
    const replay = new Replay(recording);
    while (replay.next());
  }

  writeFileSync(
    'src/demo/recordings.ts',
    [
      `// Written by \`npm run eval:export\` from evaluation run ${basename(dirname(file))} (commit ${meta.commit}), model ${model}.`,
      '// Record again rather than edit by hand: the tests play every conversation back on the engine.',
      "import type { Recording } from './replay.js';",
      '',
      '/** The restaurant the conversations talked about. A new name, dish or opening hour means recording them again. */',
      `export const RECORDED_WITH = '${meta.restaurant}';`,
      '',
      `export const RECORDINGS: readonly Recording[] = ${JSON.stringify(recordings, null, 2)};`,
      '',
    ].join('\n'),
  );
  console.log(`${recordings.length} conversations written.${missing.length ? ` No passing run for: ${missing.join(', ')}.` : ''}`);
});
