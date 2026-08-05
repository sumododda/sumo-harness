/**
 * The shapes stages must answer in, and how those answers are rendered.
 *
 * Asking for prose and then reading it back with a regex is the failure mode
 * this replaces: the harness was recovering a shell command from a markdown
 * heading, which works until a model writes the heading slightly differently.
 * A schema moves that risk to the provider, which validates before returning.
 *
 * One definition per stage serves both purposes — the JSON Schema on the wire
 * and the runtime parse — so the two can never drift apart.
 */

import { encode } from '@toon-format/toon';
import { z } from 'zod';

/** What a read-only investigation found. Its `repro` replaces a prose regex. */
export const Evidence = z.object({
  observations: z
    .array(
      z.object({
        file: z.string(),
        line: z.number().int(),
        what: z.string().describe('what the code actually does at this line'),
      }),
    )
    .describe('what was actually observed along the failing path'),
  suspects: z.array(z.string()).describe('symbols most likely involved'),
  repro: z
    .string()
    .nullable()
    .describe('one shell command that demonstrates the problem, or null'),
  reproTest: z
    .object({ file: z.string(), content: z.string() })
    .nullable()
    .describe(
      'a new-or-existing test file whose content demonstrates the bug and is ' +
        'expected to fail right now, or null when nothing test-shaped fits ' +
        '(e.g. a UI or manual-only bug). The harness writes and runs it, never you.',
    ),
  hypotheses: z.array(z.string()).describe('at most three, each tied to an observation'),
});
export type Evidence = z.infer<typeof Evidence>;

/** The single most likely cause, with the change it implies. */
export const RootCause = z.object({
  cause: z.string().describe('two sentences, citing the evidence'),
  evidenceRefs: z.array(z.string()).describe('the observations or repro lines each claim rests on'),
  fix: z.array(z.object({ file: z.string(), change: z.string() })).describe('the minimal change'),
  verification: z.string().describe('how we will know it worked'),
});
export type RootCause = z.infer<typeof RootCause>;

/**
 * A cheap second opinion on a failed rung-attempt: worth another try at the
 * same approach, or a sign the approach or model can't do this. No free-text
 * reasoning field — the whole point of asking is that it costs almost nothing.
 */
export const EscalationVerdict = z.object({
  verdict: z
    .enum(['nearMiss', 'capabilityFailure'])
    .describe(
      'nearMiss: the same approach could likely fix this with another try. ' +
        'capabilityFailure: the current approach or model looks insufficient.',
    ),
});
export type EscalationVerdict = z.infer<typeof EscalationVerdict>;

/** A repro command, rewritten at the gate from the operator's correction. */
export const ReproCommand = z.object({
  command: z.string().describe('the shell command to run, and nothing else'),
});
export type ReproCommand = z.infer<typeof ReproCommand>;

/** What already exists that a new feature should build on. */
export const Explore = z.object({
  files: z.array(z.string()).describe('the files this task touches'),
  reuse: z
    .array(z.object({ symbol: z.string(), file: z.string(), why: z.string() }))
    .describe('existing functions to call instead of reimplementing'),
  conventions: z.object({
    example: z.string().describe('a test file that shows how tests are written here'),
    note: z.string(),
  }),
  constraints: z.array(z.string()),
});
export type Explore = z.infer<typeof Explore>;

/** A minimal plan, and the tests that will prove it. */
export const Plan = z.object({
  approach: z.string().describe('two sentences'),
  steps: z.array(
    z.object({
      file: z.string(),
      action: z.enum(['edit', 'create']),
      detail: z.string(),
    }),
  ),
  tests: z
    .array(
      z.object({
        file: z.string(),
        case: z.string(),
        whyFailsToday: z.string(),
      }),
    )
    .describe('each test to write and why it fails before the change'),
  risks: z.array(z.string()),
});
export type Plan = z.infer<typeof Plan>;

/**
 * The JSON Schema a provider should enforce.
 *
 * `$schema` is dropped: it describes the dialect rather than the data, and
 * providers that validate the envelope strictly reject unknown top-level keys.
 */
export function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _dialect, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

/**
 * Reads a stage's answer, or null when it is not the shape asked for.
 *
 * Null is a real outcome, not an exception: providers can end a stage early for
 * budget or turn limits, and a partial answer should degrade to being shown as
 * prose rather than taking the task down.
 */
/**
 * Strips a section tag the model closed but never opened.
 *
 * A root cause came back with `</verification>` on the end of its verification
 * field, and it was drawn verbatim inside the box the operator was asked to
 * approve. The model had reached for a tag to close a section that the schema
 * had already delimited for it — the field *is* the section.
 *
 * Unmatched is the whole test, and it has to be, because these values are not
 * all prose. `Evidence.reproTest.content` is a file that gets written to disk:
 * an HTML fixture ending in `</html>` must survive untouched, and it does,
 * because it opened that tag. Only a closing tag with no opening — or an
 * opening tag with no close — is something the schema did not ask for.
 *
 * A value with nothing to strip is returned identically, so a file that merely
 * ends in a newline is not quietly reformatted on its way to disk.
 */
function clean(value: string): string {
  const trailing = /\s*<\/([a-z_][\w-]*)>\s*$/i.exec(value);
  if (trailing) {
    const name = trailing[1] ?? '';
    const opened = new RegExp(`<${name}(?:\\s[^>]*)?>`, 'i').test(value);
    if (!opened) return clean(value.slice(0, trailing.index));
  }

  const leading = /^\s*<([a-z_][\w-]*)(?:\s[^>]*)?>\s*/i.exec(value);
  if (leading) {
    const name = leading[1] ?? '';
    const closed = new RegExp(`</${name}>`, 'i').test(value);
    if (!closed) return clean(value.slice(leading[0].length));
  }

  return value;
}

/**
 * Strips stray wrapper tags from every string in a validated answer.
 *
 * Applied here rather than in a renderer because the same value goes to two
 * places — the screen and the next stage's prompt — and cleaning it in one
 * leaves the other paying tokens for markup nobody asked for and reading a
 * field that ends in a tag as though that meant something.
 */
function cleanStrings<T>(value: T): T {
  if (typeof value === 'string') return clean(value) as T;
  if (Array.isArray(value)) return value.map(cleanStrings) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, cleanStrings(v)]),
    ) as T;
  }
  return value;
}

export function parse<T>(schema: z.ZodType<T>, output: string): T | null {
  try {
    const parsed = schema.safeParse(JSON.parse(output));
    return parsed.success ? cleanStrings(parsed.data) : null;
  } catch {
    return null;
  }
}

/**
 * Renders an answer for a human and for the next stage.
 *
 * Markdown for the scalars and TOON for the tables. The tables are exactly the
 * uniform rows TOON was adopted for — field names paid once in a header rather
 * than once per row — and this is the first place in the harness where that
 * actually reaches a prompt.
 */
export function renderEvidence(e: Evidence): string {
  return section([
    ['Observations', e.observations.length > 0 ? encode({ observations: e.observations }) : 'none'],
    ['Suspects', list(e.suspects)],
    ['Repro', e.repro ?? 'none'],
    ['Repro test', e.reproTest ? `${e.reproTest.file}\n${e.reproTest.content}` : 'none'],
    ['Hypotheses', list(e.hypotheses)],
  ]);
}

/**
 * The shortest a real cause can be.
 *
 * The schema asks for "two sentences, citing the evidence". Nothing that short
 * is two sentences, and the number only has to separate a diagnosis from a
 * placeholder — a bar set where no genuine answer has ever landed.
 */
const MIN_CAUSE = 40;

/**
 * Why this root cause cannot be put to an operator, or null when it can.
 *
 * Two different failures, and only one of them is the model misbehaving.
 *
 * An empty `fix` is a *correct* answer: `ROOT_CAUSE_STAGE` explicitly tells the
 * stage to leave it empty rather than guess when the evidence does not support
 * a conclusion. What was wrong was gating on it anyway — "Approve this root
 * cause and fix?" over a proposal containing no fix, where approving ran the
 * writing stage with nothing to write. Saying so and stopping is the path the
 * prompt already promised.
 *
 * A one-word cause is the other thing. After a revision, one real diagnosis
 * came back as `cause: "Test"` with evidence `["a", "b"]` — schema-valid,
 * rendered into a perfectly ordinary box, and offered for approval. The gate's
 * only emptiness check is on the rendered string, which was not empty. The
 * `declaresNoTests` guard next door exists because a schema slot can be filled
 * without being answered; this is the same lesson on a different field.
 */
export function unusableRootCause(r: RootCause): string | null {
  if (r.cause.trim().length < MIN_CAUSE) {
    return 'the root-cause stage answered with a placeholder rather than a diagnosis — nothing to approve, so nothing was changed';
  }
  if (r.fix.length === 0) {
    return 'the evidence did not support a fix, so none was proposed — nothing was changed. Narrow the report, or add a failing test that shows the bug';
  }
  return null;
}

export function renderRootCause(r: RootCause): string {
  return section([
    ['Cause', r.cause],
    ['Evidence', list(r.evidenceRefs)],
    ['Fix', r.fix.length > 0 ? encode({ fix: r.fix }) : 'none'],
    ['Verification', r.verification],
  ]);
}

export function renderExplore(e: Explore): string {
  return section([
    ['Files', list(e.files)],
    ['Reuse', e.reuse.length > 0 ? encode({ reuse: e.reuse }) : 'nothing existing applies'],
    ['Conventions', `${e.conventions.note}\nExample: ${e.conventions.example}`],
    ['Constraints', list(e.constraints)],
  ]);
}

/**
 * Whether a plan's test list is really a statement that there are none.
 *
 * A prompt asks; it does not guarantee. Told to return an empty list for work
 * that needs no tests, a model may still fill the slot with a placeholder — one
 * real plan came back with a single test whose case read "N/A —
 * documentation-only change" and whose reason explained that no test harness
 * applies. Counted literally that is one test, so the workflow demanded a test
 * file, none was written, and the task was stopped after $0.43 with the
 * documentation it had agreed to write still unwritten.
 *
 * Reading the placeholder for what it says costs nothing and turns that into
 * the path the plan actually described. Deliberately narrow — the declaration
 * has to *be* the whole case, not merely open it, or "none of the ids collide
 * across a thousand notes" would be read as a plan with no tests in it.
 */
const NO_TESTS =
  /^\s*(n\/?a|none|no tests?(\s+(needed|required|apply|applicable))?|not applicable)\s*(?:$|[—–:(,.-]\s*)/i;

export function declaresNoTests(p: Plan): boolean {
  return p.tests.length > 0 && p.tests.every((t) => NO_TESTS.test(t.case));
}

export function renderPlan(p: Plan): string {
  return section([
    ['Approach', p.approach],
    ['Steps', p.steps.length > 0 ? encode({ steps: p.steps }) : 'none'],
    ['Tests', p.tests.length > 0 ? encode({ tests: p.tests }) : 'none'],
    ['Risks', list(p.risks)],
  ]);
}

function section(parts: readonly (readonly [string, string])[]): string {
  return parts
    .filter(([, body]) => body.trim().length > 0)
    .map(([heading, body]) => `${heading}:\n${indent(body)}`)
    .join('\n\n');
}

function list(items: readonly string[]): string {
  return items.length > 0 ? items.map((i) => `- ${i}`).join('\n') : 'none';
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => (line.length > 0 ? `  ${line}` : line))
    .join('\n');
}
