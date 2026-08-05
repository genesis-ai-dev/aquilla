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
  // .claude holds local agent worktrees (full repo copies with their own
  // node_modules); ESLint 10 traverses dot-directories and resolves each file's
  // nearest eslint.config.js, so without this ignore it loads those copies' configs.
  globalIgnores(['dist', '.claude']),
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

      // New in ESLint 10's recommended set; they flag ~40 pre-existing patterns
      // across 30 files (and no-useless-assignment has known false positives around
      // try/catch). Downgraded to warn so the upgrade lands without a mass refactor;
      // address incrementally like the react-hooks rules above.
      'preserve-caught-error': 'warn',
      'no-useless-assignment': 'warn',
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
  // DOM-global shadow guard (AQU-642): these PascalCase browser globals collide with
  // lucide-react icon names. If an icon import is dropped (e.g. in a merge-conflict
  // resolution), the JSX silently resolves to the DOM global — TypeScript accepts it
  // (lib.dom declares them) and React throws "TypeError: Illegal constructor" at
  // runtime. Restricting the bare globals makes the missing import a lint error.
  // Only names with no legitimate bare use in src/ are listed (Audio, Image, File,
  // Node, Event etc. are excluded because the app uses them as real globals).
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-globals': [
        'error',
        ...['Lock', 'Text', 'Option', 'History', 'Selection', 'Comment', 'Notification', 'Touch', 'Screen'].map(
          (name) => ({
            name,
            message: `"${name}" here is the browser global, not an import — if this is meant to be a lucide icon or local symbol, import it (see AQU-642).`,
          }),
        ),
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
