/**
 * Cost accounting. Every task ends with a printed ledger so spend is never a
 * mystery, and the same numbers are persisted for later comparison.
 *
 * The number that actually matters is not spend but spend per *verified* task:
 * a cheap answer that failed its tests and had to be retried at a higher rung
 * cost more than an expensive one that worked first time. Retries and
 * escalations are therefore recorded alongside the tokens, and
 * {@link Ledger.finish} appends one line per task to `.sumo/metrics.jsonl` so
 * that ratio can be read across sessions rather than guessed at.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { encode } from '@toon-format/toon';
import pc from 'picocolors';
import * as statusbar from './statusbar.ts';
import { describeRung, type StageResult } from './types.ts';

/** How a task ended, for the metrics line. */
export interface TaskOutcome {
  readonly mode: string;
  readonly task: string;
  /** True only when the harness ran the tests and they passed. */
  readonly verified: boolean;
  /** Set when the task stopped early, e.g. a rejected gate. */
  readonly stopped?: string;
}

/** What a slice of the ledger adds up to. */
export interface Summary {
  readonly stages: number;
  readonly retries: number;
  readonly escalations: number;
  /** Extra `fix` candidates sampled at a rung beyond the first — see `noteCandidate`. */
  readonly candidates: number;
  readonly totalUsd: number;
  readonly savedUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly packTokens: number;
}

export class Ledger {
  private readonly rows: StageResult[] = [];
  private escalations = 0;
  private candidates = 0;

  add(result: StageResult): void {
    this.rows.push(result);
    // The bar shows the running total, so it learns about spend here rather
    // than every caller remembering to tell it.
    statusbar.cost(this.totalUsd);
  }

  /**
   * Records that the ladder climbed.
   *
   * The ledger cannot infer this: an escalation and a plain retry both produce
   * another row, and only the workflow knows which one happened.
   */
  noteEscalation(): void {
    this.escalations += 1;
  }

  /**
   * Records that `fix` sampled an extra candidate at a rung, mirroring
   * {@link noteEscalation}'s shape: this is meta-information about the
   * workflow's own loop, not a property of any one stage's `StageResult`, so
   * only the workflow can say when it happened.
   */
  noteCandidate(): void {
    this.candidates += 1;
  }

  /**
   * A cursor into the ledger, for scoping a summary to one task.
   *
   * The REPL keeps a single ledger for the whole session so `/cost` can show it,
   * so "this task" has to be expressed as a range rather than a fresh instance.
   */
  mark(): number {
    return this.rows.length;
  }

  get totalUsd(): number {
    return this.rows.reduce((sum, r) => sum + r.costUsd, 0);
  }

  get entries(): readonly StageResult[] {
    return this.rows;
  }

  summarize(from = 0): Summary {
    const slice = this.rows.slice(from);
    const sum = (pick: (r: StageResult) => number) => slice.reduce((t, r) => t + pick(r), 0);

    return {
      stages: slice.length,
      retries: slice.filter((r) => (r.attempt ?? 0) > 0).length,
      escalations: this.escalations,
      // Unscoped by `from`, same as `escalations` above — both are counters
      // for the session's ladder, not per-stage rows this slice can filter.
      candidates: this.candidates,
      totalUsd: sum((r) => r.costUsd),
      savedUsd: sum((r) => r.savedUsd ?? 0),
      inputTokens: sum((r) => r.inputTokens),
      outputTokens: sum((r) => r.outputTokens),
      cacheReadTokens: sum((r) => r.cacheReadTokens),
      packTokens: sum((r) => r.composition?.pack ?? 0),
    };
  }

  /**
   * Appends one line per task to `.sumo/metrics.jsonl`.
   *
   * Append-only and one task per line so the file can be read back with any
   * tool, compared across configurations, and grown indefinitely without ever
   * rewriting what is already there.
   */
  finish(root: string, from: number, outcome: TaskOutcome): void {
    const summary = this.summarize(from);
    const line = {
      ts: new Date().toISOString(),
      mode: outcome.mode,
      task: outcome.task,
      verified: outcome.verified,
      ...(outcome.stopped ? { stopped: outcome.stopped } : {}),
      rungs: this.rows.slice(from).map((r) => describeRung(r.rung)),
      ...summary,
    };

    const path = join(root, '.sumo', 'metrics.jsonl');
    try {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${JSON.stringify(line)}\n`, 'utf8');
    } catch {
      // Losing a metrics line must never lose the task it describes.
    }
  }

  /** TOON-encoded, for persisting and for feeding back into a prompt cheaply. */
  toToon(): string {
    return encode({ stages: stageRows(this.rows) });
  }

  /** Human-facing summary printed at the end of a task. */
  render(from = 0): string {
    const slice = this.rows.slice(from);
    if (slice.length === 0) return pc.dim('No stages ran.');

    const head = ['stage', 'model', 'in', 'out', 'pcache', 'turns', 'cost'];
    const body = slice.map((r) => [
      r.stage,
      describeRung(r.rung),
      String(r.inputTokens),
      String(r.outputTokens),
      String(r.cacheReadTokens),
      String(r.turns),
      // A replayed stage did not run, so a price would be misleading where the
      // reason it is free belongs instead.
      r.cached ? 'reused' : `$${r.costUsd.toFixed(4)}`,
    ]);

    const widths = head.map((h, i) =>
      Math.max(h.length, ...body.map((row) => row[i]!.length)),
    );
    const line = (cells: string[], dim: boolean) => {
      const text = cells
        .map((c, i) => (i >= 2 ? c.padStart(widths[i]!) : c.padEnd(widths[i]!)))
        .join('  ');
      return dim ? pc.dim(text) : text;
    };

    const summary = this.summarize(from);
    const notes: string[] = [];
    if (summary.savedUsd > 0) notes.push(`$${summary.savedUsd.toFixed(4)} reused`);
    if (summary.retries > 0) notes.push(`${summary.retries} ${plural(summary.retries, 'retry', 'retries')}`);
    if (summary.escalations > 0) notes.push(`${summary.escalations} escalated`);
    // Named "pcache" to match the per-stage column and to keep it visibly
    // distinct from "reused" above: that is this harness's own exact-result
    // cache, this is the provider's, and the two must never read as one number.
    if (summary.cacheReadTokens > 0) notes.push(`${summary.cacheReadTokens} pcache`);
    if (summary.candidates > 0) {
      notes.push(`${summary.candidates} extra ${plural(summary.candidates, 'candidate', 'candidates')}`);
    }

    return [
      line(head, true),
      ...body.map((row) => line(row, false)),
      pc.dim('─'.repeat(widths.reduce((a, b) => a + b + 2, -2))),
      pc.bold(`total  $${summary.totalUsd.toFixed(4)}`) +
        (notes.length > 0 ? pc.dim(`  ·  ${notes.join('  ·  ')}`) : ''),
    ].join('\n');
  }
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/**
 * The uniform rows the ledger artifact is built from.
 *
 * Exported so a format comparison can encode *the same data* two ways. Weighing
 * TOON against a JSON dump of the full stage results would compare payloads
 * rather than encodings, and flatter TOON for reasons that have nothing to do
 * with it.
 */
export function stageRows(entries: readonly StageResult[]): Record<string, unknown>[] {
  return entries.map((r) => ({
    stage: r.stage,
    model: r.model,
    effort: r.rung.effort ?? 'off',
    costUsd: Number(r.costUsd.toFixed(4)),
    turns: r.turns,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cacheReadTokens: r.cacheReadTokens,
    cached: r.cached === true,
  }));
}
