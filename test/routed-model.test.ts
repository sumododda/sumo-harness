/**
 * That the routed model is the one that actually runs.
 *
 * Routing can pick a model, hand it to nobody, and look entirely correct from
 * the outside — the stage still succeeds, on the engine's default. These pin
 * the wiring rather than the decision: what was chosen is what was asked for,
 * and what was asked for is what the cache remembers.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { clearUnusable } from '../src/engine/availability.ts';
import { Fleet } from '../src/engine/fleet.ts';
import { Ledger } from '../src/ledger.ts';
import { runStage } from '../src/stage.ts';
import type { Engine, StageRequest } from '../src/engine/types.ts';
import type { StageResult, Tier } from '../src/types.ts';

/** Records what it was asked to run, and answers with it. */
function recording(name: string, seen: { model?: string }): Engine {
  return {
    name,
    costUnit: 'usd',
    supportsOutputSchema: true,
    modelFor: (tier: Tier) => `${name}-default-${tier}`,
    supportsEffort: () => true,
    runStage(req: StageRequest): Promise<StageResult> {
      seen.model = req.model;
      return Promise.resolve({
        stage: req.stage,
        output: 'done',
        cost: 0,
        costUnit: 'usd',
        turns: 1,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        rung: req.rung,
        model: req.model ?? this.modelFor(req.rung.tier),
        provider: name,
        denials: [],
      });
    },
  };
}

function spec(dir: string) {
  return {
    name: 'probe',
    prompt: 'what does applyTax do?',
    rung: { tier: 'mid' as const },
    capabilities: ['read'] as const,
    cwd: dir,
  };
}

test('a catalogued provider runs the model routing picked, not its own default', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sumo-routed-'));
  try {
    clearUnusable();
    const seen: { model?: string } = {};
    const fleet = new Fleet([recording('anthropic', seen)], {}, dir);

    await runStage(fleet, spec(dir), new Ledger());

    // The mid tier's undominated Anthropic model, from the committed catalogue.
    assert.equal(seen.model, 'claude-sonnet-5');
    assert.ok(!(seen.model ?? '').includes('default'), 'the engine default must not have been used');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a provider the catalogue does not describe keeps deciding for itself', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sumo-routed-'));
  try {
    clearUnusable();
    const seen: { model?: string } = {};
    const fleet = new Fleet([recording('some-local-runner', seen)], {}, dir);

    await runStage(fleet, spec(dir), new Ledger());

    assert.equal(seen.model, undefined, 'nothing to pin, so nothing is pinned');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the stage records which provider ran it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sumo-routed-'));
  try {
    clearUnusable();
    const ledger = new Ledger();
    const fleet = new Fleet([recording('anthropic', {})], {}, dir);

    const result = await runStage(fleet, spec(dir), ledger);

    assert.equal(result.provider, 'anthropic');
    assert.equal(result.model, 'claude-sonnet-5');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
