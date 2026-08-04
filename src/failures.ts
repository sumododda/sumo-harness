/**
 * Test output, reduced to records.
 *
 * A retry prompt does not need six thousand characters of log; it needs to know
 * which assertions failed and what they expected. Sending the raw tail instead
 * pays for stack frames, progress dots and passing tests on every attempt, and
 * buries the two lines that matter in the middle of the context.
 *
 * The second job is the delta. Between attempts most failures are the same
 * failures, and repeating them wastes tokens while implying the last change did
 * nothing. Only what is newly broken is worth another look.
 *
 * Parsing is deliberately conservative: three known runners, and a caller that
 * falls back to the raw tail whenever nothing was recognised. A normaliser that
 * silently drops the one failure the model needed would be worse than verbose.
 */

import { encode } from '@toon-format/toon';
import * as features from './features.ts';

export interface Failure {
  /** The test's name, as its runner prints it. */
  readonly test: string;
  readonly file?: string;
  readonly line?: number;
  readonly expected?: string;
  readonly actual?: string;
  /** The assertion message, when the runner gave one. */
  readonly message?: string;
}

/** Failures worth naming in a prompt. Beyond this the list stops being read. */
const MAX_IN_PROMPT = 12;

/**
 * Extracts failures from a test run.
 *
 * Returns an empty array when nothing matched, which the caller must treat as
 * "use the raw output" rather than "the suite passed".
 */
export function parse(output: string): Failure[] {
  const found = [...parseNode(output), ...parsePytest(output), ...parseGo(output)];

  // A run can match more than one parser — a Go suite invoked through npm, say.
  // Identity is the test plus where it lives.
  const seen = new Set<string>();
  return found.filter((f) => {
    const key = `${f.test}|${f.file ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * node:test, spec reporter.
 *
 * Node uses `spec` even when its output is piped, so the detailed block below
 * `✖ failing tests:` is what gets parsed. Each entry there is a `test at
 * file:line:col` line followed by the failing test and its assertion.
 */
function parseNode(output: string): Failure[] {
  const lines = output.split('\n');
  const failures: Failure[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const location = /^test at (.+):(\d+):\d+$/.exec(lines[i]!.trim());
    if (!location) continue;

    // The summary at the top of the run repeats these names without a location
    // line, so anchoring on `test at` selects the detailed section exactly once.
    const nameLine = lines[i + 1]?.trim() ?? '';
    const name = /^[✖✗]\s+(.*?)\s*\([\d.]+m?s\)$/.exec(nameLine);
    if (!name) continue;

    const block = lines.slice(i + 2, i + 32).join('\n');
    failures.push({
      test: name[1]!,
      file: location[1]!,
      line: Number(location[2]),
      ...field(block, /^\s*expected:\s*(.+?),?$/m),
      ...field(block, /^\s*actual:\s*(.+?),?$/m, 'actual'),
      ...messageOf(/^\s*(\w*Error(?:\s*\[[^\]]+\])?:\s*.+)$/m.exec(block)?.[1]),
    });
  }

  return failures;
}

/**
 * pytest.
 *
 * The `short test summary info` section is the compact one, and `-q` still
 * prints it: `FAILED file::test - message`.
 */
function parsePytest(output: string): Failure[] {
  const failures: Failure[] = [];
  const lines = output.split('\n');

  for (const raw of lines) {
    const match = /^FAILED\s+(\S+?)::(\S+?)(?:\s+-\s+(.*))?$/.exec(raw.trim());
    if (!match) continue;

    const file = match[1]!;
    const test = match[2]!;
    const message = match[3]?.trim();

    // The traceback carries the line number the summary omits.
    const located = new RegExp(`^${escapeRegExp(file)}:(\\d+):`, 'm').exec(output);

    failures.push({
      test,
      file,
      ...(located ? { line: Number(located[1]) } : {}),
      ...comparison(message),
      ...messageOf(message),
    });
  }

  return failures;
}

/**
 * go test.
 *
 * `--- FAIL: Name (0.00s)` followed by indented `file:line: message` lines.
 */
function parseGo(output: string): Failure[] {
  const lines = output.split('\n');
  const failures: Failure[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const match = /^\s*--- FAIL:\s+(\S+)/.exec(lines[i]!);
    if (!match) continue;

    // The detail sits on the following indented lines, before the next verdict.
    let detail: RegExpExecArray | null = null;
    for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]!); j += 1) {
      detail = /^\s+(\S+\.go):(\d+):\s*(.*)$/.exec(lines[j]!);
      if (detail) break;
    }

    const message = detail?.[3]?.trim();
    failures.push({
      test: match[1]!,
      ...(detail ? { file: detail[1]!, line: Number(detail[2]) } : {}),
      ...comparison(message),
      ...messageOf(message),
    });
  }

  return failures;
}

/** Pulls `expected:`/`actual:` style fields out of a block. */
function field(block: string, pattern: RegExp, as: 'expected' | 'actual' = 'expected') {
  const value = pattern.exec(block)?.[1]?.trim();
  return value ? { [as]: value } : {};
}

/**
 * Recovers the two sides of a comparison from an assertion message.
 *
 * Both `assert -24000 == 750` and `f(x) = -24000, want 750` put the observed
 * value first, which is the convention their runners share.
 */
function comparison(message?: string): { expected?: string; actual?: string } {
  if (!message) return {};

  const equality = /(?:^|\s)(?:assert\s+)?(.+?)\s*==\s*(.+?)\s*$/.exec(message);
  if (equality) return { actual: equality[1]!.trim(), expected: equality[2]!.trim() };

  const want = /=\s*(.+?),\s*want\s+(.+?)\s*$/.exec(message);
  if (want) return { actual: want[1]!.trim(), expected: want[2]!.trim() };

  return {};
}

function messageOf(message?: string): { message?: string } {
  const trimmed = message?.trim();
  return trimmed ? { message: trimmed.slice(0, 200) } : {};
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface Delta {
  /** Failures that were not there before this attempt. */
  readonly fresh: Failure[];
  /** How many failures carried over unchanged. */
  readonly unchanged: number;
}

/** What changed between two runs. */
export function delta(before: readonly Failure[], after: readonly Failure[]): Delta {
  const known = new Set(before.map(identity));
  const fresh = after.filter((f) => !known.has(identity(f)));
  return { fresh, unchanged: after.length - fresh.length };
}

function identity(failure: Failure): string {
  return `${failure.test}|${failure.file ?? ''}`;
}

/**
 * The failures, as a table for a prompt.
 *
 * TOON pays for the field names once in a header rather than once per row,
 * which is the whole reason this is a table and not a list of objects.
 *
 * Every current failure is listed, including ones that were already failing.
 * Sending only the delta would be right if the reader shared the earlier state,
 * but each stage runs in a fresh session and has never seen the previous
 * attempt — told "three unchanged failures", it would have no idea which three.
 * So the delta is expressed as a column rather than as an omission: the saving
 * comes from turning a log into a table, and `since_last_attempt` tells the
 * model which failures its own last change is responsible for.
 *
 * Returns an empty string when there is nothing to say, so the caller can fall
 * back to the raw output.
 */
export function toPrompt(
  failures: readonly Failure[],
  previous: readonly Failure[] = [],
): string {
  // Switched off, callers fall back to the raw log — the behaviour this
  // replaced, and the baseline its saving is measured against.
  if (!features.get().deltaRetries) return '';
  if (failures.length === 0) return '';

  const shown = failures.slice(0, MAX_IN_PROMPT);
  const known = new Set(previous.map(identity));
  // Only worth a column once there is a previous attempt to compare against.
  const comparing = previous.length > 0;

  // Uniform keys keep the encoding tabular; a missing value is an empty cell
  // rather than an absent column.
  const rows = shown.map((f) => ({
    test: f.test,
    file: f.file ?? '',
    line: f.line ?? '',
    expected: f.expected ?? '',
    actual: f.actual ?? '',
    message: f.message ?? '',
    ...(comparing ? { since_last_attempt: known.has(identity(f)) ? 'unchanged' : 'new' } : {}),
  }));

  const notes: string[] = [];
  if (failures.length > shown.length) {
    // Never let a cap pass silently: a truncated list reads as a complete one.
    notes.push(`(${failures.length - shown.length} further failures not listed)`);
  }

  return [encode({ failures: rows }), ...notes].join('\n');
}
