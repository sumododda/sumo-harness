/**
 * Availability: catalogue ∩ what the account can actually reach.
 *
 * All of this is exercised with fake engines, because the logic worth pinning
 * is the merging and the failure handling, not a provider's answer. The rule
 * that matters throughout: being unable to ask must never be read as "no models
 * exist", or an offline run would route at nothing at all.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  type AvailableModel,
  clearUnusable,
  lastProbe,
  markUnusable,
  usable,
  whyUnusable,
} from '../src/engine/availability.ts';
import type { Engine } from '../src/engine/types.ts';

function fake(name: string, models: readonly AvailableModel[] | Error): Engine {
  return {
    name,
    costUnit: 'usd',
    supportsOutputSchema: true,
    modelFor: () => 'stub',
    supportsEffort: () => false,
    runStage: () => {
      throw new Error('not used');
    },
    availableModels: () => (models instanceof Error ? Promise.reject(models) : Promise.resolve(models)),
  };
}

/** An engine that cannot enumerate, like the Claude one. */
function silent(name: string): Engine {
  return {
    name,
    costUnit: 'usd',
    supportsOutputSchema: true,
    modelFor: () => 'stub',
    supportsEffort: () => false,
    runStage: () => {
      throw new Error('not used');
    },
  };
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'sumo-avail-'));
}

test('a provider that cannot be asked means "trust the catalogue", not "nothing"', async () => {
  const dir = scratch();
  try {
    clearUnusable();
    assert.equal(await usable(silent('claude'), dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('only enabled models are usable; disabled and unconfigured are both out', async () => {
  const dir = scratch();
  try {
    clearUnusable();
    const set = await usable(
      fake('copilot', [
        { id: 'gpt-5.6-luna', state: 'enabled' },
        { id: 'claude-opus-5', state: 'disabled' },
        { id: 'gemini-3.6-flash', state: 'unconfigured' },
      ]),
      dir,
    );

    assert.ok(set);
    assert.deepEqual([...set], ['gpt-5.6-luna']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a probe is reused inside its day and re-asked after it', async () => {
  const dir = scratch();
  try {
    clearUnusable();
    let asked = 0;
    const engine: Engine = {
      ...fake('copilot', []),
      availableModels: () => {
        asked += 1;
        return Promise.resolve([{ id: `probe-${String(asked)}`, state: 'enabled' as const }]);
      },
    };

    const t0 = 1_000_000;
    const first = await usable(engine, dir, t0);
    const again = await usable(engine, dir, t0 + 60_000);
    assert.equal(asked, 1, 'a fresh probe must not be re-asked');
    assert.deepEqual([...first!], [...again!]);

    const later = await usable(engine, dir, t0 + 25 * 60 * 60 * 1000);
    assert.equal(asked, 2, 'a probe older than a day must be re-asked');
    assert.deepEqual([...later!], ['probe-2']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a provider that throws falls back to its last answer rather than to nothing', async () => {
  const dir = scratch();
  try {
    clearUnusable();
    const good = fake('copilot', [{ id: 'gpt-5.6-luna', state: 'enabled' }]);
    const t0 = 2_000_000;
    await usable(good, dir, t0);

    // A day later the provider is unreachable — offline, or the CLI is missing.
    const broken = fake('copilot', new Error('offline'));
    const set = await usable(broken, dir, t0 + 25 * 60 * 60 * 1000);

    assert.ok(set, 'a stale answer beats no answer');
    assert.deepEqual([...set], ['gpt-5.6-luna']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a provider that throws with no history at all trusts the catalogue', async () => {
  const dir = scratch();
  try {
    clearUnusable();
    assert.equal(await usable(fake('copilot', new Error('offline')), dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a model that failed this run drops out, whatever the probe said', async () => {
  const dir = scratch();
  try {
    clearUnusable();
    const engine = fake('copilot', [
      { id: 'gpt-5.6-luna', state: 'enabled' },
      { id: 'gpt-5.6-sol', state: 'enabled' },
    ]);

    assert.equal((await usable(engine, dir))!.size, 2);

    // Enabled when asked, out of allowance by the time it was called.
    markUnusable('copilot', 'gpt-5.6-sol');
    assert.deepEqual([...(await usable(engine, dir))!], ['gpt-5.6-luna']);
  } finally {
    clearUnusable();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('why a model is unusable distinguishes policy from entitlement from failure', () => {
  clearUnusable();
  const probe: AvailableModel[] = [
    { id: 'a', state: 'enabled' },
    { id: 'b', state: 'disabled' },
    { id: 'c', state: 'unconfigured' },
  ];

  assert.equal(whyUnusable('copilot', 'a', probe), null);
  assert.equal(whyUnusable('copilot', 'b', probe), 'disabled by policy');
  assert.equal(whyUnusable('copilot', 'c', probe), 'not enabled for this organisation');
  assert.equal(whyUnusable('copilot', 'd', probe), 'not offered to this account');

  markUnusable('copilot', 'a');
  assert.equal(whyUnusable('copilot', 'a', probe), 'failed earlier in this run');
  clearUnusable();
});

test('an un-probed provider blames nothing, because it knows nothing', () => {
  clearUnusable();
  assert.equal(whyUnusable('claude', 'claude-opus-5', null), null);
});

test('the probe is written down, so the next run can report it', async () => {
  const dir = scratch();
  try {
    clearUnusable();
    assert.equal(lastProbe(dir, 'copilot'), null, 'nothing recorded before asking');
    await usable(fake('copilot', [{ id: 'gpt-5.6-luna', state: 'enabled' }]), dir);
    assert.deepEqual(lastProbe(dir, 'copilot'), [{ id: 'gpt-5.6-luna', state: 'enabled' }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
