/**
 * The context layer must never be able to fail a task. A missing index, a
 * broken index, or an absent language server all degrade to reading files —
 * slower and dearer, but still correct.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openContext } from '../src/context/index.ts';
import { NO_CONTEXT } from '../src/context/types.ts';

function scratch(config?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'sumo-ctx-'));
  writeFileSync(join(dir, 'a.ts'), 'export function hello() { return 1; }\n', 'utf8');
  if (config !== undefined) {
    mkdirSync(join(dir, '.sumo'), { recursive: true });
    writeFileSync(join(dir, '.sumo', 'config.json'), JSON.stringify(config), 'utf8');
  }
  return dir;
}

test('the empty context answers safely instead of throwing', async () => {
  assert.equal(NO_CONTEXT.ready, false);
  assert.equal(NO_CONTEXT.precise, false);
  assert.equal(await NO_CONTEXT.pack('anything'), '');
  assert.deepEqual(await NO_CONTEXT.definition('whatever'), []);
  assert.deepEqual(await NO_CONTEXT.references('whatever'), []);
  await NO_CONTEXT.dispose();
});

test('a repo with no index degrades rather than failing', async () => {
  const dir = scratch();
  try {
    // allowInit defaults to false: building an index writes to the user's repo,
    // so it must stay an explicit request.
    const ctx = await openContext(dir);
    assert.equal(ctx.ready, false);
    assert.equal(await ctx.pack('hello'), '');
    await ctx.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the precision layer stays off unless asked for', async () => {
  for (const config of [undefined, {}, { lsp: false }]) {
    const dir = scratch(config);
    try {
      const ctx = await openContext(dir);
      assert.equal(ctx.precise, false, JSON.stringify(config));
      await ctx.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('a malformed config disables the optional layer instead of failing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sumo-ctx-bad-'));
  try {
    mkdirSync(join(dir, '.sumo'), { recursive: true });
    writeFileSync(join(dir, '.sumo', 'config.json'), '{ not json', 'utf8');

    const ctx = await openContext(dir);
    assert.equal(ctx.precise, false);
    await ctx.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unreadable directory yields the empty context, not an exception', async () => {
  const ctx = await openContext('/definitely/not/a/real/path');
  assert.equal(ctx.ready, false);
  await ctx.dispose();
});
