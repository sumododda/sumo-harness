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
 * This spends real money, so it is behind SUMO_E2E=1.
 */

import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
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
];

export interface BenchOptions {
  readonly configs?: readonly string[];
  readonly fixtures?: readonly string[];
  readonly rung?: number;
  readonly provider?: string;
}

interface Row {
  readonly config: string;
  readonly tasks: number;
  readonly verified: number;
  readonly summary: Summary;
}

export async function runBench(opts: BenchOptions = {}): Promise<number> {
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

  const rows: Row[] = [];

  for (const name of names) {
    process.stdout.write(pc.bold(`\n${name}\n`));
    const results: { verified: boolean; summary: Summary }[] = [];

    for (const task of tasks) {
      const result = await runOne(task, CONFIGS[name]!, opts);
      if (result) results.push(result);
    }

    rows.push({
      config: name,
      tasks: results.length,
      verified: results.filter((r) => r.verified).length,
      summary: total(results.map((r) => r.summary)),
    });
  }

  process.stdout.write(`\n${render(rows)}\n`);
  return 0;
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

function render(rows: readonly Row[]): string {
  const head = ['config', 'verified', 'in', 'out', 'retries', 'total', '$/verified'];
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
