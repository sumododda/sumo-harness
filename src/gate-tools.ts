/**
 * Tool gates: the harness's veto over what a stage may do.
 *
 * These are defence in depth. A read-only stage already lacks Edit and Write in
 * its tool set, so the gate exists to catch anything that slips past — and to
 * enforce rules the tool set can't express, like path confinement and locked
 * test files.
 */

import * as features from './features.ts';
import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { ToolGate } from './engine/types.ts';

/** Pulls the target path out of whichever field a tool uses for it. */
function targetPath(input: Record<string, unknown>): string | null {
  for (const key of ['file_path', 'path', 'notebook_path']) {
    const value = input[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

export function isInside(root: string, candidate: string): boolean {
  const abs = isAbsolute(candidate) ? candidate : resolve(root, candidate);
  const rel = relative(root, abs);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
const READ_AND_WRITE_TOOLS = new Set(['Read', ...WRITE_TOOLS]);

/**
 * Path shapes that hold credentials, keyed by what they look like rather than
 * where they live — a stage can put a `.env` anywhere. `.env.example` and
 * friends are deliberately exempt: those are placeholder files meant to be
 * read and committed.
 */
const CREDENTIAL_PATH_PATTERNS: readonly RegExp[] = [
  /(^|\/)\.env(\.(?!example|sample|template|dist)[^/]+)?$/,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/,
  /\.(pem|key|pfx|p12)$/i,
  /(^|\/)\.aws\/(credentials|config)$/,
  /(^|\/)\.ssh\//,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.netrc$/,
  /(^|\/)(service[-_]?account|credentials)[^/]*\.json$/i,
];

export function isCredentialPath(path: string): boolean {
  return CREDENTIAL_PATH_PATTERNS.some((pattern) => pattern.test(path));
}

/**
 * Secret shapes recognised in content a stage is about to write, independent
 * of where it's headed — a placeholder key hardcoded into ordinary source is
 * exactly the case a path-based check can't catch.
 */
const SECRET_CONTENT_PATTERNS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: 'a private key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: 'an AWS access key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: 'a GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36}\b/ },
  { label: 'a GitHub fine-grained token', pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  { label: 'a Slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { label: 'a Stripe live key', pattern: /\bsk_live_[A-Za-z0-9]{16,}\b/ },
];

/** Pulls whatever text a write tool is about to put on disk. */
function writtenContent(toolName: string, input: Record<string, unknown>): string {
  const field = toolName === 'Edit' ? 'new_string' : 'content';
  const value = input[field];
  return typeof value === 'string' ? value : '';
}

/**
 * Finds a secret-shaped pattern in content, if any.
 *
 * Exported rather than kept as an inline check because `fix.ts` needs the
 * identical test: a proposed repro test's content reaches disk directly from
 * a schema field, with no Edit/Write tool call for this gate to intercept, so
 * that write path has to run the same screening itself or it would be the one
 * write path in the harness with none of it. Sharing the function is what
 * keeps the two from quietly drifting apart the way two copies of the same
 * regex eventually do.
 */
export function findSecret(content: string): { readonly label: string } | null {
  return SECRET_CONTENT_PATTERNS.find(({ pattern }) => pattern.test(content)) ?? null;
}

export interface GateOptions {
  /** Absolute path every write must stay within. */
  readonly root: string;
  /** When false, all writes are refused. */
  readonly allowWrites: boolean;
  /** Paths that must not be modified even in a writable stage, e.g. tests during implement. */
  readonly lockedPaths?: readonly string[];
  /**
   * Throttle broad searching because an index already answered the question.
   * Not a ban: a literal-string hunt is legitimate, and the first few are free.
   */
  readonly indexed?: boolean;
  /**
   * Counts allowed edits by kind. Mutated in place so the caller can read the
   * tally once the stage finishes — the difference between a targeted `Edit` and
   * a whole-file `Write` is the difference the output-token budget feels.
   */
  readonly tally?: { edit: number; write: number };
  /**
   * Refuse `Write` to a file that already exists, directing the model to `Edit`.
   *
   * Rewriting a whole file to change three lines means generating the entire
   * file as output — the study this follows found block- and function-level
   * edits matched full-file accuracy at over 30% lower cost. New files are
   * unaffected: there is nothing to edit yet.
   *
   * This is a first-attempt preference, not a rule. When a stage has already
   * failed once the harness drops it, because a task lost to an edit format
   * would be a far worse outcome than a task that cost more than it needed to.
   */
  readonly preferTargetedEdits?: boolean;
}

/**
 * Text searches allowed per stage before the index is pointed to instead.
 *
 * Generous on purpose. The pack covers the task's own code, not the whole repo,
 * so a stage legitimately searches for things it does not describe — build
 * config, test setup, a literal string. Denying those wastes far more than the
 * search would have.
 */
const FREE_SEARCHES = 6;

/**
 * Builds the gate for a stage. Returns null to allow, or a reason string that is
 * shown to the model so it can correct course rather than retrying blindly.
 */
export function buildGate(opts: GateOptions): ToolGate {
  const locked = new Set((opts.lockedPaths ?? []).map((p) => resolve(opts.root, p)));
  let searches = 0;

  return (toolName, input) => {
    // Bash is never in a stage's tool set; refuse explicitly if one ever appears.
    if (toolName === 'Bash' || toolName === 'BashOutput' || toolName === 'KillShell') {
      return 'Shell access is not available. The harness runs commands; describe what you need run instead.';
    }

    // Glob is never throttled. It answers "what files exist called X", which the
    // index pack — a semantic slice around one task — genuinely does not cover.
    // Throttling it made stages fight the gate while hunting for test files.
    if (opts.indexed && features.get().searchThrottle && toolName === 'Grep') {
      searches += 1;
      if (searches > FREE_SEARCHES) {
        // Names what is still available rather than asking for an explanation.
        // The old wording invited the model to "say what you are looking for
        // and why the context is insufficient" — and nothing read the answer.
        // Denials are counted, never parsed, so there was no way to earn the
        // search back: a refusal dressed as a negotiation.
        return (
          `No more text searches in this stage (${String(FREE_SEARCHES)} used). ` +
          'Read any file — reads are not limited — or use Glob to find one by name. ' +
          'The indexed context above was selected for this task and is the faster answer.'
        );
      }
      return null;
    }

    // Credential-shaped paths are refused for both reading and writing, in every
    // stage — a read-only stage that can't Read a `.env` was never the gap; a
    // writable stage that could still read one and echo it into an answer was.
    if (READ_AND_WRITE_TOOLS.has(toolName)) {
      const target = targetPath(input);
      if (target !== null && isCredentialPath(target)) {
        return `${target} looks like a credential file. This harness does not read or write those — describe the value you need instead of the file.`;
      }
    }

    if (!WRITE_TOOLS.has(toolName)) return null;

    if (!opts.allowWrites) {
      return 'This stage is read-only. Report findings; a later stage will make changes.';
    }

    const target = targetPath(input);
    if (target === null) {
      return 'Write refused: no file path given.';
    }

    if (!isInside(opts.root, target)) {
      return `Write refused: ${target} is outside the working directory.`;
    }

    if (locked.has(resolve(opts.root, target))) {
      return `${target} is locked for this stage. Change the implementation so the existing tests pass — do not edit the tests.`;
    }

    const matchedSecret = findSecret(writtenContent(toolName, input));
    if (matchedSecret) {
      return `Write refused: this looks like it contains ${matchedSecret.label}. Use an environment variable or placeholder instead.`;
    }

    if (opts.preferTargetedEdits && toolName === 'Write' && existsSync(resolve(opts.root, target))) {
      return `${target} already exists — use Edit to change the parts that need changing. Rewriting the whole file regenerates every line that was already correct.`;
    }

    // Counted only once the edit is actually allowed, so the tally reflects work
    // done rather than work attempted.
    if (opts.tally) {
      if (toolName === 'Write') opts.tally.write += 1;
      else opts.tally.edit += 1;
    }

    return null;
  };
}
