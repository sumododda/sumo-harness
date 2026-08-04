/**
 * Replays the fixtures under different sets of optimisations.
 *
 * Every saving in this harness is a claim, and headline numbers from papers do
 * not compose — selective retrieval, caching and compact edits overlap, and
 * multiplying their advertised ratios would produce a figure nobody could
 * reproduce. The only honest estimate comes from running the same tasks over
 * the same code with each feature on and off.
 *
 * The number that decides anything is cost per *verified* task. A configuration
 * that halves the tokens and fails one task in three is more expensive than the
 * baseline, not less, and only the denominator shows it.
 *
 * A single run of each task proves nothing a model is stochastic: `--repeat`
 * runs every (config, task) pair more than once and reports the spread
 * alongside the mean, so two configurations whose ranges overlap are called
 * out as indistinguishable rather than left for the reader to eyeball.
 *
 * Replaying fixtures spends real money, so that path is behind SUMO_E2E=1.
 * `--from-metrics` does not: it only aggregates `.sumo/metrics.jsonl`, which
 * every real session already writes, so the same discipline applies to real
 * work and not only to the seeded bugs.
 */

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import pc from 'picocolors';
import { getEngine } from './engine/index.ts';
import { ALL_OFF, type Features, set as setFeatures } from './features.ts';
import { invalidate } from './hash.ts';
import { LineReader } from './input.ts';
import { Ledger, type Summary } from './ledger.ts';
import { openContext } from './context/index.ts';
import { detectTestCommand, run } from './runner.ts';
import { TaskState } from './state.ts';
import { rungAt } from './types.ts';
import { runFix } from './workflows/fix.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');

/**
 * Named feature sets, each adding one thing to the one before it.
 *
 * Cumulative on purpose: the interesting question is what each addition is
 * worth on top of everything already there, not what it is worth alone.
 */
const CONFIGS: Record<string, Features> = {
  baseline: ALL_OFF,
  indexed: { ...ALL_OFF, index: true },
  cached: { ...ALL_OFF, index: true, cache: true },
  gated: { ...ALL_OFF, index: true, cache: true, gatedRetrieval: true },
  full: {
    index: true,
    cache: true,
    gatedRetrieval: true,
    deltaRetries: true,
    targetedEdits: true,
    skeletonContext: true,
    cleanRetries: true,
  },
};

/** What a fixture asks the harness to do. */
interface BenchTask {
  readonly fixture: string;
  readonly task: string;
}

const TASKS: readonly BenchTask[] = [
  { fixture: 'ts-app', task: 'applyDiscount returns a negative number for a whole percentage' },
  { fixture: 'py-app', task: 'apply_discount returns a negative number for a whole percentage' },
  { fixture: 'go-app', task: 'ApplyDiscount returns a negative number for a whole percentage' },

  // Trivial, one-line off-by-one: a boundary comparison uses the wrong operator.
  {
    fixture: 'ts-app-shipping',
    task: 'isFreeShipping excludes an order that lands exactly on the free-shipping threshold',
  },
  {
    fixture: 'py-app-shipping',
    task: 'is_free_shipping excludes an order that lands exactly on the free-shipping threshold',
  },
  {
    fixture: 'go-app-shipping',
    task: 'IsFreeShipping excludes an order that lands exactly on the free-shipping threshold',
  },

  // Two-file coordinated change: the same helper is duplicated, buggy, in
  // both files, so fixing only one leaves the suite red.
  {
    fixture: 'ts-app-bulk',
    task: 'pricePerItem and bulkUnitPrice truncate instead of rounding to the nearest cent',
  },
  {
    fixture: 'py-app-bulk',
    task: 'price_per_item and bulk_unit_price truncate instead of rounding to the nearest cent',
  },
  {
    fixture: 'go-app-bulk',
    task: 'PricePerItem and BulkUnitPrice truncate instead of rounding to the nearest cent',
  },

  // Genuinely subtle: an async race in JS, an exhausted iterator in Python, a
  // shared backing array in Go. The symptom is far from the cause in all three.
  {
    fixture: 'ts-app-memo',
    task: 'memoizeAsync calls the underlying function twice for concurrent calls with the same key',
  },
  {
    fixture: 'py-app-iter',
    task: 'summarize returns the wrong count when given a generator instead of a list',
  },
  {
    fixture: 'go-app-alias',
    task: 'AddPromo silently overwrites the first item of tail because head and tail share a backing array',
  },

  // Moderate: an order-of-operations bug in a small calculation.
  {
    fixture: 'ts-app-stack',
    task: 'stackedPrice applies the flat bulk discount before the percentage instead of after',
  },
  {
    fixture: 'py-app-stack',
    task: 'stacked_price applies the flat bulk discount before the percentage instead of after',
  },
  {
    fixture: 'go-app-stack',
    task: 'StackedPrice applies the flat bulk discount before the percentage instead of after',
  },

  // Moderate: a loop that concatenates instead of aggregating by key.
  {
    fixture: 'ts-app-merge',
    task: 'mergeCarts does not combine quantities for items with the same id',
  },
  {
    fixture: 'py-app-merge',
    task: 'merge_carts does not combine quantities for items with the same id',
  },
  {
    fixture: 'go-app-merge',
    task: 'MergeCarts does not combine quantities for items with the same id',
  },
];

export interface BenchOptions {
  readonly configs?: readonly string[];
  readonly fixtures?: readonly string[];
  readonly rung?: number;
  readonly provider?: string;
  /** Times to run each (config, task) pair. Default 1 — today's behaviour. */
  readonly repeat?: number;
  /** Aggregate `.sumo/metrics.jsonl` instead of running the fixtures. */
  readonly fromMetrics?: boolean;
  /** Where to read metrics from. Defaults to `.sumo/metrics.jsonl` under cwd. */
  readonly metricsPath?: string;
}

export interface CycleResult {
  readonly tasks: number;
  readonly verified: number;
  readonly summary: Summary;
}

export type Row = CycleResult & { readonly config: string };

export async function runBench(opts: BenchOptions = {}): Promise<number> {
  if (opts.fromMetrics) return runFromMetrics(opts);

  if (process.env['SUMO_E2E'] !== '1') {
    process.stderr.write(
      `${pc.yellow('bench runs real tasks against a real provider and costs money.')}\n` +
        `${pc.dim('Re-run with SUMO_E2E=1 to confirm.')}\n`,
    );
    return 1;
  }

  const names = opts.configs ?? ['baseline', 'full'];
  const unknown = names.filter((n) => !(n in CONFIGS));
  if (unknown.length > 0) {
    process.stderr.write(
      `${pc.red('unknown config')} ${unknown.join(', ')}\n` +
        `${pc.dim(`known: ${Object.keys(CONFIGS).join(', ')}`)}\n`,
    );
    return 1;
  }

  const tasks = TASKS.filter(
    (t) => !opts.fixtures || opts.fixtures.some((f) => t.fixture.startsWith(f)),
  );
  if (tasks.length === 0) {
    process.stderr.write(`${pc.red('no fixtures matched')}\n`);
    return 1;
  }

  const repeat = normalizeRepeat(opts.repeat);

  if (repeat === 1) {
    const rows: Row[] = [];
    for (const name of names) {
      rows.push({ config: name, ...(await runCycle(name, tasks, opts)) });
    }
    process.stdout.write(`\n${render(rows)}\n`);
    return 0;
  }

  const cyclesByConfig = new Map<string, CycleResult[]>();
  for (let cycle = 1; cycle <= repeat; cycle++) {
    process.stdout.write(pc.dim(`\n── repeat ${cycle}/${repeat} ──\n`));
    for (const name of names) {
      const result = await runCycle(name, tasks, opts);
      const list = cyclesByConfig.get(name) ?? [];
      list.push(result);
      cyclesByConfig.set(name, list);
    }
  }

  const rows = names.map((name) => buildRepeatedRow(name, cyclesByConfig.get(name) ?? []));
  process.stdout.write(`\n${renderRepeated(rows)}\n`);
  return 0;
}

/** A repeat count below 1, or unparsable, is not a request to repeat at all. */
function normalizeRepeat(n?: number): number {
  return n !== undefined && Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

/** Runs every task once under one configuration — one pass through the fixtures. */
async function runCycle(
  name: string,
  tasks: readonly BenchTask[],
  opts: BenchOptions,
): Promise<CycleResult> {
  process.stdout.write(pc.bold(`\n${name}\n`));
  const results: { verified: boolean; summary: Summary }[] = [];

  for (const task of tasks) {
    const result = await runOne(task, CONFIGS[name]!, opts);
    if (result) results.push(result);
  }

  return {
    tasks: results.length,
    verified: results.filter((r) => r.verified).length,
    summary: total(results.map((r) => r.summary)),
  };
}

/** Runs one fixture under one configuration, in a disposable copy. */
async function runOne(
  task: BenchTask,
  config: Features,
  opts: BenchOptions,
): Promise<{ verified: boolean; summary: Summary } | null> {
  const source = join(FIXTURES, task.fixture);
  if (!existsSync(source)) {
    process.stdout.write(pc.yellow(`  ${task.fixture} — missing, skipped\n`));
    return null;
  }

  const dir = mkdtempSync(join(tmpdir(), `sumo-bench-${task.fixture}-`));
  const rl = createInterface({ input: Readable.from([]) });

  try {
    cpSync(source, dir, { recursive: true });

    // A git repo is required, not incidental: the cache keys on the tree's
    // content, and without a fingerprint nothing would ever be reused.
    await run('git init -q .', dir);
    await run('git add -A', dir);
    await run('git -c user.email=bench@sumo -c user.name=bench commit -q -m fixture', dir);
    invalidate(dir);

    setFeatures(config);

    const testCommand = detectTestCommand(dir);
    if (!testCommand) {
      process.stdout.write(pc.yellow(`  ${task.fixture} — no test command, skipped\n`));
      return null;
    }

    const engine = getEngine(opts.provider);
    const ledger = new Ledger();
    const code = await openContext(dir, { allowInit: true });
    const pack = code.ready ? await code.pack(task.task) : '';

    const started = Date.now();
    const outcome = await runFix(
      task.task,
      rungAt(opts.rung ?? 0),
      {
        engine,
        ledger,
        state: new TaskState({ root: dir, isGit: true }, TaskState.newId('bench')),
        cwd: dir,
        input: new LineReader(rl),
        isTty: false,
        // The point is to measure the harness, not to sit at a prompt.
        autoApprove: true,
        testCommand,
        indexed: pack.length > 0,
        packChars: pack.length,
      },
      pack ? `Relevant code, from this repository's index:\n${pack}\n\n` : '',
    );
    await code.dispose();

    const verified = outcome.kind === 'fixed' && outcome.verified;
    const summary = ledger.summarize();
    process.stdout.write(
      `  ${verified ? pc.green('✓') : pc.red('✗')} ${task.fixture.padEnd(8)} ` +
        pc.dim(
          `$${summary.totalUsd.toFixed(4)}  ${summary.inputTokens} in  ${summary.outputTokens} out` +
            `  ${summary.retries} retries  ${((Date.now() - started) / 1000).toFixed(0)}s\n`,
        ),
    );

    return { verified, summary };
  } catch (cause) {
    process.stdout.write(
      pc.red(`  ✗ ${task.fixture} — ${cause instanceof Error ? cause.message : String(cause)}\n`),
    );
    return null;
  } finally {
    rl.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function total(summaries: readonly Summary[]): Summary {
  const sum = (pick: (s: Summary) => number) => summaries.reduce((t, s) => t + pick(s), 0);
  return {
    stages: sum((s) => s.stages),
    retries: sum((s) => s.retries),
    escalations: sum((s) => s.escalations),
    totalUsd: sum((s) => s.totalUsd),
    savedUsd: sum((s) => s.savedUsd),
    inputTokens: sum((s) => s.inputTokens),
    outputTokens: sum((s) => s.outputTokens),
    cacheReadTokens: sum((s) => s.cacheReadTokens),
    packTokens: sum((s) => s.packTokens),
  };
}

export function render(rows: readonly Row[], label = 'config'): string {
  const head = [label, 'verified', 'in', 'out', 'retries', 'total', '$/verified'];
  const body = rows.map((r) => [
    r.config,
    `${r.verified}/${r.tasks}`,
    String(r.summary.inputTokens),
    String(r.summary.outputTokens),
    String(r.summary.retries),
    `$${r.summary.totalUsd.toFixed(4)}`,
    // The denominator is the whole point: tokens saved at the cost of a failed
    // task are not saved at all.
    r.verified > 0 ? `$${(r.summary.totalUsd / r.verified).toFixed(4)}` : '—',
  ]);

  const widths = head.map((h, i) => Math.max(h.length, ...body.map((row) => row[i]!.length)));
  const line = (cells: readonly string[], dim: boolean) => {
    const text = cells
      .map((c, i) => (i >= 1 ? c.padStart(widths[i]!) : c.padEnd(widths[i]!)))
      .join('  ');
    return dim ? pc.dim(text) : text;
  };

  return [
    line(head, true),
    ...body.map((row) => line(row, false)),
    pc.dim('\nA configuration that costs less per verified task is cheaper. One that'),
    pc.dim('costs less per token but verifies fewer tasks is not.'),
  ].join('\n');
}

/** Mean, min and max of a run of numbers — null when there is nothing to summarize. */
interface Stat {
  readonly mean: number;
  readonly min: number;
  readonly max: number;
}

function statOf(values: readonly number[]): Stat | null {
  if (values.length === 0) return null;
  return {
    mean: values.reduce((a, b) => a + b, 0) / values.length,
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

function overlaps(a: Stat, b: Stat): boolean {
  return a.min <= b.max && b.min <= a.max;
}

export interface RepeatedRow {
  readonly config: string;
  readonly cycles: number;
  readonly verifiedTotal: number;
  readonly attemptsTotal: number;
  readonly inputTokens: Stat | null;
  readonly outputTokens: Stat | null;
  readonly retries: Stat | null;
  readonly totalUsd: Stat | null;
  /** Cost per verified task, one sample per cycle — the number the spread is about. */
  readonly costPerVerified: Stat | null;
}

export function buildRepeatedRow(config: string, cycles: readonly CycleResult[]): RepeatedRow {
  // Only a cycle that verified something has a defined cost per verified task;
  // a shutout cycle would divide by zero rather than say "infinitely expensive".
  const costs = cycles.filter((c) => c.verified > 0).map((c) => c.summary.totalUsd / c.verified);

  return {
    config,
    cycles: cycles.length,
    verifiedTotal: cycles.reduce((t, c) => t + c.verified, 0),
    attemptsTotal: cycles.reduce((t, c) => t + c.tasks, 0),
    inputTokens: statOf(cycles.map((c) => c.summary.inputTokens)),
    outputTokens: statOf(cycles.map((c) => c.summary.outputTokens)),
    retries: statOf(cycles.map((c) => c.summary.retries)),
    totalUsd: statOf(cycles.map((c) => c.summary.totalUsd)),
    costPerVerified: statOf(costs),
  };
}

export function renderRepeated(rows: readonly RepeatedRow[]): string {
  const fmt = (stat: Stat | null, one: (n: number) => string): string => {
    if (!stat) return '—';
    if (stat.min === stat.max) return one(stat.mean);
    return `${one(stat.mean)} (${one(stat.min)}–${one(stat.max)})`;
  };

  const head = ['config', 'verified', 'in', 'out', 'retries', 'total', '$/verified'];
  const body = rows.map((r) => [
    r.config,
    `${r.verifiedTotal}/${r.attemptsTotal}`,
    fmt(r.inputTokens, (n) => n.toFixed(0)),
    fmt(r.outputTokens, (n) => n.toFixed(0)),
    fmt(r.retries, (n) => n.toFixed(1)),
    fmt(r.totalUsd, (n) => `$${n.toFixed(4)}`),
    fmt(r.costPerVerified, (n) => `$${n.toFixed(4)}`),
  ]);

  const widths = head.map((h, i) => Math.max(h.length, ...body.map((row) => row[i]!.length)));
  const line = (cells: readonly string[], dim: boolean) => {
    const text = cells
      .map((c, i) => (i >= 1 ? c.padStart(widths[i]!) : c.padEnd(widths[i]!)))
      .join('  ');
    return dim ? pc.dim(text) : text;
  };

  // At n this small, two configs whose ranges overlap are not a finding — the
  // reader must be told so explicitly, not left to eyeball two point estimates.
  const notes: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i]!;
      const b = rows[j]!;
      if (a.costPerVerified && b.costPerVerified && overlaps(a.costPerVerified, b.costPerVerified)) {
        notes.push(
          `${a.config} and ${b.config} are not distinguishable — their $/verified ranges overlap.`,
        );
      }
    }
  }

  return [
    line(head, true),
    ...body.map((row) => line(row, false)),
    pc.dim(`\n${rows[0]?.cycles ?? 0} repeats per (config, task). Mean shown, with the min–max`),
    pc.dim('range in parentheses where the repeats did not all agree. A configuration that'),
    pc.dim('costs less per verified task is cheaper. One that costs less per token but'),
    pc.dim('verifies fewer tasks is not.'),
    ...(notes.length > 0 ? ['', ...notes.map((n) => pc.yellow(n))] : []),
  ].join('\n');
}

/** One line of `.sumo/metrics.jsonl`, written by {@link Ledger.finish}. */
export interface MetricsLine {
  readonly ts: string;
  readonly mode: string;
  readonly task: string;
  readonly verified: boolean;
  readonly stopped?: string;
  readonly rungs: readonly string[];
  readonly stages: number;
  readonly retries: number;
  readonly escalations: number;
  readonly totalUsd: number;
  readonly savedUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly packTokens: number;
}

/**
 * Reads `.sumo/metrics.jsonl` as-is — one real task per line, accumulated by
 * every `/fix`, `/feature` and `/do` session, not by bench.
 *
 * A malformed line is skipped rather than failing the whole read: losing one
 * session's row must not hide every other one.
 */
export function readMetricsFile(path: string): MetricsLine[] {
  if (!existsSync(path)) return [];

  const lines: MetricsLine[] = [];
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    try {
      lines.push(JSON.parse(trimmed) as MetricsLine);
    } catch {
      // One bad line must not sink every line around it.
    }
  }
  return lines;
}

/** Groups real sessions by mode and totals each group the same way a bench row is totalled. */
export function aggregateMetrics(lines: readonly MetricsLine[]): Row[] {
  const byMode = new Map<string, MetricsLine[]>();
  for (const line of lines) {
    const group = byMode.get(line.mode) ?? [];
    group.push(line);
    byMode.set(line.mode, group);
  }

  return [...byMode.entries()].map(([mode, group]) => ({
    config: mode,
    tasks: group.length,
    verified: group.filter((l) => l.verified).length,
    summary: total(
      group.map((l): Summary => ({
        stages: l.stages,
        retries: l.retries,
        escalations: l.escalations,
        totalUsd: l.totalUsd,
        savedUsd: l.savedUsd,
        inputTokens: l.inputTokens,
        outputTokens: l.outputTokens,
        cacheReadTokens: l.cacheReadTokens,
        packTokens: l.packTokens,
      })),
    ),
  }));
}

/**
 * Pure aggregation, no provider calls: reads what real sessions already
 * wrote and reports it in the same shape `sumo bench` prints for fixtures, so
 * the same $/verified discipline applies to real work, not only to the three
 * seeded bugs.
 */
async function runFromMetrics(opts: BenchOptions): Promise<number> {
  const path = opts.metricsPath ?? join(process.cwd(), '.sumo', 'metrics.jsonl');
  const lines = readMetricsFile(path);

  if (lines.length === 0) {
    process.stdout.write(
      `${pc.yellow('no metrics recorded yet')}\n${pc.dim(`looked in ${path}`)}\n`,
    );
    return 1;
  }

  const rows = aggregateMetrics(lines);
  process.stdout.write(`\n${render(rows, 'mode')}\n`);
  return 0;
}
