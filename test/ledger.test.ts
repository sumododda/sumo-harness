import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Ledger, stageRows } from '../src/ledger.ts';
import type { StageResult } from '../src/types.ts';

function stage(overrides: Partial<StageResult> = {}): StageResult {
  return {
    stage: 'evidence',
    output: 'ok',
    cost: 0.0041,
    costUnit: 'usd',
    provider: 'stub',
    turns: 3,
    inputTokens: 4120,
    outputTokens: 380,
    cacheReadTokens: 2100,
    rung: { tier: 'small' },
    model: 'claude-haiku-4-5',
    denials: [],
    ...overrides,
  };
}

test('totals every stage', () => {
  const ledger = new Ledger();
  ledger.add(stage({ cost: 0.01 }));
  ledger.add(stage({ stage: 'fix', cost: 0.02 }));

  assert.equal(Number(ledger.total[0]!.amount.toFixed(4)), 0.03);
  assert.equal(ledger.entries.length, 2);
});

test('TOON encoding stays tabular and compact', () => {
  const ledger = new Ledger();
  ledger.add(stage());
  ledger.add(stage({ stage: 'fix', rung: { tier: 'mid', effort: 'high' } }));

  const toon = ledger.toToon();

  // One header row naming the fields, then one line per stage.
  assert.match(toon, /stages\[2\]\{stage,model,effort,/);
  assert.match(toon, /evidence,claude-haiku-4-5,off,/);
  assert.match(toon, /fix,claude-haiku-4-5,high,/);

  // Both sides must encode the SAME rows. Weighing TOON against a JSON dump of
  // the full stage results would compare payloads rather than encodings, and
  // credit TOON for fields the artifact never carried.
  const asJson = JSON.stringify({ stages: stageRows(ledger.entries) });
  assert.ok(
    toon.length < asJson.length,
    `TOON should beat minified JSON, got ${toon.length} vs ${asJson.length}`,
  );
});

test("TOON's advantage grows with the number of rows", () => {
  // The field names are paid for once in a header rather than once per row, so
  // the saving is a function of row count. Worth pinning: it is the reason the
  // format is worth having for failure tables and not worth having for a single
  // object.
  const ratio = (rowCount: number) => {
    const ledger = new Ledger();
    for (let i = 0; i < rowCount; i += 1) ledger.add(stage({ stage: `s${i}` }));
    return ledger.toToon().length / JSON.stringify({ stages: stageRows(ledger.entries) }).length;
  };

  const [two, eight] = [ratio(2), ratio(8)];
  assert.ok(two < 1, `even two rows should beat JSON, got ${two.toFixed(3)}`);
  assert.ok(eight < two, `more rows should widen the gap: ${eight.toFixed(3)} vs ${two.toFixed(3)}`);
  assert.ok(eight < 0.5, `at eight rows the saving should be substantial, got ${eight.toFixed(3)}`);
});

test('renders a table with a total, and survives being empty', () => {
  assert.match(new Ledger().render(), /No stages ran/);

  const ledger = new Ledger();
  ledger.add(stage({ cost: 0.0123 }));
  const rendered = ledger.render();

  assert.match(rendered, /stage/);
  assert.match(rendered, /evidence/);
  assert.match(rendered, /\$0\.0123/);
  assert.match(rendered, /total/);
});

test('a replayed stage reads as reused, not as free', () => {
  const ledger = new Ledger();
  ledger.add(stage({ cost: 0, cached: true, saved: 0.0233 }));
  const rendered = ledger.render();

  // In the row itself, "$0.0000" would suggest a stage that ran and happened to
  // cost nothing, rather than one that never ran at all.
  const row = rendered.split('\n').find((l) => l.includes('evidence'))!;
  assert.match(row, /reused$/);
  assert.doesNotMatch(row, /\$/);
  assert.match(rendered, /\$0\.0233 reused/, 'and the footer says what that was worth');
});

test('the total line names how many provider cache-read tokens the task used', () => {
  const ledger = new Ledger();
  ledger.add(stage({ cacheReadTokens: 1500 }));
  ledger.add(stage({ stage: 'fix', cacheReadTokens: 900 }));

  const totalLine = ledger.render().split('\n').at(-1)!;
  // Distinct label from "reused" above it: that is this project's own
  // exact-result cache, this is the provider's — conflating the two in one
  // number would misreport which mechanism earned the saving.
  assert.match(totalLine, /2400 pcache/);
});

test('the total line omits cache reads when there were none', () => {
  const ledger = new Ledger();
  ledger.add(stage({ cacheReadTokens: 0 }));

  const totalLine = ledger.render().split('\n').at(-1)!;
  assert.doesNotMatch(totalLine, /pcache/);
});

test('summarize counts retries, escalations, and what was saved', () => {
  const ledger = new Ledger();
  ledger.add(stage({ cost: 0.01, attempt: 0 }));
  ledger.add(stage({ cost: 0.02, attempt: 1 }));
  ledger.add(stage({ cost: 0, cached: true, saved: 0.03 }));
  ledger.noteEscalation();

  const summary = ledger.summarize();
  assert.equal(summary.stages, 3);
  assert.equal(summary.retries, 1, 'only attempt > 0 is a retry');
  assert.equal(summary.escalations, 1);
  assert.equal(Number(summary.total[0]!.amount.toFixed(4)), 0.03);
  assert.equal(summary.saved[0]!.amount, 0.03);
});

test('a mark scopes the summary to one task', () => {
  const ledger = new Ledger();
  ledger.add(stage({ cost: 0.05 }));

  // The REPL keeps one ledger for the whole session, so "this task" has to be
  // a range rather than a fresh instance.
  const mark = ledger.mark();
  ledger.add(stage({ cost: 0.01 }));
  ledger.add(stage({ cost: 0.02 }));

  assert.equal(ledger.summarize(mark).stages, 2);
  assert.equal(Number(ledger.summarize(mark).total[0]!.amount.toFixed(4)), 0.03);
  assert.equal(Number(ledger.total[0]!.amount.toFixed(4)), 0.08, 'the session total still counts everything');
});

test('finish appends one metrics line per task', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sumo-metrics-'));
  try {
    const ledger = new Ledger();
    ledger.add(stage({ cost: 0.01, inputTokens: 4000, composition: { system: 90, prompt: 900, pack: 700 } }));
    ledger.finish(dir, 0, { mode: 'fix', task: 'cart total is wrong', verified: true });

    ledger.add(stage({ cost: 0.02 }));
    ledger.finish(dir, 1, { mode: 'do', task: 'rename it', verified: false, stopped: 'you stopped it' });

    const lines = readFileSync(join(dir, '.sumo', 'metrics.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);

    assert.equal(lines.length, 2, 'append-only, one line per task');
    assert.equal(lines[0]!['mode'], 'fix');
    assert.equal(lines[0]!['verified'], true);
    assert.equal(lines[0]!['packTokens'], 700, 'the pack share is what judges gated retrieval');
    assert.equal(lines[1]!['stopped'], 'you stopped it');
    assert.equal(lines[1]!['stages'], 1, 'the second line covers only the second task');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a metrics line that cannot be written never breaks the task', () => {
  const ledger = new Ledger();
  ledger.add(stage());
  // A path that cannot be created at all.
  assert.doesNotThrow(() =>
    ledger.finish('/dev/null/nope', 0, { mode: 'do', task: 'x', verified: true }),
  );
});
