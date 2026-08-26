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
