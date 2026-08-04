/**
 * The reporting half of bench.ts, exercised without spending anything.
 *
 * Replaying the fixtures against a real provider is gated behind SUMO_E2E — see
 * `test/languages.test.ts` for what pins the seeded bugs themselves. Everything
 * here is pure: table-building fed synthetic per-run results directly, and
 * `--from-metrics` aggregation fed a synthesized `.sumo/metrics.jsonl`. Neither
 * one makes a network call, so both run in plain `npm test`.
 */

import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  aggregateMetrics,
  buildRepeatedRow,
  readMetricsFile,
  render,
  renderRepeated,
  runBench,
  type CycleResult,
  type Row,
} from '../src/bench.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** A minimal, valid ledger summary — only the fields a test cares about differ. */
function summary(overrides: Partial<CycleResult['summary']> = {}): CycleResult['summary'] {
  return {
    stages: 1,
    retries: 0,
    escalations: 0,
    totalUsd: 0,
    savedUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    packTokens: 0,
    ...overrides,
  };
}

/** Captures what a callback wrote to stdout instead of letting it hit the terminal. */
async function captured(fn: () => Promise<number>): Promise<{ code: number; output: string }> {
  const written: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => {
    written.push(chunk);
    return true;
  });

  try {
    const code = await fn();
    return { code, output: written.join('') };
  } finally {
    process.stdout.write = original;
  }
}

test('render defaults its header to "config" but takes any label', () => {
  const rows: Row[] = [{ config: 'baseline', tasks: 1, verified: 1, summary: summary({ totalUsd: 0.01 }) }];
  assert.match(render(rows), /config\s+verified/);
  assert.match(render(rows, 'mode'), /mode\s+verified/);
});

test('buildRepeatedRow means and spreads $/verified across cycles, not within one', () => {
  const cycles: CycleResult[] = [
    { tasks: 3, verified: 2, summary: summary({ totalUsd: 0.1 }) },
    { tasks: 3, verified: 2, summary: summary({ totalUsd: 0.14 }) },
    { tasks: 3, verified: 2, summary: summary({ totalUsd: 0.12 }) },
  ];
  const row = buildRepeatedRow('baseline', cycles);

  assert.equal(row.cycles, 3);
  assert.equal(row.verifiedTotal, 6);
  assert.equal(row.attemptsTotal, 9);
  assert.ok(row.costPerVerified);
  // $/verified per cycle is 0.05, 0.07, 0.06 — the mean and the range both matter.
  assert.equal(Number(row.costPerVerified.mean.toFixed(4)), 0.06);
  assert.equal(Number(row.costPerVerified.min.toFixed(4)), 0.05);
  assert.equal(Number(row.costPerVerified.max.toFixed(4)), 0.07);
});

test('a cycle that verified nothing does not corrupt the $/verified spread', () => {
  const cycles: CycleResult[] = [
    { tasks: 2, verified: 0, summary: summary({ totalUsd: 0.2 }) },
    { tasks: 2, verified: 1, summary: summary({ totalUsd: 0.1 }) },
  ];
  const row = buildRepeatedRow('baseline', cycles);

  // Only the second cycle has a defined cost per verified task; the shutout
  // cycle is excluded rather than treated as free or infinite.
  assert.equal(row.costPerVerified?.min, 0.1);
  assert.equal(row.costPerVerified?.max, 0.1);
});

test('renderRepeated names overlapping configs "not distinguishable" and leaves a separated one alone', () => {
  const baseline = buildRepeatedRow('baseline', [
    { tasks: 3, verified: 2, summary: summary({ totalUsd: 0.1 }) },
    { tasks: 3, verified: 2, summary: summary({ totalUsd: 0.14 }) },
    { tasks: 3, verified: 2, summary: summary({ totalUsd: 0.12 }) },
  ]);
  // full's $/verified range [0.06, 0.065] sits inside baseline's [0.05, 0.07].
  const full = buildRepeatedRow('full', [
    { tasks: 3, verified: 2, summary: summary({ totalUsd: 0.12 }) },
    { tasks: 3, verified: 2, summary: summary({ totalUsd: 0.125 }) },
    { tasks: 3, verified: 2, summary: summary({ totalUsd: 0.13 }) },
  ]);
  // gated's $/verified range [0.001, 0.002] overlaps neither.
  const gated = buildRepeatedRow('gated', [
    { tasks: 3, verified: 2, summary: summary({ totalUsd: 0.002 }) },
    { tasks: 3, verified: 2, summary: summary({ totalUsd: 0.003 }) },
    { tasks: 3, verified: 2, summary: summary({ totalUsd: 0.004 }) },
  ]);

  const table = renderRepeated([baseline, full, gated]);

  assert.match(table, /baseline and full are not distinguishable/);
  assert.doesNotMatch(table, /baseline and gated are not distinguishable/);
  assert.doesNotMatch(table, /full and gated are not distinguishable/);
});

test('runBench stays gated behind SUMO_E2E regardless of --repeat', async () => {
  const original = process.env['SUMO_E2E'];
  delete process.env['SUMO_E2E'];
  try {
    assert.equal(await runBench({ repeat: 5 }), 1);
  } finally {
    if (original !== undefined) process.env['SUMO_E2E'] = original;
  }
});

test('readMetricsFile parses the synthesized sample and skips nothing valid', () => {
  const lines = readMetricsFile(join(FIXTURES, 'metrics', 'sample.jsonl'));
  assert.equal(lines.length, 8);
  assert.equal(lines[0]!.mode, 'chat');
});

test('readMetricsFile returns nothing for a missing file rather than throwing', () => {
  assert.deepEqual(readMetricsFile(join(FIXTURES, 'metrics', 'does-not-exist.jsonl')), []);
});

test('aggregateMetrics groups the sample by mode with the same totals a bench row has', () => {
  const lines = readMetricsFile(join(FIXTURES, 'metrics', 'sample.jsonl'));
  const byMode = new Map(aggregateMetrics(lines).map((r) => [r.config, r]));

  const chat = byMode.get('chat')!;
  assert.equal(chat.tasks, 2);
  assert.equal(chat.verified, 0, 'chat sessions are never verified');
  assert.equal(Number(chat.summary.totalUsd.toFixed(4)), 0.0228);

  const fix = byMode.get('fix')!;
  assert.equal(fix.tasks, 3);
  assert.equal(fix.verified, 2, 'one of the three fix sessions was never verified');
  assert.equal(Number(fix.summary.totalUsd.toFixed(4)), 0.1642);
  assert.equal(Number((fix.summary.totalUsd / fix.verified).toFixed(4)), 0.0821);

  const doMode = byMode.get('do')!;
  assert.equal(doMode.tasks, 2);
  assert.equal(doMode.verified, 2);
  assert.equal(Number((doMode.summary.totalUsd / doMode.verified).toFixed(4)), 0.0068);

  const feature = byMode.get('feature')!;
  assert.equal(feature.tasks, 1);
  assert.equal(feature.verified, 0);
});

test('sumo bench --from-metrics renders the aggregated table fully offline', async () => {
  const { code, output } = await captured(() =>
    runBench({ fromMetrics: true, metricsPath: join(FIXTURES, 'metrics', 'sample.jsonl') }),
  );

  assert.equal(code, 0);
  assert.match(output, /mode\s+verified/, 'the header names modes, not configs');
  assert.match(output, /fix/);
  // fix verified 2 of 3 at a combined $0.1642, so $/verified is $0.0821.
  assert.match(output, /\$0\.0821/);
  // chat and feature verified nothing, so their $/verified reads as the same
  // dash a fixture row uses when nothing verified.
  assert.match(output, /—/);
});

test('sumo bench --from-metrics with nothing recorded yet is a clean no-op', async () => {
  const { code, output } = await captured(() =>
    runBench({ fromMetrics: true, metricsPath: join(FIXTURES, 'metrics', 'does-not-exist.jsonl') }),
  );

  assert.equal(code, 1);
  assert.match(output, /no metrics recorded yet/);
});

test('--from-metrics makes no provider calls, so it never checks SUMO_E2E', async () => {
  const original = process.env['SUMO_E2E'];
  delete process.env['SUMO_E2E'];
  try {
    const code = await runBench({
      fromMetrics: true,
      metricsPath: join(FIXTURES, 'metrics', 'sample.jsonl'),
    });
    assert.equal(code, 0);
  } finally {
    if (original !== undefined) process.env['SUMO_E2E'] = original;
  }
});
