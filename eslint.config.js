// @ts-check
/**
 * Static analysis for the harness.
 *
 * Type-aware rules are the point: `tsc --noEmit` already proves the types line
 * up, so the value ESLint adds here is the class of bug the type system does not
 * see — a promise nobody awaited, a `catch` that swallows a programmer error, a
 * regex that backtracks. Stylistic rules are deliberately absent; the codebase
 * has a voice and a formatter would only argue with it.
 */

import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    // `dist/**` is this project's own source after `tsc` — linting the emit
    // would report the same code twice, in a form nobody edits.
    ignores: [
      'node_modules/**',
      'dist/**',
      '.claude/**',
      '.sumo/**',
      '.codegraph/**',
      '.lavish/**',
      'test/fixtures/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,

  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        // Neither of these is in tsconfig's `include`. This one is JS because
        // typechecking it would drag ESLint's own types into the build;
        // `bin/sumo.js` is JS because it is the entry point that decides
        // whether to load TypeScript at all, so it cannot be TypeScript.
        projectService: { allowDefaultProject: ['eslint.config.js', 'bin/sumo.js'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },

    rules: {
      // The harness is full of deliberate `catch {}` blocks — a cache that
      // cannot write is a slow cache, not a broken harness. Each one is
      // commented; the rule would flag every one of them.
      '@typescript-eslint/no-empty-function': 'off',

      // Prefixing with `_` is the established way this codebase discards a
      // destructured field it does not want (see stage.ts, schemas.ts).
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],

      // A dropped promise is the failure this project cannot afford: a stage
      // that is not awaited reports success before it has run.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',

      // Provider payloads and JSON on disk are genuinely unknown, and the code
      // narrows them by hand. Blanket-banning the casts would mean silencing
      // them one by one for no gain.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',

      // `?? ''` on a value the checker believes is always a string is how this
      // code defends against a provider sending something else.
      '@typescript-eslint/no-unnecessary-condition': 'off',

      // Interpolating a number into a message is not a bug, and every site here
      // is a cost, a count, or a line number.
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true, allowNever: true },
      ],

      // `noUncheckedIndexedAccess` is on, so every `arr[i]` is `T | undefined`
      // and `!` is how this codebase says "the bound was just checked". Banning
      // it here would mean trading a proven index for an invented fallback.
      '@typescript-eslint/no-non-null-assertion': 'off',

      // `async () => ''` is how a stub satisfies an async interface, and how a
      // hook signature is honoured. Neither has anything to await.
      '@typescript-eslint/require-await': 'off',

      // `.forEach(x => doThing(x))` reads fine; braces add nothing.
      '@typescript-eslint/no-confusing-void-expression': 'off',

      // `delete env[name]` over a fixed list of names is the point of the list.
      '@typescript-eslint/no-dynamic-delete': 'off',
    },
  },

  {
    // Tests reach into internals and assert on shapes the checker cannot see.
    files: ['test/**/*.ts', 'scripts/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      // `node:test` returns a promise from `test()` that the runner itself
      // awaits. Every suite in the ecosystem calls it without `await`.
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },
);
