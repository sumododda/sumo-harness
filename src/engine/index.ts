/**
 * Provider selection.
 *
 * Adding GitHub Copilot models later means writing `copilot.ts` against the
 * Engine interface and adding one case here — no change to workflows, router,
 * or prompts.
 */

import { ClaudeEngine } from './claude.ts';
import { CopilotEngine } from './copilot.ts';
import type { Engine } from './types.ts';
import { SumoError } from '../types.ts';

export type ProviderName = 'claude' | 'github-copilot';

const PROVIDERS: Record<ProviderName, () => Engine> = {
  claude: () => new ClaudeEngine(),
  // Named as models.dev names it, because the catalogue is keyed on that and a
  // second spelling here would be a lookup that silently returns nothing.
  'github-copilot': () => new CopilotEngine(),
};

/** Resolves the provider from an explicit name, then SUMO_PROVIDER, then the default. */
export function getEngine(name?: string): Engine {
  const requested = (name ?? process.env.SUMO_PROVIDER ?? 'claude') as ProviderName;
  const make = PROVIDERS[requested];
  if (!make) {
    throw new SumoError(`Unknown provider "${requested}".`, 'unknown_provider', [
      `Available: ${Object.keys(PROVIDERS).join(', ')}`,
    ]);
  }
  return make();
}

/**
 * The provider seam's public surface. `ToolGate` is what a second engine must
 * accept, so it is exported as part of the contract rather than on demand.
 *
 * @public
 */
export type { Engine, StageRequest, Capability, ToolGate } from './types.ts';
