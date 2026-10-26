import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { expect, it } from 'vitest';
import type { Correction, TurnOutcome } from '../src/agent/agent.js';
import { NO_USAGE } from '../src/agent/model.js';
import type { Booking, CallbackRequest } from '../src/store.js';
import type { ToolOutput } from '../src/tools.js';
import { checkScenario, type Outcome } from './checks.js';
import { failureLines, SUMMARY_HEADER, summaryRow, type RunRecord } from './report.js';
import { guestNumber, ON_THE_PHONE, SCENARIOS, type Scenario } from './scenarios.js';

/**
 * Scores a recorded run again with the scenarios as they are now, without
 * calling any model. When a check turns out to be wrong, its fix is measured
 * on the very conversations that exposed it.
 *
 *   MAITRE_EVAL_RESCORE=evals/runs/<stamp> npm run eval:rescore
 *
 * Writes summary.rescored.md next to the original summary, which stays as it
 * was, and lists every run whose verdict changed.
 */

function outcomeOf(record: RunRecord, scenario: Scenario, state: NonNullable<RunRecord['state']>): Outcome {
  return {
    turns: record.turns.map((turn) => ({
      reply: turn.reply,
      transcript: [],
      tools: turn.tools.map((tool) => ({ name: tool.name, input: tool.input, output: tool.output as ToolOutput, ms: 0 })),
      usage: NO_USAGE,
      ...(turn.costUsd === undefined ? {} : { costUsd: turn.costUsd }),
      modelCalls: turn.modelMs.length,
      latencyMs: turn.latencyMs,
      modelMs: turn.modelMs,
      outcome: turn.outcome as TurnOutcome,
      corrections: turn.corrections as Correction[],
    })),
    newBookings: state.newBookings as Booking[],
    allBookings: state.allBookings as Booking[],
    callbacks: state.callbacks as CallbackRequest[],
    refs: state.refs,
    phone: guestNumber(scenario),
  };
}

function rescore(record: RunRecord): RunRecord {
  if (record.skipped) return record;
  // A run of either set: the phone's scenarios carry ids of their own ("voice-…").
  const scenario = [...SCENARIOS, ...ON_THE_PHONE].find((candidate) => candidate.id === record.scenario);
  // The number typed in the field follows the guest's message at `afterTurn`, as its own turn.
  const typed = record.turns.findIndex((turn) => turn.fieldPhone);
  const sameField = scenario?.fieldPhone
    ? typed === scenario.fieldPhone.afterTurn + 1 && record.turns[typed]?.fieldPhone === scenario.fieldPhone.phone
    : typed === -1;
  const written = record.turns.filter((turn) => turn.guest !== undefined).map((turn) => turn.guest);
  const unchanged = scenario && sameField && scenario.turns.join('\n') === written.join('\n');
  if (!scenario || !unchanged) return { ...record, passed: false, checks: [], skipped: 'the scenario changed since this run' };
  if (!record.state) return { ...record, passed: false, checks: [], skipped: 'recorded before runs kept their state' };
  const checks = checkScenario(scenario, outcomeOf(record, scenario, record.state));
  return { ...record, checks, passed: checks.every((check) => check.ok) };
}

it('scores a recorded run again with the current checks', () => {
  const directory = process.env['MAITRE_EVAL_RESCORE']?.trim() ?? '';
  if (!directory || !existsSync(directory)) throw new Error('Set MAITRE_EVAL_RESCORE to a run directory, such as evals/runs/<stamp>');
  // One file per model; meta.json says what the run was made with.
  const files = readdirSync(directory)
    .filter((name) => name.endsWith('.json') && name !== 'meta.json')
    .sort();
  expect(files.length).toBeGreaterThan(0);

  const summary = [
    `# Evaluation ${basename(directory)}, scored again`,
    '',
    'The same conversations, checked against the scenarios as they are now. No model was called.',
    '',
    ...SUMMARY_HEADER,
  ];
  const changes: string[] = [];
  const failures: string[] = [];
  for (const file of files) {
    // Files are named after the model, with its "/" written "_".
    const id = file.replace(/\.json$/, '').replace('_', '/');
    const before = JSON.parse(readFileSync(join(directory, file), 'utf8')) as RunRecord[];
    const after = before.map(rescore);
    after.forEach((record, index) => {
      const old = before[index];
      if (old && old.passed !== record.passed) {
        changes.push(`- ${id}, ${record.scenario}, run ${record.run}: ${old.passed ? 'passed' : 'failed'}, now ${record.passed ? 'passes' : 'fails'}`);
      }
    });
    summary.push(summaryRow(id, after));
    failures.push(...failureLines(id, after));
  }

  summary.push('', '## Verdicts that changed', '', ...(changes.length ? changes : ['None.']), '', '## Failures', '', ...(failures.length ? failures : ['None.']));
  writeFileSync(join(directory, 'summary.rescored.md'), `${summary.join('\n')}\n`);
  console.log(`\n${summary.join('\n')}\n`);
});
