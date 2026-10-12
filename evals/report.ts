import type { Check } from './checks.js';

/** One conversation of one scenario against one model, as written to evals/runs/. */
export interface RunRecord {
  scenario: string;
  category: string;
  run: number;
  passed: boolean;
  skipped?: string;
  checks: Check[];
  costUsd: number;
  turns: {
    /** What the guest wrote; missing on the turn the number typed in the web chat's field set going. */
    guest?: string;
    /** The number typed in the web chat's field, which this turn followed. */
    fieldPhone?: string;
    reply: string;
    outcome: string;
    latencyMs: number;
    modelMs: number[];
    tools: { name: string; input: unknown; output: unknown }[];
    costUsd?: number;
    corrections: string[];
    /** Failed model calls, by kind: "rate_limited 429" means the provider refused, not that the model got it wrong. */
    errors: string[];
  }[];
  /** What the conversation left behind, so a run can be scored again without calling the model. */
  state?: { newBookings: unknown[]; allBookings: unknown[]; callbacks: unknown[]; refs: Record<string, string> };
}

/** Written next to a run's results as meta.json. */
export interface RunMeta {
  commit: string;
  uncommittedChanges: boolean;
  /** `restaurantFingerprint` of the restaurant the conversations talked about. */
  restaurant: string;
}

export const SUMMARY_HEADER = [
  '| Model | Scenarios passed | Runs passed | Turn latency p50 | p95 | First model answer p50 | p95 | Guard fired | Provider errors | Cost |',
  '|---|---|---|---|---|---|---|---|---|---|',
];

export function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] ?? 0;
}

/** The summary table's row for one model. A scenario passes when every one of its runs passes. */
export function summaryRow(id: string, records: RunRecord[]): string {
  const byScenario = new Map<string, RunRecord[]>();
  for (const record of records) byScenario.set(record.scenario, [...(byScenario.get(record.scenario) ?? []), record]);
  const scenariosPassed = [...byScenario.values()].filter((group) => group.every((record) => record.passed)).length;
  const runsPassed = records.filter((record) => record.passed).length;
  const latencies = records.flatMap((record) => record.turns.map((turn) => turn.latencyMs));
  const cost = records.reduce((sum, record) => sum + record.costUsd, 0);
  const guarded = records.reduce((sum, record) => sum + record.turns.filter((turn) => turn.corrections.length > 0).length, 0);
  const turnCount = records.reduce((sum, record) => sum + record.turns.length, 0);
  // A turn whose model calls all failed says nothing about the model's judgement, only about its provider.
  const providerFailed = records.reduce(
    (sum, record) => sum + record.turns.filter((turn) => turn.errors.length > 0 && turn.outcome !== 'answered').length,
    0,
  );
  // On the phone, the first answer is when the caller hears something: the reply, or the short line said while the tools run.
  const firstAnswers = records.flatMap((record) => record.turns.flatMap((turn) => (turn.modelMs[0] === undefined ? [] : [turn.modelMs[0]])));
  const seconds = (values: number[], fraction: number): string => `${(percentile(values, fraction) / 1000).toFixed(1)} s`;
  return `| ${id} | ${scenariosPassed}/${byScenario.size} | ${runsPassed}/${records.length} | ${seconds(latencies, 0.5)} | ${seconds(latencies, 0.95)} | ${seconds(firstAnswers, 0.5)} | ${seconds(firstAnswers, 0.95)} | ${guarded}/${turnCount} turns | ${providerFailed}/${turnCount} turns | $${cost.toFixed(3)} |`;
}

/** One line per failed run, with the checks it failed. */
export function failureLines(id: string, records: RunRecord[]): string[] {
  return records
    .filter((record) => !record.passed)
    .map((record) => {
      const failed = record.skipped
        ? [`skipped: ${record.skipped}`]
        : record.checks.filter((check) => !check.ok).map((check) => `${check.name}${check.detail ? ` (${check.detail})` : ''}`);
      return `- ${id} · ${record.scenario} · run ${record.run}: ${failed.join('; ')}`;
    });
}
