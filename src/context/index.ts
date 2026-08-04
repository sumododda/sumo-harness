/**
 * Assembles the code-context stack for a repo: the index always, a language
 * server on top only when asked for.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as features from '../features.ts';
import { CodeGraphContext } from './codegraph.ts';
import { type Lang, LspContext } from './lsp.ts';
import { type CodeContext, NO_CONTEXT } from './types.ts';

/**
 * The seam's public surface. `Location` and `ServerStatus` are part of the
 * contract a second context backend implements, so they are exported whether or
 * not anything in this repository imports them by name today.
 *
 * @public
 */
export type { CodeContext, Location } from './types.ts';
/** @public */
export { serverStatus, type ServerStatus } from './lsp.ts';

const ALL_LANGS: readonly Lang[] = ['ts', 'py', 'go'];

export interface ContextOptions {
  /** Build an index when the repo has none. Indexing writes to the repo. */
  readonly allowInit?: boolean;
  /** Force the precision layer on or off, overriding `.sumo/config.json`. */
  readonly lsp?: boolean;
}

/** Opens the best available context for a repo. Never throws. */
export async function openContext(
  root: string,
  opts: ContextOptions = {},
): Promise<CodeContext> {
  // Switched off, the harness reads its way around the repo as it would without
  // an index — the baseline every retrieval saving is quoted against.
  if (!features.get().index) return NO_CONTEXT;

  const index = await CodeGraphContext.open(root, opts.allowInit ?? false);
  if (!index) return NO_CONTEXT;

  const langs = resolveLspLangs(root, opts.lsp);
  return langs.length > 0 ? new LspContext(index, root, langs) : index;
}

/**
 * Reads the precision-layer setting. Off unless enabled, because spawning
 * language servers costs startup time on every task.
 *
 * `.sumo/config.json` accepts `"lsp": true` for all supported languages, or a
 * list such as `["ts", "go"]`.
 */
function resolveLspLangs(root: string, override?: boolean): readonly Lang[] {
  if (override === true) return ALL_LANGS;
  if (override === false) return [];

  try {
    const path = join(root, '.sumo', 'config.json');
    if (!existsSync(path)) return [];

    const config = JSON.parse(readFileSync(path, 'utf8')) as { lsp?: boolean | string[] };
    if (config.lsp === true) return ALL_LANGS;
    if (Array.isArray(config.lsp)) {
      return config.lsp.filter((l): l is Lang => (ALL_LANGS as readonly string[]).includes(l));
    }
  } catch {
    // A malformed config disables the optional layer rather than failing a task.
  }

  return [];
}
