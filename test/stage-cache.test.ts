/**
 * Cache behaviour through the real stage runner, with a stub provider that
 * counts how often it was actually asked.
 *
 * The interesting assertions are the refusals. A writable stage's product is a
 * change on disk, and a git-capable stage can move the tree — replaying either
 * one's text would report work that never happened.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import * as features from '../src/features.ts';
import type { Engine, StageRequest } from '../src/engine/types.ts';
import { invalidate } from '../src/hash.ts';
import { Fleet } from '../src/engine/fleet.ts';
import { Ledger } from '../src/ledger.ts';
import { run } from '../src/runner.ts';
import { runStage, type StageSpec } from '../src/stage.ts';
import type { StageResult, Tier } from '../src/types.ts';

/** Counts calls, so a cache hit is observable rather than inferred from cost. */
class CountingEngine implements Engine {
  readonly name = 'stub';
  readonly costUnit = 'usd' as const;
  readonly supportsOutputSchema = true;
  calls = 0;

  modelFor(tier: Tier): string {
    return `stub-${tier}`;
  }

  supportsEffort(tier: Tier): boolean {
    return tier !== 'small';
  }

  async runStage(req: StageRequest): Promise<StageResult> {
    this.calls += 1;
    return {
      stage: req.stage,
      output: `answer ${this.calls}`,
      cost: 0.02,
      costUnit: 'usd',
      provider: 'stub',
      turns: 1,
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 0,
      rung: req.rung,
      model: this.modelFor(req.rung.tier),
      denials: [],
    };
  }
}

async function repo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'sumo-stagecache-'));
  writeFileSync(join(dir, 'cart.js'), 'export const rate = 0.1;\n', 'utf8');
  await run('git init -q .', dir);
  await run('git add -A', dir);
  await run('git -c user.email=t@example.com -c user.name=Test commit -q -m first', dir);
  invalidate(dir);
  return dir;
}

function spec(cwd: string, overrides: Partial<StageSpec> = {}): StageSpec {
  return {
    name: 'chat',
    prompt: 'what does applyTax do?',
    rung: { tier: 'small' },
    capabilities: ['read', 'search'],
    cwd,
    ...overrides,
  };
}

afterEach(() => {
  features.set({ cache: true });
});

test('an identical read-only stage is replayed without calling the provider', async () => {
  const dir = await repo();
  const engine = new CountingEngine();
  try {
    const first = await runStage(Fleet.of(engine), spec(dir), new Ledger());
    const second = await runStage(Fleet.of(engine), spec(dir), new Ledger());

    assert.equal(engine.calls, 1, 'the second run must not reach the provider');
    assert.equal(second.output, first.output);
    assert.equal(second.cached, true);
    assert.equal(second.cost, 0, 'a replay costs nothing');
    assert.equal(second.saved, 0.02, 'and records what it saved');
    assert.equal(first.cached, undefined, 'the first run was not a replay');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('changing the repository invalidates the answer', async () => {
  const dir = await repo();
  const engine = new CountingEngine();
  try {
    await runStage(Fleet.of(engine), spec(dir), new Ledger());

    writeFileSync(join(dir, 'cart.js'), 'export const rate = 0.25;\n', 'utf8');
    invalidate(dir);

    const after = await runStage(Fleet.of(engine), spec(dir), new Ledger());
    assert.equal(engine.calls, 2, 'the code changed, so the answer must be recomputed');
    assert.equal(after.cached, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a different prompt is a different question', async () => {
  const dir = await repo();
  const engine = new CountingEngine();
  try {
    await runStage(Fleet.of(engine), spec(dir), new Ledger());
    await runStage(Fleet.of(engine), spec(dir, { prompt: 'what does applyDiscount do?' }), new Ledger());
    assert.equal(engine.calls, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a writable stage is never replayed', async () => {
  const dir = await repo();
  const engine = new CountingEngine();
  try {
    const writable = spec(dir, { name: 'fix', capabilities: ['read', 'edit'], allowWrites: true });

    const first = await runStage(Fleet.of(engine), writable, new Ledger());
    const second = await runStage(Fleet.of(engine), writable, new Ledger());

    // Replaying "edited cart.js" without editing cart.js would be a silent lie.
    assert.equal(engine.calls, 2, 'edits must actually happen every time');
    assert.equal(second.cached, undefined);
    assert.notEqual(second.output, first.output);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a git-capable stage is never replayed', async () => {
  const dir = await repo();
  const engine = new CountingEngine();
  try {
    // checkout, switch and stash all move the working tree, so a read-only tool
    // set is not the same as having no effect.
    const gitty = spec(dir, { capabilities: ['read', 'git'] });

    await runStage(Fleet.of(engine), gitty, new Ledger());
    await runStage(Fleet.of(engine), gitty, new Ledger());
    assert.equal(engine.calls, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a truncated stage is not stored', async () => {
  const dir = await repo();

  class BudgetCappedEngine extends CountingEngine {
    override async runStage(req: StageRequest): Promise<StageResult> {
      const result = await super.runStage(req);
      return { ...result, stopped: 'budget' };
    }
  }

  const engine = new BudgetCappedEngine();
  try {
    await runStage(Fleet.of(engine), spec(dir), new Ledger());
    await runStage(Fleet.of(engine), spec(dir), new Ledger());

    // Otherwise the answer would be pinned forever at whatever length the budget
    // happened to allow on the unluckiest run.
    assert.equal(engine.calls, 2, 'an incomplete answer must not become the cached one');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('outside a git repo nothing is reused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sumo-nogit-stage-'));
  const engine = new CountingEngine();
  try {
    invalidate(dir);
    await runStage(Fleet.of(engine), spec(dir), new Ledger());
    await runStage(Fleet.of(engine), spec(dir), new Ledger());

    // With no fingerprint there is no way to know the code is unchanged.
    assert.equal(engine.calls, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the edit-format preference applies on the first attempt and not after', async () => {
  const dir = await repo();

  /** Captures the gate the stage runner built, so its rules can be exercised. */
  class GateCapturingEngine extends CountingEngine {
    gate: StageRequest['gate'];

    override async runStage(req: StageRequest): Promise<StageResult> {
      this.gate = req.gate;
      return await super.runStage(req);
    }
  }

  const engine = new GateCapturingEngine();
  try {
    const writable = spec(dir, {
      name: 'fix',
      capabilities: ['read', 'edit'],
      allowWrites: true,
      preferTargetedEdits: true,
    });

    await runStage(Fleet.of(engine), { ...writable, attempt: 0 }, new Ledger());
    assert.ok(
      engine.gate?.('Write', { file_path: join(dir, 'cart.js') }),
      'the first attempt should ask for a targeted edit',
    );

    await runStage(Fleet.of(engine), { ...writable, attempt: 1 }, new Ledger());
    assert.equal(
      engine.gate?.('Write', { file_path: join(dir, 'cart.js') }),
      null,
      'after a failed attempt, the format stops being the thing to economise on',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a replayed stage still reaches the event sink', async () => {
  const dir = await repo();
  const engine = new CountingEngine();
  try {
    const seen: string[] = [];
    const sink = (event: { kind: string; text?: string }) => {
      if (event.kind === 'text' && event.text) seen.push(event.text);
    };

    await runStage(Fleet.of(engine), spec(dir, { onEvent: sink }), new Ledger());
    await runStage(Fleet.of(engine), spec(dir, { onEvent: sink }), new Ledger());

    // Without this a cache hit would render as the harness having hung.
    assert.deepEqual(seen, ['answer 1'], 'the stub streams nothing, so this is the replay');
    assert.equal(engine.calls, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
