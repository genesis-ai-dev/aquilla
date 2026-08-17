import { RuleTester } from "eslint"
import { describe, it } from "vitest"
// @ts-expect-error - CommonJS module, no type declarations
import noUnkeyedString from "./no-unkeyed-string.cjs"

// ESLint's RuleTester defaults to Mocha's global describe/it. Point it at
// vitest's instead so `npx vitest run tools/eslint-rules` picks these up
// without pulling in a second test runner.
RuleTester.describe = describe
RuleTester.it = it

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2020,
    sourceType: "module",
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
})

ruleTester.run("no-unkeyed-string", noUnkeyedString, {
  valid: [
    // Already keyed through the catalog.
    { code: "const x = <p>{t('nav.save')}</p>", filename: "src/components/Foo.tsx" },
    // Whitespace-only JSXText between tags.
    { code: "const x = <div>\n  <span>{a}</span>\n</div>", filename: "src/components/Foo.tsx" },
    // Atomic-term-only phrases: product/format names, keyboard chords.
    { code: "const x = <p>USFM</p>", filename: "src/components/Foo.tsx" },
    { code: "const x = <p>MP3 / WAV</p>", filename: "src/components/Foo.tsx" },
    { code: "const x = <p>Ctrl + Enter</p>", filename: "src/components/Foo.tsx" },
    // Non-translatable attribute (not in TRANSLATABLE_ATTRS).
    { code: "const x = <div className=\"Save changes\" />", filename: "src/components/Foo.tsx" },
    // Translatable attribute, but the value is an atomic term / identifier shape.
    { code: "const x = <img alt=\"USFM\" />", filename: "src/components/Foo.tsx" },
    { code: "const x = <input placeholder=\"https://example.com/path\" />", filename: "src/components/Foo.tsx" },
    // Template literal WITH an expression: known limitation, not flagged (see rule doc comment).
    { code: "const x = <p>{`Deleted ${n} files`}</p>", filename: "src/components/Foo.tsx" },
    // Notification call with a dynamic (non-literal) message is out of scope.
    { code: "toast.error(errorMessage)", filename: "src/components/Foo.tsx" },
    // Escape hatch: inline exemption comment.
    { code: "const x = <p>{/* i18n-exempt legal boilerplate */}\nSave changes</p>", filename: "src/components/Foo.tsx" },
    // Ignored file: whole-file exemption via IGNORED_FILE_PATTERNS.
    { code: "const x = <p>Save changes</p>", filename: "src/components/Foo.test.tsx" },
    { code: "const x = <p>Third-party data processors</p>", filename: "src/pages/PrivacyPolicy.tsx" },
  ],

  invalid: [
    // JSXText between tags — the highest-confidence detection class.
    {
      code: "const x = <p>Save changes</p>",
      filename: "src/components/Foo.tsx",
      errors: [{ messageId: "unkeyed" }],
    },
    // A phrase with one non-atomic word is still flagged even though it contains an atomic term.
    {
      code: "const x = <p>USFM file</p>",
      filename: "src/components/Foo.tsx",
      errors: [{ messageId: "unkeyed" }],
    },
    // JSX attribute in TRANSLATABLE_ATTRS.
    {
      code: "const x = <button aria-label=\"Close dialog\" />",
      filename: "src/components/Foo.tsx",
      errors: [{ messageId: "unkeyed" }],
    },
    {
      code: "const x = <input placeholder=\"Enter your name\" />",
      filename: "src/components/Foo.tsx",
      errors: [{ messageId: "unkeyed" }],
    },
    // Notification calls: toast.* and window.alert/confirm.
    {
      code: "toast.error('Failed to save project')",
      filename: "src/components/Foo.tsx",
      errors: [{ messageId: "unkeyed" }],
    },
    {
      code: "window.alert('Are you sure you want to delete this?')",
      filename: "src/components/Foo.tsx",
      errors: [{ messageId: "unkeyed" }],
    },
    // A file NOT covered by IGNORED_FILE_PATTERNS (e.g. named similarly to a
    // legal page but is real product UI) stays linted.
    {
      code: "const x = <p>Suggested terms</p>",
      filename: "src/components/CandidateTermsPanel.tsx",
      errors: [{ messageId: "unkeyed" }],
    },
  ],
})
