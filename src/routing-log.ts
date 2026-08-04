/**
 * What the harness decided each turn was, and who decided it.
 *
 * Routing is the one decision the harness makes before spending anything, and
 * until now it was the only one it kept no record of. That mattered: a turn
 * routed to `chat` — a read-only mode — in answer to a request to change a file
 * produces an apology, a bill, and no evidence. Twelve of fourteen turns in one
 * repository went that way before anyone noticed, because nothing was counting.
 *
 * Two things are recorded per turn: the decision, and its provenance. Provenance
 * is the part that makes the file worth keeping — a mode the rules matched is a
 * fact, a mode a classifier guessed is an opinion, and a mode the operator
 * corrected is ground truth. A later classifier trained on this file has to
 * weigh those differently, and cannot if they all look alike.
 *
 * This is a log, not a learner. Nothing here changes how a turn is routed.
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Mode } from './intent.ts';

/**
 * Who decided the mode.
 *
 * Ordered by how much a decision is worth as evidence: `you` is ground truth,
 * `rules` is deterministic and reproducible, `classifier` is a paid guess, and
 * `default` is what happens when nothing worked.
 */
export type DecidedBy = 'you' | 'rules' | 'local' | 'classifier' | 'default';

export interface RoutingRecord {
  readonly ts: string;
  /** What the operator typed, verbatim. */
  readonly text: string;
  readonly mode: Mode;
  /** The human-facing reason, as shown on the mode line. */
  readonly why: string;
  readonly by: DecidedBy;
  /**
   * The mode this replaced.
   *
   * Present only when the same request was re-run under a different mode, which
   * is the operator saying the first answer was wrong. These are the rows worth
   * the most and the rarest to come by, so they are marked rather than inferred.
   */
  readonly was?: Mode;
}

export interface RoutingEntry {
  readonly text: string;
  readonly mode: Mode;
  readonly why: string;
  readonly by: DecidedBy;
}

/**
 * The last few turns, for spotting a correction.
 *
 * Held in memory rather than read back from the file, which would mean re-reading
 * a growing log every turn to learn one line.
 *
 * A few rather than one: re-running a misrouted request tends to follow reading
 * the wrong answer, and sometimes a clarifying turn in between. Looking back one
 * turn missed those. Looking back further would start pairing requests that
 * merely repeat rather than correct.
 */
const RECALL = 5;
const recent: { text: string; mode: Mode }[] = [];

/** Same request, ignoring the punctuation and case a retype would change. */
function sameRequest(a: string, b: string): boolean {
  const normalise = (text: string) => text.trim().toLowerCase().replace(/\s+/g, ' ');
  return normalise(a) === normalise(b);
}

export function path(root: string): string {
  return join(root, '.sumo', 'routing.jsonl');
}

/**
 * Appends one turn.
 *
 * Append-only, one JSON object per line, so the file can be read by anything,
 * grown indefinitely, and inspected before it is ever trained on. Failing to
 * write a line must never cost the turn it was describing.
 */
export function record(root: string, entry: RoutingEntry): void {
  // The most recent turn that asked the same thing and got a different answer.
  const corrected = [...recent]
    .reverse()
    .find((turn) => turn.mode !== entry.mode && sameRequest(turn.text, entry.text));
  const was = corrected?.mode;

  const line: RoutingRecord = {
    ts: new Date().toISOString(),
    text: entry.text,
    mode: entry.mode,
    why: entry.why,
    by: entry.by,
    ...(was ? { was } : {}),
  };

  recent.push({ text: entry.text, mode: entry.mode });
  if (recent.length > RECALL) recent.shift();

  try {
    mkdirSync(dirname(path(root)), { recursive: true });
    appendFileSync(path(root), `${JSON.stringify(line)}\n`, 'utf8');
  } catch {
    // Losing a log line must never lose the turn it describes.
  }
}

/** Forgets the recent turns. For tests, and for a fresh session. */
export function reset(): void {
  recent.length = 0;
}

/** Every turn recorded for this repo. Unreadable or absent means none. */
export function read(root: string): RoutingRecord[] {
  try {
    return readFileSync(path(root), 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as RoutingRecord];
        } catch {
          // One corrupt line — from a crash mid-append — is not worth losing
          // every other line over.
          return [];
        }
      });
  } catch {
    return [];
  }
}

export interface RoutingSummary {
  readonly turns: number;
  /** How many turns each decider accounted for. */
  readonly by: Readonly<Record<DecidedBy, number>>;
  readonly modes: Readonly<Partial<Record<Mode, number>>>;
  /** Corrections, most frequent first, as "chat→do". */
  readonly corrections: readonly { readonly change: string; readonly count: number }[];
}

/**
 * What the log adds up to.
 *
 * The corrections line is the one that earns this: it names the routes the
 * harness gets wrong, in the operator's own words, which is the thing no amount
 * of reading the rules would have told anyone.
 */
export function summarize(records: readonly RoutingRecord[]): RoutingSummary {
  const by: Record<DecidedBy, number> = { you: 0, rules: 0, local: 0, classifier: 0, default: 0 };
  const modes: Partial<Record<Mode, number>> = {};
  const changes = new Map<string, number>();

  for (const row of records) {
    if (row.by in by) by[row.by] += 1;
    modes[row.mode] = (modes[row.mode] ?? 0) + 1;
    if (row.was) {
      const change = `${row.was}→${row.mode}`;
      changes.set(change, (changes.get(change) ?? 0) + 1);
    }
  }

  return {
    turns: records.length,
    by,
    modes,
    corrections: [...changes]
      .map(([change, count]) => ({ change, count }))
      .sort((a, b) => b.count - a.count),
  };
}
