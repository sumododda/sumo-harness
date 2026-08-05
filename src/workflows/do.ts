/**
 * `sumo do` — a single writable stage for small, well-understood edits.
 *
 * No gates and no test loop: those belong to `fix` and `feature`. This exists so
 * a one-line change never pays for a five-stage pipeline.
 */

import pc from 'picocolors';
import { getEngine } from '../engine/index.ts';
import { Fleet, policyFromEnv } from '../engine/fleet.ts';
import { Ledger } from '../ledger.ts';
import { DO_STAGE } from '../prompts.ts';
import { runStage } from '../stage.ts';
import { findRepo, TaskState } from '../state.ts';
import { rungAt } from '../types.ts';

export interface DoOptions {
  readonly rung?: number;
  readonly provider?: string;
  readonly budget?: number;
}

export async function runDo(task: string, opts: DoOptions = {}): Promise<number> {
  const repo = findRepo();
  const state = new TaskState(repo, TaskState.newId('do'));
  const fleet = new Fleet([getEngine(opts.provider)], policyFromEnv());
  const ledger = new Ledger();

  const result = await runStage(
    fleet,
    {
      name: 'do',
      prompt: DO_STAGE(task),
      rung: rungAt(opts.rung ?? 1),
      capabilities: ['read', 'search', 'edit'],
      cwd: repo.root,
      allowWrites: true,
      ...(opts.budget !== undefined ? { maxBudget: opts.budget } : {}),
    },
    ledger,
  );

  state.write('output.md', result.output);
  state.write('ledger.toon', ledger.toToon());

  process.stdout.write(`\n${result.output.trim()}\n`);
  process.stdout.write(`\n${ledger.render()}\n`);
  process.stderr.write(pc.dim(`\nartifacts: ${state.dir}\n`));

  return result.stopped ? 1 : 0;
}
