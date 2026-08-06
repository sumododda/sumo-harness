#!/usr/bin/env node
/**
 * Prices the router against the requests it has historically got wrong.
 *
 * Routing used to be a table of regexes, and every one of them could be
 * asserted offline for free — which is why `test/intent.test.ts` grew to cover
 * ninety phrasings. Routing is a model call now, so none of that can be checked
 * by `npm test` any more: the only way to know whether the harness reads a
 * request correctly is to ask it and count. That is what this does.
 *
 * The cases in `test/routing-cases.ts` are not a random sample. Each one was
 * added because the harness got it wrong in a way that cost a real turn — a
 * polite request read as a question and answered instead of acted on, a JSDoc
 * `@throws` tag read as a crash report, an instruction to search the web sent
 * to a stage with no web tool. They are adversarial by construction, so the
 * number this prints is a floor rather than an average.
 *
 * Costs real money — one small-model call per case — so it is not part of
 * `npm run check`:
 *
 *     SUMO_E2E=1 node scripts/routing-eval.ts
 *     SUMO_E2E=1 node scripts/routing-eval.ts --provider copilot
 *
 * The cache is switched off for the run, so every case is a live call rather
 * than a replay of the last one.
 *
 * Recorded results, so a change has something to beat. Both runs are 84 cases
 * on Haiku 4.5, cache off:
 *
 *                                              correct   $/routed turn
 *     as first shipped                           92%        0.0135
 *     + no tools for a no-capability stage       —           —
 *     + a classifier system prompt   ← shipped   98%        0.0047
 *
 * The two fixes were found by running this, and neither was a routing change.
 * The router was being handed the repository tool set and the coding-agent
 * system prompt, so it explored files to classify a sentence and narrated while
 * it did — six turns and a spent budget on the worst case, which returned prose
 * where the JSON should have been. Withholding both made it cheaper and more
 * accurate at once; every remaining error is a genuine judgement call.
 *
 * The two that still miss are `refactor the pricing module` (read as `do`) and
 * `migrate to the new API` (read as `research`, which is not unreasonable — an
 * unnamed "new API" may well need looking up). Both are labelled `feature` here
 * because a change that size deserves a plan before it starts.
 */

import pc from 'picocolors';
import { Fleet, policyFromEnv } from '../src/engine/fleet.ts';
import { getFleetEngines } from '../src/engine/index.ts';
import { get as getFeatures, set as setFeatures } from '../src/features.ts';
import { CLASSIFY_SCHEMA } from '../src/intent.ts';
import { Ledger } from '../src/ledger.ts';
import { classify } from '../src/route.ts';
import { renderTotals } from '../src/ui.ts';
import { ROUTING_CASES, type RoutingCase } from '../test/routing-cases.ts';

/** Enough to keep a provider busy without tripping its rate limit. */
const CONCURRENCY = 6;

const MODES: readonly string[] = CLASSIFY_SCHEMA.properties.mode.enum;

interface Outcome {
  readonly case: RoutingCase;
  /** Null when the call failed or named a mode the harness cannot dispatch. */
  readonly got: string | null;
  readonly complexity: string | null;
}

async function main(): Promise<number> {
  if (process.env['SUMO_E2E'] !== '1') {
    process.stderr.write(
      `${pc.yellow('routing-eval makes one real model call per case and costs money.')}\n` +
        `${pc.dim('Re-run with SUMO_E2E=1 to confirm.')}\n`,
    );
    return 1;
  }

  const provider = argValue('--provider');
  const fleet = new Fleet(getFleetEngines(provider), policyFromEnv());
  const ledger = new Ledger();
  const cwd = process.cwd();

  // A replayed answer would measure the cache, not the router.
  setFeatures({ ...getFeatures(), cache: false });

  process.stdout.write(
    pc.dim(`${ROUTING_CASES.length} cases · ${fleet.providers.join(', ')} · cache off\n\n`),
  );

  const started = Date.now();
  const outcomes = await inParallel(ROUTING_CASES, CONCURRENCY, async (item) => {
    const answer = await classify(item.text, fleet, ledger, cwd);
    return { case: item, got: answer?.mode ?? null, complexity: answer?.complexity ?? null };
  });

  report(outcomes, ledger, Date.now() - started);

  // Any case the router could not answer at all is a harness failure rather
  // than a wrong opinion, and is worth a non-zero exit on its own.
  return outcomes.some((o) => o.got === null) ? 1 : 0;
}

function report(outcomes: readonly Outcome[], ledger: Ledger, elapsedMs: number): void {
  const misses = outcomes.filter((o) => o.got !== o.case.mode);

  if (misses.length > 0) {
    process.stdout.write(pc.bold('misses\n'));
    for (const miss of misses) {
      const got = miss.got ?? 'no answer';
      process.stdout.write(
        `  ${pc.red(got.padEnd(9))} ${pc.dim('want')} ${pc.green(miss.case.mode.padEnd(9))} ` +
          `${clip(miss.case.text, 62)}\n`,
      );
      if (miss.case.note) process.stdout.write(pc.dim(`  ${' '.repeat(25)}${miss.case.note}\n`));
    }
    process.stdout.write('\n');
  }

  // Per-mode, because a single accuracy figure hides the failure that matters.
  // A router that never chooses `fix` still scores well if most cases are not
  // bugs, and would send every bug report to a read-only stage.
  process.stdout.write(pc.bold('by mode\n'));
  const width = Math.max(...MODES.map((m) => m.length));
  for (const mode of MODES) {
    const want = outcomes.filter((o) => o.case.mode === mode);
    const right = want.filter((o) => o.got === mode).length;
    const chose = outcomes.filter((o) => o.got === mode).length;
    process.stdout.write(
      `  ${mode.padEnd(width)}  ${String(right).padStart(2)}/${String(want.length).padEnd(2)} ` +
        pct(right, want.length).padStart(5) +
        pc.dim(`   chosen ${String(chose).padStart(2)} times\n`),
    );
  }

  const confusable = MODES.filter((m) => misses.some((o) => o.case.mode === m || o.got === m));
  if (confusable.length > 0) {
    process.stdout.write(`\n${pc.bold('confusion')} ${pc.dim('(row: wanted, column: chosen)')}\n`);
    const heads = confusable.map((m) => m.slice(0, 4).padStart(5)).join('');
    process.stdout.write(`  ${' '.repeat(width)}  ${heads}\n`);
    for (const want of confusable) {
      const cells = confusable.map((got) => {
        const n = outcomes.filter((o) => o.case.mode === want && o.got === got).length;
        const cell = String(n).padStart(5);
        return n === 0 ? pc.dim(cell) : want === got ? pc.green(cell) : pc.red(cell);
      });
      process.stdout.write(`  ${want.padEnd(width)}  ${cells.join('')}\n`);
    }
  }

  const right = outcomes.length - misses.length;
  const summary = ledger.summarize();
  process.stdout.write(
    `\n${pc.bold(`${right}/${outcomes.length} ${pct(right, outcomes.length)}`)}  ` +
      pc.dim(
        `${renderTotals(summary.total)}  ${summary.inputTokens} in  ${summary.outputTokens} out` +
          `  ${(elapsedMs / 1000).toFixed(0)}s\n`,
      ),
  );

  const perCase = summary.total[0];
  if (summary.total.length === 1 && perCase) {
    process.stdout.write(
      pc.dim(`${(perCase.amount / outcomes.length).toFixed(5)} ${perCase.unit} per routed turn\n`),
    );
  }
}

/** Runs `work` over `items`, at most `limit` at a time, preserving order. */
async function inParallel<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await work(item);
      process.stdout.write(pc.dim('.'));
    }
  });

  await Promise.all(workers);
  process.stdout.write('\n\n');
  return results;
}

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function pct(n: number, of: number): string {
  return of === 0 ? '—' : `${((n / of) * 100).toFixed(0)}%`;
}

function clip(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`;
}

process.exitCode = await main();
