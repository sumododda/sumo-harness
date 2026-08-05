/**
 * The permission gate is what makes read-only stages actually read-only, so it
 * is tested directly and offline — no model, no cost.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildGate, findSecret, isCredentialPath, isInside } from '../src/gate-tools.ts';

const ROOT = '/repo';

test('read-only stage refuses every write tool', () => {
  const gate = buildGate({ root: ROOT, allowWrites: false });

  for (const tool of ['Edit', 'Write', 'NotebookEdit']) {
    const reason = gate(tool, { file_path: '/repo/src/a.ts' });
    assert.ok(reason, `${tool} should be refused`);
    assert.match(reason, /read-only/i);
  }
});

test('read-only stage still permits reading and searching', () => {
  const gate = buildGate({ root: ROOT, allowWrites: false });

  assert.equal(gate('Read', { file_path: '/repo/src/a.ts' }), null);
  assert.equal(gate('Glob', { pattern: '**/*.ts' }), null);
  assert.equal(gate('Grep', { pattern: 'foo' }), null);
});

test('shell access is refused in every stage', () => {
  const writable = buildGate({ root: ROOT, allowWrites: true });
  const reason = writable('Bash', { command: 'npm test' });

  assert.ok(reason);
  assert.match(reason, /harness runs/i);
});

test('writable stage allows writes inside the repo', () => {
  const gate = buildGate({ root: ROOT, allowWrites: true });

  assert.equal(gate('Edit', { file_path: '/repo/src/a.ts' }), null);
  assert.equal(gate('Write', { file_path: 'src/nested/b.ts' }), null);
});

test('writes outside the repo are refused even when writes are allowed', () => {
  const gate = buildGate({ root: ROOT, allowWrites: true });

  for (const path of ['/etc/passwd', '/repo/../outside.ts', '../escape.ts']) {
    const reason = gate('Write', { file_path: path });
    assert.ok(reason, `${path} should be refused`);
    assert.match(reason, /outside the working directory/i);
  }
});

test('locked files cannot be edited during a writable stage', () => {
  const gate = buildGate({
    root: ROOT,
    allowWrites: true,
    lockedPaths: ['test/cart.test.ts'],
  });

  const reason = gate('Edit', { file_path: '/repo/test/cart.test.ts' });
  assert.ok(reason);
  assert.match(reason, /do not edit the tests/i);

  // Non-locked files in the same stage stay writable.
  assert.equal(gate('Edit', { file_path: '/repo/src/cart.ts' }), null);
});

test('a write with no path is refused rather than passed through', () => {
  const gate = buildGate({ root: ROOT, allowWrites: true });
  const reason = gate('Write', { content: 'hello' });

  assert.ok(reason);
  assert.match(reason, /no file path/i);
});

test('the gate counts which edit format was actually used', () => {
  const tally = { edit: 0, write: 0 };
  const gate = buildGate({ root: ROOT, allowWrites: true, tally });

  gate('Edit', { file_path: '/repo/src/a.ts' });
  gate('Edit', { file_path: '/repo/src/b.ts' });
  gate('Write', { file_path: '/repo/src/c.ts' });
  // Refused calls are attempts, not work, so they must not be counted.
  gate('Write', { file_path: '/etc/passwd' });

  assert.deepEqual(tally, { edit: 2, write: 1 });
});

test('targeted edits are preferred over rewriting an existing file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sumo-edits-'));
  try {
    writeFileSync(join(dir, 'cart.js'), 'export const rate = 0.1;\n', 'utf8');
    const gate = buildGate({ root: dir, allowWrites: true, preferTargetedEdits: true });

    const refused = gate('Write', { file_path: join(dir, 'cart.js') });
    assert.ok(refused, 'rewriting an existing file regenerates lines that were already right');
    assert.match(refused, /use Edit/i);

    // Editing it is the point of the refusal, so that must stay open.
    assert.equal(gate('Edit', { file_path: join(dir, 'cart.js') }), null);
    // And a file that does not exist yet has nothing to edit.
    assert.equal(gate('Write', { file_path: join(dir, 'new.js') }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('credential-shaped paths are refused for reading, even in a read-only stage', () => {
  const gate = buildGate({ root: ROOT, allowWrites: false });

  for (const path of ['/repo/.env', '/repo/config/.env.production', '/repo/.ssh/id_rsa', '/repo/keys/server.pem']) {
    const reason = gate('Read', { file_path: path });
    assert.ok(reason, `${path} should be refused`);
    assert.match(reason, /credential file/i);
  }
});

test('.env.example and friends are exempt from the credential-path refusal', () => {
  const gate = buildGate({ root: ROOT, allowWrites: false });

  for (const path of ['/repo/.env.example', '/repo/.env.sample', '/repo/.env.template']) {
    assert.equal(gate('Read', { file_path: path }), null);
  }
});

test('credential-shaped paths are refused for writing too', () => {
  const gate = buildGate({ root: ROOT, allowWrites: true });

  const reason = gate('Write', { file_path: '/repo/.env', content: 'FOO=bar' });
  assert.ok(reason);
  assert.match(reason, /credential file/i);
});

test('content that looks like a real credential is refused even to an allowed path', () => {
  const gate = buildGate({ root: ROOT, allowWrites: true });

  const write = gate('Write', {
    file_path: '/repo/src/config.ts',
    content: "export const key = 'AKIAABCDEFGHIJKLMNOP';",
  });
  assert.ok(write);
  assert.match(write, /AWS access key/i);

  const edit = gate('Edit', {
    file_path: '/repo/src/config.ts',
    new_string: "export const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';",
  });
  assert.ok(edit);
  assert.match(edit, /GitHub token/i);
});

test('ordinary content is unaffected by the secret scan', () => {
  const gate = buildGate({ root: ROOT, allowWrites: true });

  assert.equal(gate('Write', { file_path: '/repo/src/a.ts', content: 'export const x = 1;' }), null);
});

test('without the preference, whole-file writes are allowed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sumo-edits-off-'));
  try {
    writeFileSync(join(dir, 'cart.js'), 'export const rate = 0.1;\n', 'utf8');
    // This is the state a retry runs in: the cheap format already failed once,
    // and losing the task to a format would be the worse outcome.
    const gate = buildGate({ root: dir, allowWrites: true });

    assert.equal(gate('Write', { file_path: join(dir, 'cart.js') }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// `isCredentialPath`, `isInside` and `findSecret` are exported so fix.ts can
// apply the identical screen to a repro test's content, which reaches disk
// with no Edit/Write tool call for `buildGate` to intercept. These pin the
// exported functions directly, on top of the behavioural tests above that
// already prove `buildGate` uses them.

test('isCredentialPath recognises the same shapes buildGate refuses', () => {
  assert.equal(isCredentialPath('.env'), true);
  assert.equal(isCredentialPath('config/.env.production'), true);
  assert.equal(isCredentialPath('.env.example'), false);
  assert.equal(isCredentialPath('src/config.ts'), false);
});

test('isInside confines a candidate to root, the same way buildGate does', () => {
  assert.equal(isInside('/repo', 'src/a.ts'), true);
  assert.equal(isInside('/repo', '/repo/src/a.ts'), true);
  assert.equal(isInside('/repo', '../outside.ts'), false);
  assert.equal(isInside('/repo', '/etc/passwd'), false);
});

test('findSecret matches the same patterns buildGate refuses content on', () => {
  const found = findSecret("export const key = 'AKIAABCDEFGHIJKLMNOP';");
  assert.ok(found);
  assert.match(found.label, /AWS access key/i);
  assert.equal(findSecret('export const x = 1;'), null);
});

test('the search throttle names what is still available', async () => {
  const features = await import('../src/features.ts');
  const original = features.get();
  features.set({ ...original, searchThrottle: true });

  try {
    const gate = buildGate({ root: ROOT, allowWrites: false, indexed: true });

    // The allowance is generous on purpose; the pack covers the task's code,
    // not the whole repo, so a stage legitimately searches for build config or
    // a literal string it was never given.
    for (let i = 0; i < 6; i += 1) {
      assert.equal(gate('Grep', { pattern: `thing-${String(i)}` }), null, `search ${String(i)}`);
    }

    const refused = gate('Grep', { pattern: 'one-too-many' });
    assert.ok(refused, 'the seventh is refused');

    // The old wording asked the model to "say what you are looking for and why
    // the context is insufficient". Nothing ever read that: denials are counted
    // and never parsed, so there was no way to earn the search back. A refusal
    // that invites a negotiation it cannot hold is worse than a plain one.
    assert.doesNotMatch(refused, /say what you are looking for/i);
    // What it must do instead is name the tools that still work.
    assert.match(refused, /Read/, 'reads are not limited and should be named');
    assert.match(refused, /Glob/, 'nor is finding a file by name');

    // Reading and globbing genuinely still work, so the message is not a lie.
    assert.equal(gate('Read', { file_path: '/repo/src/a.ts' }), null);
    assert.equal(gate('Glob', { pattern: '**/*.test.ts' }), null);
  } finally {
    features.set(original);
  }
});

test('the throttle can be switched off, like every other optimisation', async () => {
  const features = await import('../src/features.ts');
  const original = features.get();
  features.set({ ...original, searchThrottle: false });

  try {
    // A claim that cannot be turned off cannot be measured, and this is the one
    // optimisation that refuses the model something rather than changing what
    // it is given — so it is the one most worth being able to price.
    const gate = buildGate({ root: ROOT, allowWrites: false, indexed: true });
    for (let i = 0; i < 20; i += 1) {
      assert.equal(gate('Grep', { pattern: `thing-${String(i)}` }), null);
    }
  } finally {
    features.set(original);
  }
});
