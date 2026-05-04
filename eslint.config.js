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
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      "react-hooks/react-compiler": "error",
    },
  },
  // AuthorizedEvent perimeter guard: only authorize.ts may construct instances.
  // Any other file in sync-worker/src that calls `new AuthorizedEvent(...)` is
  // a policy violation — it bypasses the auth perimeter.
  {
    files: ['sync-worker/src/**/*.ts'],
    ignores: ['sync-worker/src/events/authorize.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'NewExpression[callee.name="AuthorizedEvent"]',
          message:
            'AuthorizedEvent must only be constructed via authorize() in events/authorize.ts. Direct instantiation defeats the auth perimeter.',
        },
        {
          selector: 'ClassDeclaration[superClass.name="AuthorizedEvent"]',
          message:
            'Subclassing AuthorizedEvent is not permitted; subclasses inherit the [AUTHORIZED] symbol via super(). Use authorize() directly.',
        },
        {
          selector: 'ClassExpression[superClass.name="AuthorizedEvent"]',
          message:
            'Subclassing AuthorizedEvent is not permitted; subclasses inherit the [AUTHORIZED] symbol via super(). Use authorize() directly.',
        },
        {
          selector: 'ImportSpecifier[imported.name="AuthorizedEvent"]:not([local.name="AuthorizedEvent"])',
          message:
            'AuthorizedEvent must not be aliased on import; this defeats the ESLint perimeter guard.',
        },
      ],
    },
  },
])
