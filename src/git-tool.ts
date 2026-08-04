/**
 * A git tool the model may call directly.
 *
 * This is a deliberate, narrow exception to "the model has no shell". It can
 * run git and nothing else, only the subcommands listed here, and never with
 * arguments that publish, discard, or rewrite work. The model composes the
 * intent; this module decides whether it is allowed to happen.
 *
 * The distinction that matters: a shell would let the model do anything git
 * could reach. This lets it change branch and read history.
 */

import { run } from './runner.ts';

/**
 * Subcommands the model may run.
 *
 * Everything here either reads state or moves a local pointer — both trivially
 * recoverable. Anything that touches a remote, discards work, or rewrites
 * history is absent on purpose.
 */
const ALLOWED = new Set([
  'status',
  'branch',
  'checkout',
  'switch',
  'log',
  'diff',
  'show',
  'rev-parse',
  'ls-files',
  'describe',
  'blame',
  // Reachable, but narrowed to its reading forms by ARGUMENT_RULES below —
  // every other thing `stash` does moves work out of the tree.
  'stash',
]);

/**
 * Flags that turn an allowed subcommand into a destructive one.
 *
 * `git checkout -- .` throws away uncommitted work, and `git stash drop`
 * discards it outright, so the subcommand alone is not enough to judge by.
 */
const FORBIDDEN_FLAGS: readonly (readonly [RegExp, string])[] = [
  [/(^|\s)--(\s|$)/, 'names files to restore, which discards their changes'],
  [/(^|\s)-(f|-force)\b/, 'forces an overwrite'],
  [/(^|\s)-(D|d)\b/, 'deletes a branch'],
  [/(^|\s)--hard\b/, 'discards work'],
  [/(^|\s)(drop|clear|pop)\b/, 'discards stashed work'],
  [/(^|\s)--delete\b/, 'deletes a branch'],
  [/(^|\s)--discard-changes\b/, 'discards work'],
];

/**
 * Rules for subcommands whose danger is in their arguments rather than in a
 * flag, checked after the flag list.
 *
 * A blocklist of flags is the wrong shape for these. `git stash` with no
 * arguments at all is `git stash push` — it takes every uncommitted change out
 * of the working tree — and `git checkout .` restores from the index, which
 * throws those changes away outright. Neither carries a flag to blocklist, and
 * both were reachable while this module claimed in its own documentation that
 * they were not.
 */
const ARGUMENT_RULES: Partial<Record<string, (rest: readonly string[]) => string | null>> = {
  /**
   * Only the two subcommands that read. Everything else `stash` does moves work
   * out of the tree, including the bare form, which is the dangerous default.
   */
  stash: (rest) => {
    const action = rest[0] ?? 'push';
    return action === 'list' || action === 'show'
      ? null
      : 'only `stash list` and `stash show` are available to you — anything else takes uncommitted work out of the tree';
  },

  /**
   * Moving HEAD is fine; naming paths is a restore.
   *
   * A branch change takes exactly one non-flag argument. Two means the second
   * is a pathspec, and `.` means all of them — both restore files from the
   * index over whatever is in the working tree.
   */
  checkout: pathspecRule,
  switch: pathspecRule,
};

function pathspecRule(rest: readonly string[]): string | null {
  const operands = rest.filter((token) => !token.startsWith('-'));
  if (operands.includes('.')) {
    return 'checking out `.` restores every file from the index, discarding uncommitted changes';
  }
  if (operands.length > 1) {
    return 'naming files to check out restores them from the index, discarding their changes — switch branches only';
  }
  return null;
}

/** Anything that could reach outside this machine. */
const REMOTE = /(^|\s)(push|pull|fetch|remote|clone|submodule)\b/;

export interface GitVerdict {
  readonly allowed: boolean;
  readonly reason?: string;
}

/** Decides whether the model may run this git invocation. */
export function screenGit(args: string): GitVerdict {
  const trimmed = args.trim();
  if (trimmed.length === 0) return { allowed: false, reason: 'no git arguments given' };

  // Shell metacharacters would turn one command into several.
  if (/[;&|`$><]|\$\(/.test(trimmed)) {
    return { allowed: false, reason: 'git arguments may not chain or redirect' };
  }

  const [subcommand = '', ...rest] = trimmed.split(/\s+/);
  if (!ALLOWED.has(subcommand)) {
    // Naming the operator matters: without it a model tends to give up rather
    // than report back that a human needs to run the command.
    return {
      allowed: false,
      reason:
        `git ${subcommand} is not available to you — ask the operator to run it. ` +
        `You may use: ${[...ALLOWED].sort().join(', ')}.`,
    };
  }

  if (REMOTE.test(trimmed)) {
    return { allowed: false, reason: 'commands that reach a remote need the operator to run them' };
  }

  for (const [pattern, why] of FORBIDDEN_FLAGS) {
    if (pattern.test(trimmed)) {
      return { allowed: false, reason: `refused: that ${why}. Ask the operator to run it.` };
    }
  }

  const objection = ARGUMENT_RULES[subcommand]?.(rest);
  if (objection) {
    return { allowed: false, reason: `refused: ${objection}. Ask the operator to run it.` };
  }

  return { allowed: true };
}

export interface GitRun {
  readonly ok: boolean;
  readonly output: string;
}

/** Runs a screened git command. Screening is the caller's responsibility. */
export async function runGit(args: string, cwd: string): Promise<GitRun> {
  const result = await run(`git ${args}`, cwd, 30_000);
  return {
    ok: result.ok,
    output: result.output.trim() || (result.ok ? '(no output)' : `exit ${result.code ?? '?'}`),
  };
}
