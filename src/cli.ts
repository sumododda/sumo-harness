#!/usr/bin/env node
/** sumo — a token-frugal coding harness. */

import { createRequire } from 'node:module';
import { Command } from 'commander';

/**
 * The version, read from the manifest rather than written out twice.
 *
 * It was a literal, and it stayed at 0.1.0 through a release — so `sumo
 * --version` on a freshly updated machine reported the previous version while
 * running the new code, which is the one moment anybody asks. Resolved relative
 * to this file, which sits one directory below the manifest both in `src` and
 * in the published `dist`.
 */
const VERSION = (
  createRequire(import.meta.url)('../package.json') as { version: string }
).version;

/**
 * The code index opens a database through `node:sqlite`, which warns that the
 * module is experimental. That is Node talking about its own internals, not
 * something the user can act on, and it lands in the middle of the prompt.
 * Every other warning still gets through.
 */
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === 'string' ? warning : (warning?.message ?? '');
  if (/SQLite is an experimental feature/i.test(text)) return;
  return (emitWarning as (...args: unknown[]) => void)(warning, ...rest);
});
import pc from 'picocolors';
import { runBench } from './bench.ts';
import * as features from './features.ts';
import { runModels } from './models.ts';
import { estimateTokens, loadProfile, PROFILE_PATH, remember } from './profile.ts';
import { repl } from './repl.ts';
import { runSetup } from './setup.ts';
import { runDo } from './workflows/do.ts';
import { SumoError } from './types.ts';

const program = new Command();

/**
 * The provider a subcommand was asked for.
 *
 * `--provider` is declared on the program *and* on the subcommands that accept
 * it, and commander resolves a name declared in both places to the program —
 * so every subcommand's own copy arrived empty and the flag did nothing.
 * `sumo do --provider github-copilot` ran on the default fleet, silently, and
 * the only clue was the price.
 *
 * Reading both and preferring the subcommand's keeps the flag documented where
 * it is used, which is where `--help` looks for it.
 */
function providerOf(opts: { provider?: string }): string | undefined {
  return opts.provider ?? program.opts<{ provider?: string }>().provider;
}

/** Applied before any command runs, so every path honours it. */
program.option('--no-cache', 'never reuse a previous answer, even an identical one');
program.hook('preAction', () => {
  features.set({ cache: program.opts<{ cache: boolean }>().cache });
});

program
  .name('sumo')
  .description('Token-frugal coding harness. The harness picks the model and thinking level.')
  .version(VERSION)
  .option('--provider <name>', 'model provider to use')
  .action(async (opts: { provider?: string }) => {
    // No subcommand: open the interactive harness. `preAction` does not fire for
    // the default action, so the cache setting is applied here too.
    features.set({ cache: program.opts<{ cache: boolean }>().cache });
    process.exitCode = await repl(opts.provider);
  });

program
  .command('setup')
  .description('Install and index everything this repository needs, once')
  .option('-y, --yes', 'install without asking')
  .option('--dry-run', 'say what would happen and change nothing')
  .action(async (opts: { yes?: boolean; dryRun?: boolean }) => {
    process.exitCode = await runSetup({
      ...(opts.yes !== undefined ? { yes: opts.yes } : {}),
      ...(opts.dryRun !== undefined ? { dryRun: opts.dryRun } : {}),
    });
  });

program
  .command('do')
  .description('Make a small, well-understood change in one stage')
  .argument('<task>', 'what to change')
  .option('--rung <n>', 'force a ladder rung (0=cheapest)', (v) => Number.parseInt(v, 10))
  .option('--budget <usd>', 'stage budget in USD', Number.parseFloat)
  .option('--provider <name>', 'model provider to use')
  .action(async (task: string, opts: { rung?: number; budget?: number; provider?: string }) => {
    process.exitCode = await runDo(task, {
      ...(opts.rung !== undefined ? { rung: opts.rung } : {}),
      ...(opts.budget !== undefined ? { budget: opts.budget } : {}),
      ...(providerOf(opts) !== undefined ? { provider: providerOf(opts)! } : {}),
    });
  });

program
  .command('models')
  .description('Show every model, whether this account can use it, and turn one off or on')
  .argument('[action]', 'off or on, to change one')
  .argument('[model]', 'the model id, or provider/id when both carry it')
  .option('--provider <name>', 'limit to one provider')
  .option('--list', 'print the table instead of opening the editor')
  .action(async (
    action: string | undefined,
    model: string | undefined,
    opts: { provider?: string; list?: boolean },
  ) => {
    if (action !== undefined && action !== 'on' && action !== 'off') {
      throw new SumoError(`Unknown action "${action}".`, 'unknown_action', [
        'Use `sumo models`, `sumo models off <id>`, or `sumo models on <id>`.',
      ]);
    }
    process.exitCode = await runModels({
      ...(action ? { action } : {}),
      ...(model !== undefined ? { target: model } : {}),
      ...(providerOf(opts) !== undefined ? { provider: providerOf(opts)! } : {}),
      ...(opts.list ? { list: true } : {}),
    });
  });

program
  .command('bench')
  .description('Replay the fixtures under different optimisations and compare cost per verified task')
  .option('--configs <names>', 'comma-separated, e.g. baseline,full', 'baseline,full')
  .option('--fixtures <names>', 'comma-separated, e.g. ts,py,go')
  .option('--rung <n>', 'ladder rung to start from', (v) => Number.parseInt(v, 10))
  .option('--provider <name>', 'model provider to use')
  .option(
    '--repeat <n>',
    'run each (config, task) pair N times and report mean + spread',
    (v) => Number.parseInt(v, 10),
  )
  .option(
    '--from-metrics',
    'aggregate .sumo/metrics.jsonl from real sessions instead of running fixtures (no provider calls)',
  )
  .action(
    async (opts: {
      configs: string;
      fixtures?: string;
      rung?: number;
      provider?: string;
      repeat?: number;
      fromMetrics?: boolean;
    }) => {
      const split = (value?: string) =>
        value
          ?.split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);

      process.exitCode = await runBench({
        ...(split(opts.configs) ? { configs: split(opts.configs)! } : {}),
        ...(split(opts.fixtures) ? { fixtures: split(opts.fixtures)! } : {}),
        ...(opts.rung !== undefined ? { rung: opts.rung } : {}),
        ...(providerOf(opts) !== undefined ? { provider: providerOf(opts)! } : {}),
        ...(opts.repeat !== undefined ? { repeat: opts.repeat } : {}),
        ...(opts.fromMetrics ? { fromMetrics: true } : {}),
      });
    },
  );

program
  .command('remember')
  .description('Add a durable preference applied to every future task')
  .argument('<fact>', 'the preference to remember')
  .action((fact: string) => {
    remember(fact);
    const size = estimateTokens(loadProfile());
    process.stdout.write(`${pc.green('remembered')} — ${PROFILE_PATH}\n`);
    if (size > 200) {
      process.stdout.write(
        pc.yellow(`profile is ~${size} tokens and rides every call; consider trimming it\n`),
      );
    }
  });

program
  .command('profile')
  .description('Show the operator profile applied to every task')
  .action(() => {
    const text = loadProfile();
    process.stdout.write(`${text}\n`);
    process.stderr.write(pc.dim(`\n${PROFILE_PATH} · ~${estimateTokens(text)} tokens\n`));
  });

try {
  await program.parseAsync(process.argv);
} catch (error) {
  if (error instanceof SumoError) {
    process.stderr.write(`${pc.red('error')} ${error.message}  ${pc.dim(`[${error.code}]`)}\n`);
    for (const s of error.suggestions) process.stderr.write(`  ${pc.dim('→')} ${s}\n`);
  } else {
    process.stderr.write(`${pc.red('error')} ${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exitCode = 1;
}
