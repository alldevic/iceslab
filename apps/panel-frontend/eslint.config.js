import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      // Read, one by one, on 2026-08-27: eleven `set-state-in-effect` and three
      // `purity` sites across the live pages. Behaviour an operator could see
      // stood behind exactly ONE of them — HostEditPage re-seeding its form
      // over what had been typed — and that is fixed and covered by
      // HostEditPage.seed.test.tsx. The other thirteen are modal-open resets
      // (an extra render), one-shot latches, a pagination reset on filter
      // change, and `Date.now()` read during render to show a countdown.
      //
      // Warning rather than off, and rather than error: the rule earned its
      // keep by pointing at a real defect, so it must keep speaking up on new
      // code. But a red `pnpm lint` that everyone has learned to walk past
      // catches nothing, and rewriting thirteen working forms to silence it
      // would be a lot of edits in live screens for one fewer render each.
      // Decision by the user, 2026-08-27. `rules-of-hooks` stays an error.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/purity': 'warn',

      // Fast Refresh ergonomics, not correctness: the rule fires when a module
      // exports a component AND something else, which makes hot-reload replace
      // the whole module instead of just the component. Twenty-one sites, every
      // one of them a constant or a helper deliberately kept next to the single
      // screen that uses it — the alternative is twenty-one one-symbol files.
      // Nothing an operator or a user can observe stands behind any of them.
      //
      // Warning rather than off, for the same reason as the two above: it must
      // keep speaking up on new code. Decision by the user, 2026-08-27.
      'react-refresh/only-export-components': 'warn',
    },
  },
  {
    // Playwright specs and fixtures. `use` is Playwright's fixture callback,
    // not React's `use` hook, and a fixture named `page` is not a component —
    // rules-of-hooks reads the pair as a hook called from a plain function and
    // is wrong about both halves. None of this ships in the bundle either.
    files: ['e2e/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended],
    rules: {
      'react-hooks/rules-of-hooks': 'off',
      'react-refresh/only-export-components': 'off',
    },
  },
  {
    // Test files and their helpers are never in the bundle, so the Fast Refresh
    // rule - which is about what a module may export and still hot-reload -
    // has nothing to say about them.
    files: ['**/*.test.{ts,tsx}', 'src/test/**/*.{ts,tsx}'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
])
