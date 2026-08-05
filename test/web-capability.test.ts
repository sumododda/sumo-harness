/**
 * What `web` means, on every provider that can be routed to.
 *
 * A capability is a promise the harness makes to a stage, and a stage does not
 * know which account it landed on — so `web` has to mean the same thing
 * everywhere, or `/research` silently does less on one provider than another.
 * That is the worst version of this bug: no error, just an answer built from
 * less.
 *
 * It is kept the same by the harness running the search itself (`websearch.ts`)
 * rather than by each engine granting a hosted one. The provider's search is the
 * fallback for when the harness could not search at all, and these tests pin
 * both halves of that: which tools appear when the harness has already searched,
 * and which appear when it has not.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as features from '../src/features.ts';
import { toolsFor as claudeTools } from '../src/engine/claude.ts';
import { toolsFor as copilotTools } from '../src/engine/copilot.ts';

/** Each provider's own spelling of the two halves of web access. */
const WEB = [
  { provider: 'claude', tools: claudeTools, search: 'WebSearch', fetch: 'WebFetch' },
  { provider: 'github-copilot', tools: copilotTools, search: 'web_search', fetch: 'web_fetch' },
] as const;

test('the provider search is granted only when the harness could not run one', () => {
  // The fallback. No `ddgr`, no network — the stage still has to be able to
  // find something, so the hosted tool comes back.
  for (const { provider, tools, search, fetch } of WEB) {
    const granted = tools(['read', 'search', 'web'], false);
    assert.ok(granted.includes(search), `${provider} has no fallback search`);
    assert.ok(granted.includes(fetch), `${provider} cannot fetch a page`);
  }
});

test('once the harness has searched, the provider search is withheld', () => {
  // A tool that is present gets used, and a second search returns a different
  // set of pages from the ones the citations were promised against.
  for (const { provider, tools, search, fetch } of WEB) {
    const granted = tools(['read', 'search', 'web'], true);
    assert.ok(!granted.includes(search), `${provider} would search again for itself`);
    assert.ok(granted.includes(fetch), `${provider} cannot follow the URLs it was handed`);
  }
});

test('fetch survives either way, because something must read the pages', () => {
  // Whichever search found the URLs, the stage still has to go and read them.
  for (const { provider, tools, fetch } of WEB) {
    for (const searched of [true, false]) {
      assert.ok(tools(['web'], searched).includes(fetch), `${provider}, searched=${String(searched)}`);
    }
  }
});

test('no provider reaches the web without the capability', () => {
  // `web` is granted per stage precisely because a stage that can reach the
  // network is one whose answer is no longer re-derivable from the repository.
  features.set({ stableToolList: false });
  for (const { provider, tools, search, fetch } of WEB) {
    const granted = tools(['read', 'search', 'edit'], false);
    assert.ok(!granted.includes(search), `${provider} can search without asking for web`);
    assert.ok(!granted.includes(fetch), `${provider} can fetch without asking for web`);
  }
});

test('the stable tool list does not quietly hand every stage the web', () => {
  // `stableToolList` widens read/search/edit to every stage so a provider's own
  // prefix cache keeps matching. `web` is deliberately outside that set.
  features.set({ stableToolList: true });
  const granted = claudeTools(['read'], false);
  assert.ok(!granted.includes('WebSearch'));
  assert.ok(!granted.includes('WebFetch'));
  features.set({ stableToolList: false });
});
