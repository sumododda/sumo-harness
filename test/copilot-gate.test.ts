/**
 * How a Copilot write reaches the provider-neutral gate.
 *
 * The gate is written against two tool names and two content fields, and this
 * is the file that has to hand it both. When it did not — everything arrived as
 * `Write` with no content — three separate things broke at once and none of
 * them were visible from the gate's side: targeted edits to existing files were
 * refused with advice that could not be taken, the edit/write tally counted
 * every edit as a whole-file rewrite, and the secret screen was handed an empty
 * string on every call and so could never fire.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { PermissionRequest } from '@github/copilot-sdk';
import { writeGateArgs } from '../src/engine/copilot.ts';
import { buildGate } from '../src/gate-tools.ts';

/** A write permission request, in the shape the SDK sends one. */
function write(fields: {
  fileName: string;
  diff?: string;
  newFileContents?: string;
}): PermissionRequest {
  return {
    kind: 'write',
    canOfferSessionApproval: true,
    intention: 'test',
    diff: '',
    ...fields,
  } as unknown as PermissionRequest;
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'sumo-copilot-gate-'));
}

test('a new file carries its whole contents and arrives as a Write', () => {
  const [tool, input] = writeGateArgs(
    write({ fileName: 'src/new.ts', newFileContents: 'export const a = 1;\n' }),
  );
  assert.equal(tool, 'Write');
  assert.equal(input['content'], 'export const a = 1;\n');
  assert.equal(input['file_path'], 'src/new.ts');
});

test('a targeted change arrives as an Edit, not a Write', () => {
  // The whole point: `preferTargetedEdits` refuses a Write to a file that
  // already exists and tells the model to use Edit. If an edit cannot reach the
  // gate as one, that advice is impossible to follow.
  const [tool] = writeGateArgs(
    write({ fileName: 'src/cart.ts', diff: '@@\n-const a = 1;\n+const a = 2;\n' }),
  );
  assert.equal(tool, 'Edit');
});

test('an edit is screened on what it adds, not on what it removes', () => {
  const [, input] = writeGateArgs(
    write({
      fileName: 'src/cart.ts',
      diff: '--- a/src/cart.ts\n+++ b/src/cart.ts\n@@\n-const old = 1;\n+const fresh = 2;\n context\n',
    }),
  );
  assert.equal(input['new_string'], 'const fresh = 2;');
});

test('the gate refuses a Copilot edit that adds a secret', () => {
  const dir = scratch();
  try {
    writeFileSync(join(dir, 'config.ts'), 'export const config = {};\n');
    const gate = buildGate({ root: dir, allowWrites: true });

    const [tool, input] = writeGateArgs(
      write({
        fileName: join(dir, 'config.ts'),
        diff: `@@\n+const token = 'ghp_${'a'.repeat(36)}';\n`,
      }),
    );

    assert.match(gate(tool, input) ?? '', /looks like it contains/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an edit to an existing file is allowed where a whole-file rewrite is not', () => {
  const dir = scratch();
  try {
    writeFileSync(join(dir, 'cart.ts'), 'export const a = 1;\n');
    const gate = buildGate({ root: dir, allowWrites: true, preferTargetedEdits: true });

    const rewrite = writeGateArgs(
      write({ fileName: join(dir, 'cart.ts'), newFileContents: 'export const a = 2;\n' }),
    );
    assert.match(gate(rewrite[0], rewrite[1]) ?? '', /already exists — use Edit/);

    const edit = writeGateArgs(
      write({ fileName: join(dir, 'cart.ts'), diff: '@@\n-const a = 1;\n+const a = 2;\n' }),
    );
    assert.equal(gate(edit[0], edit[1]), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the tally tells a targeted edit apart from a whole-file write', () => {
  const dir = scratch();
  try {
    writeFileSync(join(dir, 'cart.ts'), 'export const a = 1;\n');
    const tally = { edit: 0, write: 0 };
    const gate = buildGate({ root: dir, allowWrites: true, tally });

    const edit = writeGateArgs(
      write({ fileName: join(dir, 'cart.ts'), diff: '@@\n+const a = 2;\n' }),
    );
    gate(edit[0], edit[1]);

    const created = writeGateArgs(
      write({ fileName: join(dir, 'fresh.ts'), newFileContents: 'export const b = 1;\n' }),
    );
    gate(created[0], created[1]);

    assert.deepEqual(tally, { edit: 1, write: 1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
