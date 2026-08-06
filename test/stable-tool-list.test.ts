/**
 * `stableToolList` trades away part of `TOOLS`'s defence — an unlisted tool is
 * absent from the model's context and cannot be called at all — for a stable
 * tool-definitions block a provider's own prefix cache can reuse stage to
 * stage. That is only a good trade if the `PreToolUse` gate still refuses the
 * write on its own; this file pins both halves offline, no model involved.
 */

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { toolsFor } from '../src/engine/claude.ts';
import * as features from '../src/features.ts';
import { buildGate } from '../src/gate-tools.ts';

afterEach(() => {
  features.set({ stableToolList: false });
});

test('off: a read-only capability list carries no Edit or Write, exactly as before this flag existed', () => {
  features.set({ stableToolList: false });
  const tools = toolsFor(['read', 'search']);

  assert.deepEqual(tools, ['Read', 'Glob', 'Grep']);
  assert.ok(!tools.includes('Edit'));
  assert.ok(!tools.includes('Write'));
});

test('on: a read-only stage is granted the same stable Read/Glob/Grep/Edit/Write list a writable stage gets', () => {
  features.set({ stableToolList: true });

  const readOnly = toolsFor(['read', 'search']);
  const writable = toolsFor(['read', 'search', 'edit']);

  assert.deepEqual([...readOnly].sort(), [...writable].sort());
  assert.ok(readOnly.includes('Edit'));
  assert.ok(readOnly.includes('Write'));
});

test('on: git and web are not added unconditionally — only a stage that actually asks for them gets them', () => {
  features.set({ stableToolList: true });

  const plain = toolsFor(['read', 'search']);
  assert.ok(!plain.includes('WebSearch'));
  assert.ok(!plain.includes('WebFetch'));

  const web = toolsFor(['read', 'search', 'web']);
  assert.ok(web.includes('WebSearch'));
  assert.ok(web.includes('WebFetch'));
});

test('on or off: a stage that asks for no capabilities is given no tools at all', () => {
  // Measured, not assumed. With the stable list expanding `[]` into
  // Read/Glob/Grep/Edit/Write, the router — whose entire input is one sentence
  // and which has no use for the repository — opened files to look for the
  // identifiers a request mentioned. It took up to six turns, spent its whole
  // budget, and sometimes returned narration where the JSON should have been.
  // Routing every turn through that cost 13x what routing costs now.
  //
  // The stable list exists to keep one task's tool-definitions prefix identical
  // across its stages. A no-capability stage is a single call that is not part
  // of any such run, so it has no prefix to keep stable and nothing to gain.
  for (const stableToolList of [false, true]) {
    features.set({ stableToolList });
    assert.deepEqual(toolsFor([]), [], `stableToolList: ${String(stableToolList)}`);
  }
});

test('on: the tool list is listed but the gate still refuses the write — tool-list omission traded for gate enforcement, not for no enforcement', () => {
  features.set({ stableToolList: true });

  const tools = toolsFor(['read', 'search']);
  assert.ok(tools.includes('Edit') && tools.includes('Write'), 'the tool is present in context');

  // buildGate never sees a tool list — it decides purely from allowWrites and
  // the call itself, which is exactly why listing Edit/Write here is safe: the
  // gate that stops the call does not care whether the model could see the
  // tool coming.
  const gate = buildGate({ root: '/repo', allowWrites: false });
  for (const tool of ['Edit', 'Write']) {
    const reason = gate(tool, { file_path: '/repo/src/a.ts' });
    assert.ok(reason, `${tool} should still be refused with the tool listed`);
    assert.match(reason, /read-only/i);
  }
});
