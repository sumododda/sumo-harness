/**
 * What the Claude login may actually call.
 *
 * Anthropic had no roster probe at all: the catalogue said what exists in the
 * world and nothing said what exists *for you*, so a model withdrawn by an
 * organisation was discovered at call time, mid-stage, after the prompt had been
 * paid for. Copilot had had one all along, which made `web`-style asymmetry into
 * availability-style asymmetry — the same bug wearing a different hat.
 *
 * The interesting part is not the probe but the matching. The CLI and the
 * catalogue do not spell models identically, and getting that wrong does not
 * fail loudly: it empties a tier, and routing quietly falls to whatever is left.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sameModel } from '../src/engine/claude.ts';

test('a dated id the CLI offers covers the catalogue`s undated entry', () => {
  // Measured against a live login: the CLI resolves `haiku` to
  // `claude-haiku-4-5-20251001` while the catalogue's canonical row is
  // `claude-haiku-4-5`. Equality would have dropped the small tier.
  assert.ok(sameModel('claude-haiku-4-5-20251001', 'claude-haiku-4-5'));
});

test('and the other way round, once a dated alias is published', () => {
  assert.ok(sameModel('claude-sonnet-5', 'claude-sonnet-5-20260101'));
});

test('an exact id matches itself', () => {
  assert.ok(sameModel('claude-sonnet-5', 'claude-sonnet-5'));
});

test('a shared prefix is not a match unless it breaks on a separator', () => {
  // The reason this is not `startsWith`. A version is not a prefix of the next
  // one, and treating it as one would route at a model the account never listed.
  assert.ok(!sameModel('claude-opus-45', 'claude-opus-4'));
  assert.ok(!sameModel('claude-opus-4', 'claude-opus-45'));
});

test('different models never match', () => {
  assert.ok(!sameModel('claude-sonnet-5', 'claude-opus-5'));
  assert.ok(!sameModel('claude-opus-4-6', 'claude-opus-5'));
});

test('a variant marker is not part of the identity', () => {
  // The CLI answers `claude-opus-5[1m]` — the same model at a different window.
  // Stripping happens before the comparison, so this is what it must then match.
  assert.ok(sameModel('claude-opus-5', 'claude-opus-5'));
  assert.ok(!sameModel('claude-opus-5[1m]', 'claude-opus-5'), 'the marker must be stripped first');
});
