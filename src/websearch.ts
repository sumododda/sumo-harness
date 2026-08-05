/**
 * Web search, run by the harness rather than by the model.
 *
 * The same argument as tests and git: searching is deterministic, so paying a
 * model turn to decide to do it — and a second one to read what came back — buys
 * nothing the harness cannot do itself for free. `runner.ts` already makes this
 * case for commands; this is the same case for the one capability that leaves
 * the machine.
 *
 * What it actually fixes is parity. `web` is a promise the harness makes to a
 * stage, and a stage does not know which account it landed on — but the promise
 * was worth different amounts on each: Anthropic grants a real hosted search,
 * while Copilot's `web_search` is behind a runtime feature flag and its
 * `web_fetch` alone can only retrieve a URL the stage already has. A search the
 * harness runs means `web` means one thing everywhere, and a provider added
 * tomorrow inherits it without a line of engine code.
 *
 * It is additive, not a replacement. Whatever hosted tools a provider offers
 * stay granted, so the model can still search again for itself; this only
 * guarantees it never starts from nothing.
 *
 * DuckDuckGo through `ddgr`, which is optional and absent by default. Nothing
 * here installs it — see `sumo setup`. Every failure degrades to `null`, which
 * reads downstream as "no results block", which is exactly how the harness
 * behaved before this file existed.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { encode } from '@toon-format/toon';

/**
 * `execFile`, not `exec` — the query is passed as an argument vector and never
 * reaches a shell, so a quote or `$(…)` in what the operator typed is a search
 * term rather than a command.
 */
const execFileAsync = promisify(execFile);

/** Long enough for a slow network, short enough that a hung search is not a hung task. */
const TIMEOUT_MS = 15_000;

/**
 * How many results ride into the prompt.
 *
 * Five rather than ddgr's default ten. The abstracts are substantial — a couple
 * of hundred characters each — so this is the point where another row costs more
 * than the page it points at is likely to be worth, and the stage can always
 * fetch further.
 */
const MAX_RESULTS = 5;

export interface Result {
  readonly title: string;
  readonly url: string;
  /** DuckDuckGo's own summary. Often enough to answer without fetching. */
  readonly abstract: string;
}

/**
 * Answers for queries already run this session.
 *
 * Not for speed — a search is a second — but for the cache. A stage's key is its
 * prompt, so a results block that changed between two identical questions would
 * make `/research` the one read-only mode that could never be replayed. Held per
 * process rather than on disk, because a week-old answer to "what is the current
 * API" is the failure this mode exists to avoid.
 */
const answered = new Map<string, readonly Result[] | null>();

/** Whether `ddgr` is on PATH. Resolved once; installing it mid-session is not a case worth handling. */
let present: boolean | null = null;

async function installed(): Promise<boolean> {
  if (present !== null) return present;
  try {
    await execFileAsync('ddgr', ['--version'], { timeout: TIMEOUT_MS });
    present = true;
  } catch {
    present = false;
  }
  return present;
}

/**
 * Results for a query, or null when the harness cannot search.
 *
 * Null covers every reason equally — not installed, offline, rate-limited,
 * malformed output — because the caller does the same thing in all of them, and
 * a stage that still has the provider's own web tools is not stuck.
 *
 * The query is passed as an argument vector, never through a shell. It comes
 * from whatever the operator typed, so a stray quote or `$(…)` would otherwise
 * be a broken search at best.
 */
export async function search(query: string, max = MAX_RESULTS): Promise<readonly Result[] | null> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return null;

  const cached = answered.get(trimmed);
  if (cached !== undefined) return cached;

  const found = (await installed()) ? await run(trimmed, max) : null;
  answered.set(trimmed, found);
  return found;
}

async function run(query: string, max: number): Promise<readonly Result[] | null> {
  try {
    const { stdout } = await execFileAsync('ddgr', ['--json', '--np', '-n', String(max), query], {
      timeout: TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
    const parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed)) return null;

    const results = parsed.filter(usable).map(normalize).slice(0, max);
    // An empty array is a genuine answer — the web had nothing — but it renders
    // as a heading over nothing, so it is reported the same way as no searcher.
    return results.length > 0 ? results : null;
  } catch {
    return null;
  }
}

/** A row worth keeping: it has somewhere to go. Everything else is presentation. */
function usable(value: unknown): value is { url: string } {
  const r = value as { url?: unknown } | null;
  return typeof r === 'object' && r !== null && typeof r.url === 'string' && r.url.length > 0;
}

/**
 * Fills in what a row is missing rather than dropping it.
 *
 * `abstract` is absent often enough to matter — ddgr omits it where DuckDuckGo
 * had no summary — and a result with a title and a URL is still worth citing and
 * still worth fetching. Dropping it would silently shrink the result set, which
 * is the failure mode that is hardest to notice from the prompt.
 */
function normalize(value: unknown): Result {
  const r = value as { title?: unknown; url: string; abstract?: unknown };
  return {
    title: typeof r.title === 'string' ? r.title : r.url,
    url: r.url,
    abstract: typeof r.abstract === 'string' ? r.abstract.trim() : '',
  };
}

/**
 * The results as a prompt block.
 *
 * Carries its own instruction rather than relying on a sentence in
 * `RESEARCH_STAGE`, so that a run with no searcher installed says nothing at all
 * instead of pointing at results that are not there. A prompt that references
 * absent context is worse than one that never mentions it — the model goes
 * looking, and the turn is billed either way.
 *
 * TOON-encoded because this is a table headed for a model: the field names are
 * paid once rather than once per row.
 */
export function resultsBlock(results: readonly Result[]): string {
  const rows = results.map((r) => ({ title: r.title, url: r.url, abstract: r.abstract }));

  return `Web search results for this question, gathered by the harness:
${encode({ results: rows })}

These are a starting point, not the answer. Their URLs are the ones to cite.
Fetch a page when its summary is not enough, and search again yourself if this
missed what the question was actually about.

`;
}
