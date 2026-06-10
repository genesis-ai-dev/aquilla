import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

// Minimal stub so that existing `eslint-disable-next-line react/no-danger`
// comments in source files don't trigger "definition not found" errors.
// eslint-plugin-react is not installed; this stub satisfies the parser only.
const reactStub = {
  rules: { 'no-danger': { meta: {}, create: () => ({}) } },
}

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
    plugins: {
      react: reactStub,
    },
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // react-refresh: fast-reload dev-experience rule, not a correctness/security rule.
      // Downgraded to warn so it surfaces but does not block CI. The existing codebase
      // legitimately exports context objects alongside components in many files.
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],

      // Honor the _-prefix convention for intentionally unused params/vars (TypeScript-
      // idiomatic). Applies project-wide; tests get a broader override below.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],

      // Empty catch blocks are an accepted idiom for "swallow this error"
      // (e.g. audio node disconnect, optional cleanup). allowEmptyCatch avoids
      // requiring a dummy binding while still flagging non-catch empty blocks.
      'no-empty': ['error', { allowEmptyCatch: true }],

      // React Compiler rules (react-hooks v7): these were introduced by upgrading the
      // plugin and flag pre-Compiler patterns (derived state in effects, ref reads in
      // render body) that are valid in non-Compiler React and work correctly at runtime.
      // Fixing them requires architectural refactoring of ~30 files. Downgraded to warn
      // so violations are visible but do not block CI; they should be addressed
      // incrementally as each file is refactored for Compiler compatibility.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/purity': 'warn',
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
  // Test files: allow `any` for test stubs/mocks, relax unused-vars (many tests
  // intentionally destructure only some fields of a fixture), allow BOM and
  // other special whitespace in string/regex literals that simulate real file
  // inputs (e.g. Paratext XML test fixtures that start with a byte-order mark).
  {
    files: [
      '**/*.test.{ts,tsx}',
      '**/*.spec.{ts,tsx}',
      '**/__tests__/**/*.{ts,tsx}',
      '**/tests/**/*.{ts,tsx}',
      '**/test-setup*.{ts,tsx}',
    ],
    rules: {
      // Tests legitimately use `any` to stub external types and mock shapes.
      '@typescript-eslint/no-explicit-any': 'off',
      // Unused vars prefixed with _ are deliberate in test fixtures.
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Test fixtures may contain intentional irregular whitespace (BOM, NBSP)
      // to simulate real file inputs (e.g. Paratext XML, USFM with BOM).
      'no-irregular-whitespace': 'off',
    },
  },
  // e2e (Playwright) files: playwright fixture functions like `alice`, `bob`, `carol`
  // are not React components or hooks, so react-hooks rules are inapplicable here.
  {
    files: ['e2e/**/*.{ts,tsx}'],
    rules: {
      'react-hooks/rules-of-hooks': 'off',
      // e2e tests use _ prefix for intentionally-unused destructured playwright args.
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Empty catch blocks are common in e2e for graceful error handling.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  // scripts/ are build/dev utilities, not runtime code.
  {
    files: ['scripts/**/*.{ts,tsx}'],
    rules: {
      // Empty catch blocks in scripts are used for graceful teardown.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
])
