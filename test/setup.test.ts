/**
 * `sumo setup` — the one command allowed to install things.
 *
 * Everywhere else the harness installs nothing, on the grounds that putting a
 * per-language toolchain on someone's machine uninvited is a bigger surprise
 * than telling them what to run. Typing `setup` is the invitation. What is
 * tested here is that the invitation stays narrow: it asks before reaching
 * outside the repository, it never installs a server for a language the project
 * does not use, and every step that can fail degrades instead of taking the
 * command down.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runSetup } from '../src/setup.ts';

/** A git repository holding the given files. */
function repoWith(files: Record<string, string>, init = true): string {
  const root = mkdtempSync(join(tmpdir(), 'sumo-setup-'));
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body, 'utf8');
  }
  if (init) {
    const git = (...args: string[]): void => {
      execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
    };
    git('init', '-q');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    git('add', '-A');
    git('commit', '-qm', 'init');
  }
  return root;
}

/**
 * Runs setup with cwd moved, collecting its report.
 *
 * The report is collected through the injected writer rather than by replacing
 * `process.stdout.write`. Replacing it swallowed the test runner's own output —
 * six of seven results vanished and the file looked like it held one test.
 */
async function setupIn(root: string, opts: Parameters<typeof runSetup>[0] = {}): Promise<{
  code: number;
  out: string;
}> {
  const cwd = process.cwd();
  const written: string[] = [];
  try {
    process.chdir(root);
    const code = await runSetup({ ...opts, out: (text) => written.push(text) });
    // eslint-disable-next-line no-control-regex -- colour is not the subject
    return { code, out: written.join('').replace(/\x1b\[[0-9;]*m/g, '') };
  } finally {
    process.chdir(cwd);
  }
}

test('a dry run reports the plan and changes nothing', async () => {
  const root = repoWith({ 'package.json': '{"name":"x"}', 'src/a.ts': 'export const a = 1;\n' });
  try {
    const { code, out } = await setupIn(root, { dryRun: true });
    assert.equal(code, 0);
    assert.match(out, /languages\s+ts/);
    assert.match(out, /nothing changed/);

    // The proof is on disk, not in the wording.
    assert.equal(existsSync(join(root, '.codegraph')), false, 'no index built');
    assert.equal(existsSync(join(root, '.sumo', 'config.json')), false, 'no config written');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a vendored dependency cannot pass for a project language', async () => {
  // The reason languages come from `git ls-files` rather than a directory walk.
  // A TypeScript project with a Python file inside node_modules must not be
  // told it needs pyright — and the mistake would be invisible, because the
  // only symptom is a language server nobody asked for.
  const root = repoWith({ 'package.json': '{"name":"x"}', 'src/a.ts': 'export const a = 1;\n' });
  try {
    mkdirSync(join(root, 'node_modules', 'thing'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'thing', 'setup.py'), 'x = 1\n', 'utf8');
    writeFileSync(join(root, '.gitignore'), 'node_modules/\n', 'utf8');

    const { out } = await setupIn(root, { dryRun: true });
    assert.match(out, /languages\s+ts/);
    assert.doesNotMatch(out, /Python/, 'an ignored file must not summon a language server');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('it declines outside a repository, and says why', async () => {
  // Both the index and the ranker list files with git. Without one there is
  // nothing to set up, and saying so beats half-configuring a directory.
  const root = repoWith({ 'src/a.ts': 'export const a = 1;\n' }, false);
  try {
    const { code, out } = await setupIn(root);
    assert.equal(code, 1);
    assert.match(out, /not a git repository/);
    assert.match(out, /git init/, 'names the way forward');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('installing is never assumed on a non-interactive run', async () => {
  // `confirm` returns false without a TTY, which is how a piped or scripted run
  // behaves: it sets up everything local and touches nothing global. `--yes` is
  // the only way to install unattended, and it has to be typed.
  const root = repoWith({ 'go.mod': 'module x\n', 'main.go': 'package main\n' });
  try {
    const { code, out } = await setupIn(root);
    assert.equal(code, 0);
    // Either gopls is already on this machine, or it was skipped — never
    // installed silently.
    if (!/gopls.*already installed/s.test(out)) {
      assert.match(out, /skipping installs|still absent/, 'no silent global install');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a project with no test command is set up anyway, and told', async () => {
  // Missing tests is worth saying — `fix` and `feature` cannot verify without
  // one — but it is not a reason to refuse to index the repository.
  const root = repoWith({ 'src/a.ts': 'export const a = 1;\n' });
  try {
    const { code, out } = await setupIn(root);
    assert.equal(code, 0);
    assert.match(out, /none detected/);
    assert.match(out, /cannot verify without one/);
    assert.match(out, /ready/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an existing config keeps the settings setup knows nothing about', async () => {
  const root = repoWith({ 'package.json': '{"name":"x"}', 'src/a.ts': 'export const a = 1;\n' });
  try {
    mkdirSync(join(root, '.sumo'), { recursive: true });
    writeFileSync(
      join(root, '.sumo', 'config.json'),
      JSON.stringify({ somethingElse: 'keep me', lsp: false }),
      'utf8',
    );

    await setupIn(root);

    const config = JSON.parse(readFileSync(join(root, '.sumo', 'config.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    // It is the operator's file. Setup owns one key in it.
    assert.equal(config['somethingElse'], 'keep me');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('running it twice is safe and lands in the same place', async () => {
  // Setup is a thing people re-run after pulling, or when something looks off.
  // It has to be boring the second time.
  const root = repoWith({ 'package.json': '{"name":"x"}', 'src/a.ts': 'export const a = 1;\n' });
  try {
    const first = await setupIn(root);
    const second = await setupIn(root);
    assert.equal(first.code, 0);
    assert.equal(second.code, 0);
    assert.match(second.out, /ready/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
