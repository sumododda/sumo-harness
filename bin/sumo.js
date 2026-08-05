#!/usr/bin/env node
/**
 * The entry point, which decides whether it is running from a checkout or from
 * an installed package.
 *
 * These need opposite things and neither can be dropped. An installed copy has
 * to run compiled JavaScript, because Node refuses to strip types under
 * `node_modules` — that is where a global install puts it, and shipping raw
 * TypeScript failed on install while every test passed. A checkout has to run
 * the TypeScript, because `npm link` exists so that an edit is live; pointing
 * the link at `dist/` instead means every run silently executes whatever was
 * last built, and the only symptom is behaviour that is quietly out of date.
 *
 * That is not hypothetical. `sumo setup` was written, tested, committed and
 * pushed, and then `sumo setup` reported "too many arguments" — the linked
 * binary was running a build from seven minutes earlier, and nothing said so.
 *
 * Which one is which is not a setting to keep in sync: `src/` is absent from
 * the published package (see `files` in package.json), so its presence is
 * exactly the question being asked.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, '..', 'src', 'cli.ts');
const built = join(here, '..', 'dist', 'cli.js');

const entry = existsSync(source) ? source : built;
await import(pathToFileURL(entry).href);
