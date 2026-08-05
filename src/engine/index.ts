/**
 * Provider selection.
 *
 * Adding GitHub Copilot models later means writing `copilot.ts` against the
 * Engine interface and adding one case here — no change to workflows, router,
 * or prompts.
 */

import { ClaudeEngine, credentialed as claudeCredentialed } from './claude.ts';
import { CopilotEngine, credentialed as copilotCredentialed } from './copilot.ts';
import type { Engine } from './types.ts';
import { SumoError } from '../types.ts';

export type ProviderName = 'claude' | 'github-copilot';

/**
 * What the harness knows how to reach, and how to tell whether this machine can.
 *
 * `credentialed` sits here rather than on {@link Engine} on purpose. It is a
 * property of a *registered provider* — something with a name, a place in this
 * table, and a known way of being logged into — not of the seam. Every test
 * double in the suite implements `Engine`; none of them has a credential, and
 * requiring them to answer a question only this table ever asks would have been
 * fifteen files of noise to no end.
 */
const PROVIDERS: Record<ProviderName, { make: () => Engine; credentialed: () => boolean }> = {
  claude: { make: () => new ClaudeEngine(), credentialed: claudeCredentialed },
  // Named as models.dev names it, because the catalogue is keyed on that and a
  // second spelling here would be a lookup that silently returns nothing.
  'github-copilot': { make: () => new CopilotEngine(), credentialed: copilotCredentialed },
};

/** The provider used when nothing names one and nothing can be detected. */
const DEFAULT_PROVIDER: ProviderName = 'claude';

/** Resolves the provider from an explicit name, then SUMO_PROVIDER, then the default. */
export function getEngine(name?: string): Engine {
  const requested = (name ?? process.env.SUMO_PROVIDER ?? DEFAULT_PROVIDER) as ProviderName;
  const provider = PROVIDERS[requested];
  if (!provider) {
    throw new SumoError(`Unknown provider "${requested}".`, 'unknown_provider', [
      `Available: ${Object.keys(PROVIDERS).join(', ')}`,
    ]);
  }
  return provider.make();
}

/**
 * The providers a fleet should be built from.
 *
 * This is the difference between the routing in `fleet.ts` being a design and
 * being a thing that happens. That file pools models from every provider,
 * prunes dominated ones across account boundaries, and breaks ties by aptitude
 * and price — and every caller handed it a single engine, so none of it ever
 * ran. A fleet of one has no cross-provider anything to decide.
 *
 * Naming a provider still means exactly that provider. An operator who passes
 * `--provider github-copilot` is not asking for a fleet with Copilot in it; and
 * routing around a provider that was asked for by name would turn a clear
 * failure ("this provider cannot do that") into a silent substitution, which is
 * the harder thing to debug of the two.
 *
 * With nothing named, every provider this machine appears to have an account
 * for joins the pool. If that finds nothing — a machine mid-setup, or one whose
 * credentials live somewhere no local check can see — the default is used
 * alone, so the failure is the familiar one from that provider rather than a
 * new error about fleets.
 */
export function getFleetEngines(name?: string): Engine[] {
  const named = name ?? process.env.SUMO_PROVIDER;
  if (named) return [getEngine(named)];

  const detected = Object.values(PROVIDERS)
    .filter((provider) => provider.credentialed())
    .map((provider) => provider.make());

  return detected.length > 0 ? detected : [getEngine(DEFAULT_PROVIDER)];
}

/**
 * The provider seam's public surface. `ToolGate` is what a second engine must
 * accept, so it is exported as part of the contract rather than on demand.
 *
 * @public
 */
export type { Engine, StageRequest, Capability, ToolGate } from './types.ts';
