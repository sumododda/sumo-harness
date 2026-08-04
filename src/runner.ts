/**
 * Deterministic execution: tests, git, and repro commands.
 *
 * The model never runs any of this. That keeps stages honest — a test result is
 * something the harness observed, not something the model reported — and it is
 * the single biggest token saving in the design.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 120_000;
/** Test output is fed back into prompts, so it must not flood the context. */
const MAX_OUTPUT_CHARS = 6_000;

export interface CommandResult {
  readonly command: string;
  readonly ok: boolean;
  readonly code: number | null;
  /** Combined stdout and stderr, tail-truncated. */
  readonly output: string;
  readonly timedOut: boolean;
}

/**
 * Runs a TRUSTED shell command, capturing output without ever throwing.
 *
 * The command string reaches a shell, so it must originate from the harness
 * itself or from the user's own `.sumo/config.json` — never from a model.
 * Model-proposed commands go through {@link screenProposedCommand} and an
 * explicit approval before they get here.
 */
export async function run(
  command: string,
  cwd: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<CommandResult> {
  const result = await runUntruncated(command, cwd, timeoutMs);
  return { ...result, output: tail(result.output) };
}

/**
 * {@link run} without the truncation.
 *
 * Only for callers where dropping the head of the output would change the
 * answer rather than merely shorten it — content hashing in particular, where a
 * truncated `git status` would quietly stop noticing early files.
 */
export async function runUntruncated(
  command: string,
  cwd: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await exec(command, {
      cwd,
      shell: true,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      env: childEnv(),
    });
    return {
      command,
      ok: true,
      code: 0,
      output: `${stdout}${stderr}`.trimEnd(),
      timedOut: false,
    };
  } catch (cause) {
    const err = cause as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
      killed?: boolean;
    };
    const timedOut = err.killed === true || err.code === 'ETIMEDOUT';
    return {
      command,
      ok: false,
      code: typeof err.code === 'number' ? err.code : null,
      output: (`${err.stdout ?? ''}${err.stderr ?? ''}` || (err.message ?? '')).trimEnd(),
      timedOut,
    };
  }
}

/**
 * Variables that make a child test run report someone else's context.
 *
 * `NODE_TEST_CONTEXT` is the dangerous one: inherited by a nested `node --test`,
 * it switches the child to a reporter that exits 0 even when tests fail. A
 * harness that trusts exit codes would then call a broken fix verified — so the
 * whole "the harness observed it" guarantee depends on stripping these.
 */
const INHERITED_TEST_VARS = [
  'NODE_TEST_CONTEXT',
  'NODE_V8_COVERAGE',
  'NODE_TEST_NAME_PATTERN',
  'NODE_TEST_SKIP_PATTERN',
] as const;

/** A clean environment for a child command. */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CI: '1', NO_COLOR: '1' };
  for (const name of INHERITED_TEST_VARS) delete env[name];
  return env;
}

/** Keeps the end of the output, where failures and summaries live. */
function tail(text: string): string {
  const trimmed = text.trimEnd();
  if (trimmed.length <= MAX_OUTPUT_CHARS) return trimmed;
  return `…(earlier output truncated)…\n${trimmed.slice(-MAX_OUTPUT_CHARS)}`;
}

/**
 * Works out how to run this project's tests.
 *
 * Only the three supported ecosystems are probed; anything else asks the user
 * once rather than guessing at a command that might do something unexpected.
 */
const PYTEST = 'python3 -m pytest -q';

export function detectTestCommand(root: string): string | null {
  const pkgPath = join(root, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
        scripts?: Record<string, string>;
        devDependencies?: Record<string, string>;
        dependencies?: Record<string, string>;
      };
      const scripts = pkg.scripts ?? {};

      if (scripts['test']) return 'npm test --silent';

      // Plenty of real projects have tests under a differently-named script.
      for (const name of ['test:unit', 'test:run', 'unit', 'tests', 'vitest', 'jest']) {
        if (scripts[name]) return `npm run ${name} --silent`;
      }

      // Or a runner in devDependencies with no script wired up at all.
      const deps = { ...pkg.devDependencies, ...pkg.dependencies };
      if (deps['vitest']) return 'npx vitest run';
      if (deps['jest']) return 'npx jest';
      // Playwright and Cypress drive a browser; running them unasked is too
      // slow and too stateful to assume, so they are deliberately not matched.
    } catch {
      // A malformed package.json is not this function's problem.
    }
  }

  if (existsSync(join(root, 'go.mod'))) return 'go test ./...';

  for (const marker of ['pyproject.toml', 'pytest.ini', 'setup.cfg', 'tox.ini', 'tests', 'test']) {
    if (existsSync(join(root, marker))) return PYTEST;
  }

  // A flat project with `test_x.py` beside the code is an ordinary pytest
  // layout and carries none of the markers above.
  try {
    if (readdirSync(root).some((f) => /^test_.*\.py$|.*_test\.py$/.test(f))) {
      return PYTEST;
    }
  } catch {
    // An unreadable directory simply has no detectable test command.
  }

  return null;
}

/**
 * Reads the test command the user has already told us about.
 *
 * Stored per repo so the question is asked once, not at every gate.
 */
export function storedTestCommand(root: string): string | null {
  try {
    const config = JSON.parse(
      readFileSync(join(root, '.sumo', 'config.json'), 'utf8'),
    ) as { testCommand?: string };
    const stored = config.testCommand?.trim();
    return stored && stored.length > 0 ? stored : null;
  } catch {
    return null;
  }
}

/** Remembers a test command for this repo. */
export function storeTestCommand(root: string, command: string): void {
  const path = join(root, '.sumo', 'config.json');
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    // No config yet, or an unreadable one: start fresh rather than fail.
  }
  config['testCommand'] = command;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

export interface TestOutcome extends CommandResult {
  /** True when the suite ran and every test passed. */
  readonly passed: boolean;
}

/** Runs the project's tests. `passed` is deliberately distinct from `ok`. */
export async function runTests(command: string, cwd: string): Promise<TestOutcome> {
  const result = await run(command, cwd);
  return { ...result, passed: result.ok };
}

/**
 * Commands that reach outside this machine or destroy work. A model-proposed
 * repro command has no business doing any of these, and the user should see a
 * loud warning if one shows up.
 */
const ALARMING: readonly (readonly [RegExp, string])[] = [
  [/\brm\s+-[rf]/i, 'deletes files recursively'],
  [/\b(curl|wget|nc|ncat|ssh|scp|rsync)\b/i, 'contacts the network'],
  [/>\s*\/dev\/(sd|disk|nvme)/i, 'writes to a raw device'],
  [/\b(sudo|doas|su)\b/i, 'escalates privileges'],
  // Kept in step with the git tool's own screen in src/git-tool.ts. The two
  // drifted apart once already: that one learned that `stash` with no
  // subcommand takes uncommitted work out of the tree and that `checkout` with
  // a pathspec restores over it, while this one still knew only about `push`,
  // `reset --hard` and `clean`. A real proposed repro then read
  // `git stash; … ; git checkout -- src/note.ts` and the only warning offered
  // was that it chained commands.
  [
    /\bgit\s+(push|reset\s+--hard|clean\s+-[fdx]|restore\b|stash(?!\s+(list|show)))/i,
    'discards or publishes work',
  ],
  // `git checkout main` moves a pointer; `git checkout -- x` and `git checkout .`
  // overwrite the working tree from the index, which is not recoverable.
  [/\bgit\s+checkout\s+(.*\s)?(--(\s|$)|\.(\s|$))/i, 'discards uncommitted changes'],
  [/\b(shutdown|reboot|halt|mkfs|dd)\b/i, 'affects the whole system'],
  [/[;&|`$]|\$\(/, 'chains or substitutes commands'],
];

export interface CommandScreening {
  /** Reasons this command looks risky. Empty means nothing stood out. */
  readonly concerns: readonly string[];
}

/**
 * Inspects a command a model proposed, so the approval prompt can say what is
 * unusual about it. This is an aid to the human decision, not a security
 * boundary — the boundary is that the user must approve it at all.
 */
export function screenProposedCommand(command: string): CommandScreening {
  const concerns: string[] = [];
  for (const [pattern, why] of ALARMING) {
    if (pattern.test(command)) concerns.push(why);
  }
  return { concerns };
}

/**
 * Files this task has touched, tracked or not.
 *
 * The untracked half is not a nicety. `git diff` only knows about files git
 * already knows about, so a brand-new file is invisible to it — and a stage
 * whose whole job is to create one (writing the first test for a module that
 * had none) would look like it had done nothing at all. The `feature` workflow
 * reads this to decide whether tests were written, and to decide which paths to
 * lock while implementing, so missing a new file both aborts the task and
 * removes the lock that stops a test being weakened.
 *
 * Untruncated on purpose: this is a list, and dropping the head of it silently
 * loses entries rather than merely shortening a message.
 */
export async function changedFiles(cwd: string): Promise<string[]> {
  const [tracked, untracked] = await Promise.all([
    runUntruncated('git diff --name-only HEAD', cwd, 10_000),
    runUntruncated('git ls-files --others --exclude-standard', cwd, 10_000),
  ]);

  const files = new Set<string>();
  for (const result of [tracked, untracked]) {
    if (!result.ok) continue;
    for (const line of result.output.split('\n')) {
      const path = line.trim();
      if (path.length > 0) files.add(path);
    }
  }

  return [...files].sort();
}

/**
 * The files this repository actually contains, as git sees them.
 *
 * Exists because `Glob` does not answer this reliably. Asked for everything in
 * a Node project with dependencies installed, it answers from `node_modules`
 * first and truncates: one real session got "100 of 222 files", every one of
 * them a dependency, and the explore stage concluded that a repository holding
 * five source files and two test files was empty. It then planned to scaffold
 * what was already there.
 *
 * `git ls-files` cannot make that mistake — it lists tracked files only, so
 * everything ignored is excluded by construction rather than by a pattern
 * someone has to remember to write. One subprocess, no tokens.
 *
 * Empty outside a repository, or when there are more files than belong in a
 * prompt: past that point a listing stops being orientation and becomes the
 * noise it was meant to replace.
 */
export async function repoFiles(cwd: string, max = MAX_LISTED_FILES): Promise<string[]> {
  const listed = await runUntruncated('git ls-files', cwd, 10_000);
  if (!listed.ok) return [];

  const files = listed.output.split('\n').map((line) => line.trim()).filter(Boolean);
  return files.length > max ? [] : files;
}

/** Above this a file listing is noise rather than orientation. */
const MAX_LISTED_FILES = 400;

/**
 * The working diff, for review before changes are accepted.
 *
 * Not yet wired to a caller. The design calls for the end-of-task summary to
 * show what actually changed, and no workflow does that today — a task can
 * finish "verified" without the operator ever being shown the edit. Kept, and
 * flagged here, because the gap is in the workflows rather than in this.
 *
 * @public
 */
export async function diff(cwd: string): Promise<string> {
  const result = await run('git --no-pager diff', cwd, 10_000);
  return result.ok ? result.output : '';
}

/** True when the working tree has no uncommitted changes. */
export async function isClean(cwd: string): Promise<boolean> {
  const result = await run('git status --porcelain', cwd, 10_000);
  return result.ok && result.output.trim().length === 0;
}

/**
 * Extracts the set of failing-test lines from a run.
 *
 * Deliberately format-agnostic: it matches the failure markers used by
 * node:test, pytest, and go test rather than parsing any one of them. Used only
 * to compare one run against another, so a missed line costs accuracy in the
 * summary, never correctness of the pass/fail verdict itself.
 */
export function failureLines(output: string): Set<string> {
  const lines = new Set<string>();
  for (const raw of output.split('\n')) {
    const line = raw.trim();
    if (/^(✖|✗|not ok\b|FAILED\b|FAIL[:\s]|---\s+FAIL)/.test(line)) {
      // A section header, not a failing test.
      if (/^(✖|✗)\s*failing tests:?$/i.test(line)) continue;
      // Drop trailing timings so the same failure matches across runs.
      lines.add(line.replace(/\(\d+(\.\d+)?m?s\)\s*$/, '').trim());
    }
  }
  return lines;
}

/** Failures present now that were not present before. */
export function newFailures(before: string, after: string): string[] {
  const known = failureLines(before);
  return [...failureLines(after)].filter((line) => !known.has(line));
}

/** The branch currently checked out, or null outside a git repo. */
export async function currentBranch(cwd: string): Promise<string | null> {
  const result = await run('git rev-parse --abbrev-ref HEAD', cwd, 10_000);
  const name = result.output.trim();
  return result.ok && name.length > 0 ? name : null;
}

/** Everything under this prefix is a branch the harness made for its own work. */
export const SUMO_BRANCH_PREFIX = 'sumo/';

export function isSumoBranch(name: string | null): boolean {
  return name !== null && name.startsWith(SUMO_BRANCH_PREFIX);
}

/**
 * Turns a task description into a readable branch name.
 *
 * Derived from the text rather than asked of a model: it costs nothing, and a
 * branch name is not worth a round trip.
 *
 * Deliberately free of any timestamp. One used to be appended, which meant the
 * same task produced a different branch on every attempt — so iterating on a
 * feature scattered it across a branch per turn and left each previous attempt
 * stranded. The name describes the work, so the same work resolves to the same
 * branch and the second attempt lands where the first one is.
 */
export function branchNameFor(task: string): string {
  const slug = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .split('-')
    .filter((word) => word.length > 0 && !FILLER.has(word))
    .slice(0, 5)
    .join('-')
    .slice(0, 48)
    .replace(/-+$/, '');

  return `${SUMO_BRANCH_PREFIX}${slug || 'task'}`;
}

/** Words that would otherwise eat the branch name's budget without adding meaning. */
const FILLER = new Set([
  'a', 'an', 'the', 'to', 'for', 'of', 'in', 'on', 'at', 'and', 'or',
  'is', 'are', 'be', 'it', 'this', 'that', 'with', 'from', 'into', 'please',
]);

export type BranchResult =
  | { readonly kind: 'created'; readonly branch: string; readonly from: string }
  /** Work already had a branch; this attempt joins it rather than forking again. */
  | { readonly kind: 'reused'; readonly branch: string }
  | { readonly kind: 'skipped'; readonly why: string };

/**
 * Puts the task on a branch of its own, creating one only when it needs to.
 *
 * Three cases, and the first two are why this is not just `checkout -b`:
 *
 *   - already on a harness branch — this is the next attempt at work that has a
 *     home, so it joins it. Branching again would fork a branch off a branch,
 *     which is how three branches ended up pointing at one commit with no
 *     distinct work between them;
 *   - the branch already exists — the same task, run again. Switch to it, for
 *     the same reason;
 *   - otherwise create it, from wherever the operator actually is.
 *
 * Refuses on a dirty tree rather than stashing: quietly moving someone's
 * uncommitted work is exactly the kind of surprise this harness should not
 * spring on anyone.
 */
export async function createBranch(cwd: string, branch: string): Promise<BranchResult> {
  const from = await currentBranch(cwd);
  if (from === null) return { kind: 'skipped', why: 'not a git repository' };

  // Iterating on work that already has a branch. Staying put is the whole point
  // — the previous attempt is here, and the next one belongs beside it.
  if (isSumoBranch(from)) return { kind: 'reused', branch: from };

  if (!(await isClean(cwd))) {
    return {
      kind: 'skipped',
      why: 'the working tree has uncommitted changes — commit or stash them first',
    };
  }

  const already = await run(`git rev-parse --verify --quiet ${shellQuote(branch)}`, cwd, 10_000);
  if (already.ok && already.output.trim().length > 0) {
    const switched = await run(`git checkout ${shellQuote(branch)}`, cwd, 15_000);
    return switched.ok
      ? { kind: 'reused', branch }
      : { kind: 'skipped', why: `git refused to switch to ${branch}` };
  }

  const created = await run(`git checkout -b ${shellQuote(branch)}`, cwd, 15_000);
  if (!created.ok) {
    return { kind: 'skipped', why: `git refused to create ${branch}` };
  }

  return { kind: 'created', branch, from };
}

/** Single-quotes a value so git receives it as one literal argument. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
