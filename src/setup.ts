/**
 * `sumo setup` — everything a repository needs, before the first question.
 *
 * The pieces were all here and all separate: `/index` built the code index,
 * `/lsp` told you what to install and left you to it, `/tests` waited to be
 * told how to run the suite, and the lexical ranker built itself on first use
 * inside whatever stage happened to be first. Each is a small ask; together
 * they are a checklist nobody should have to remember on a new machine or a new
 * project.
 *
 * The rule this command bends is a deliberate one. Everywhere else the harness
 * installs nothing — language servers are per-language toolchains and putting
 * them on someone's machine uninvited is a bigger surprise than telling them
 * what to run. Typing `setup` is that invitation, which is why it is a command
 * of its own rather than something the shell does on startup: the consent is
 * the command. It still says what it will do and waits, unless `--yes`.
 *
 * Nothing here is required. Skipping it costs a slower first task, never a
 * broken one.
 */

import pc from 'picocolors';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openContext } from './context/index.ts';
import { LexicalIndex } from './context/lexical.ts';
import { serverStatus, type ServerStatus } from './context/lsp.ts';
import { detectTestCommand, run, runUntruncated } from './runner.ts';
import { findRepo } from './state.ts';
import { SumoError } from './types.ts';

/** Extensions that mean a language is actually present, not merely possible. */
const MARKERS: Record<string, { readonly exts: readonly string[]; readonly files: readonly string[] }> = {
  ts: { exts: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'], files: ['package.json', 'tsconfig.json'] },
  py: { exts: ['.py'], files: ['pyproject.toml', 'setup.py', 'requirements.txt'] },
  go: { exts: ['.go'], files: ['go.mod'] },
};

export interface SetupOptions {
  /** Install without asking. For a machine being provisioned rather than used. */
  readonly yes?: boolean;
  /** Report what would happen and change nothing. */
  readonly dryRun?: boolean;
  /**
   * Where the report goes. Injected rather than written straight to stdout so a
   * test can read it without replacing `process.stdout.write` — which the test
   * runner is also using, and which swallowed its results when tried.
   */
  readonly out?: (text: string) => void;
}

/**
 * Which languages this repository is actually written in.
 *
 * From the tracked file list rather than from a directory walk, so a vendored
 * dependency full of Python cannot convince the harness that a TypeScript
 * project needs pyright.
 */
async function languagesIn(root: string): Promise<string[]> {
  const listed = await runUntruncated('git ls-files', root, 20_000);
  const paths = listed.ok ? listed.output.split('\n').map((l) => l.trim()).filter(Boolean) : [];

  const found = new Set<string>();
  for (const [lang, marker] of Object.entries(MARKERS)) {
    const byExt = paths.some((p) => marker.exts.some((e) => p.endsWith(e)));
    const byFile = marker.files.some((f) => existsSync(join(root, f)));
    if (byExt || byFile) found.add(lang);
  }
  return [...found];
}

/** Asks once, on a real terminal. Anything but a clear yes is no. */
async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  process.stdout.write(`${question} ${pc.dim('[y/N]')} `);

  return new Promise((resolve) => {
    const onData = (chunk: Buffer): void => {
      process.stdin.pause();
      process.stdin.off('data', onData);
      const answer = chunk.toString('utf8').trim().toLowerCase();
      process.stdout.write('\n');
      resolve(answer === 'y' || answer === 'yes');
    };
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}

export async function runSetup(opts: SetupOptions = {}): Promise<number> {
  const repo = findRepo();
  const root = repo.root;
  // Bound before `say` exists, so the fallback cannot end up calling itself —
  // which a careless rewrite of this line once did, silently.
  const toStdout = process.stdout.write.bind(process.stdout);
  const say = opts.out ?? ((text: string) => {
    toStdout(text);
  });

  say(`${pc.bold('sumo setup')} ${pc.dim(root)}\n\n`);
  if (!repo.isGit) {
    say(
      pc.yellow('  not a git repository — the index and the ranker both list files with git\n') +
        pc.dim('  run `git init` first, then setup again\n'),
    );
    return 1;
  }

  // ---------------------------------------------------------------- survey --
  const langs = await languagesIn(root);
  const servers = serverStatus().filter((s) => langs.includes(s.lang));
  const missing = servers.filter((s) => !s.installed);
  const testCommand = detectTestCommand(root);

  say(`${pc.bold('found')}\n`);
  say(
    `  languages   ${langs.length > 0 ? langs.join(', ') : pc.dim('none recognised')}\n`,
  );
  say(
    `  tests       ${testCommand ?? pc.dim('none detected — set one with /tests <command>')}\n`,
  );
  for (const s of servers) {
    say(
      s.installed
        ? `  ${pc.green('✓')} ${s.label} ${pc.dim('already installed')}\n`
        : `  ${pc.dim('·')} ${s.label} ${pc.dim(`needs: ${s.install}`)}\n`,
    );
  }

  // ------------------------------------------------------------------ plan --
  const steps: string[] = [];
  if (missing.length > 0) steps.push(`install ${String(missing.length)} language server(s)`);
  steps.push('build the code index (writes .codegraph/)');
  steps.push('build the lexical ranker index (writes .sumo/)');
  if (langs.length > 0) steps.push('enable the precision layer for the languages found');

  say(`\n${pc.bold('will do')}\n`);
  for (const step of steps) say(`  ${step}\n`);

  if (opts.dryRun) {
    say(pc.dim('\n  --dry-run: nothing changed\n'));
    return 0;
  }

  // Global installs are the only part that reaches outside this repository, so
  // they are the only part that asks. Everything else writes into the repo and
  // is undone by deleting a directory.
  let installing = false;
  if (missing.length > 0) {
    say('\n');
    installing =
      opts.yes ||
      (await confirm(
        `  install ${missing.map((s) => pc.cyan(s.bin)).join(', ')} globally?`,
      ));
    if (!installing) {
      say(pc.dim('  skipping installs — run them yourself when you want them\n'));
    }
  }

  say('\n');

  // --------------------------------------------------------------- install --
  const installed: ServerStatus[] = [];
  if (installing) {
    for (const server of missing) {
      say(`  installing ${server.label} … `);
      // Generous: `go install` compiles, and a cold npm cache is not fast.
      const result = await run(server.install, root, 300_000);
      if (result.ok) {
        installed.push(server);
        say(`${pc.green('done')}\n`);
      } else {
        // A toolchain that is not there — no Go, no npm — is a fact about the
        // machine, not a failure of setup. Say so and carry on with the rest.
        say(
          `${pc.yellow('failed')}\n${pc.dim(`    run it yourself: ${server.install}\n`)}`,
        );
      }
    }
  }

  // ----------------------------------------------------------------- index --
  say('  building the code index … ');
  const context = await openContext(root, { allowInit: true });
  say(context.ready ? `${pc.green('done')}\n` : `${pc.yellow('unavailable')}\n`);

  say('  building the lexical ranker … ');
  const lexical = await LexicalIndex.open(root);
  say(
    lexical ? `${pc.green(`${String(lexical.size)} files`)}\n` : `${pc.yellow('skipped')}\n`,
  );
  await context.dispose();

  // ---------------------------------------------------------------- config --
  const enabled = serverStatus().filter((s) => langs.includes(s.lang) && s.installed);
  if (enabled.length > 0) {
    writeConfig(root, enabled.map((s) => s.lang));
    say(
      `  precision layer on for ${enabled.map((s) => pc.cyan(s.lang)).join(', ')}\n`,
    );
  }

  // ------------------------------------------------------------------ done --
  say(`\n${pc.bold('ready')} ${pc.dim('— run `sumo` here to start')}\n`);
  if (!testCommand) {
    say(
      pc.dim('  no test command found; `fix` and `feature` cannot verify without one\n'),
    );
  }
  const stillMissing = serverStatus().filter((s) => langs.includes(s.lang) && !s.installed);
  for (const s of stillMissing) {
    say(pc.dim(`  ${s.label} still absent: ${s.install}\n`));
  }
  return 0;
}

/**
 * Turns the precision layer on for the languages that can actually use it.
 *
 * Merged rather than overwritten: `.sumo/config.json` is the operator's file
 * and may hold settings this command knows nothing about.
 */
function writeConfig(root: string, langs: readonly string[]): void {
  try {
    const dir = join(root, '.sumo');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'config.json');

    let config: Record<string, unknown> = {};
    if (existsSync(path)) {
      try {
        config = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      } catch {
        // A malformed config is replaced rather than merged into.
      }
    }
    config['lsp'] = [...langs];
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  } catch (cause) {
    throw new SumoError(
      `Could not write .sumo/config.json: ${cause instanceof Error ? cause.message : String(cause)}`,
      'setup_config_failed',
      ['Check the directory is writable, or enable the layer per session with /lsp.'],
    );
  }
}
