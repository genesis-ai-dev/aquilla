# SWARM TRACES — i18n coverage

## BLOCKERS (surface to user)
- [OPEN] (email-locale) Email localization is architecturally blocked: no `users.locale`
  column, no worker reads Accept-Language, `aquilla-locale` is client localStorage only.
  Sends are async so only the ACTOR's locale is in scope, not the recipient's — and invite
  recipients often have no user row. Needs a schema migration + a product decision on what
  locale an invite is sent in. — auth-worker/src, sync-worker/src

## Deferred (decided, not forgotten)
- [OPEN] (marketing) 670 strings across src/pages/Homepage|CaseStudy|PrivacyPolicy.
  SKIP: no marketing render tree mounts I18nProvider and prerender-marketing.ts renders
  once in Node with no locale, so runtime localization is invisible to crawlers. Real
  localization = per-locale prerendered URLs + hreflang. Revisit only if the locale set
  expands toward buyer languages. Residual: 4 keys for the analytics opt-in control.
- [OPEN] (admin) ~50 strings in src/components/admin/**. SKIP: staff-only, operational
  jargon. Recorded as a decision, not neglect.
- [OPEN] (server-contract) 91 API error sentences. Defer the code+params contract change;
  the cheap client-side half (36 `body.error` call sites) ships in wave 2.

## Known hazards for any agent touching these
- [OPEN] (control-flow-string) OrgBreadcrumb.tsx:115 branches on `section !== "Projects"`,
  5 callers pass that literal. Keying it naively duplicates a crumb in every non-English
  locale. Translating this string CHANGES BEHAVIOUR.
- [OPEN] (keyed-but-dead) 6 sites are fully translated yet render English because
  `err.message` wins at runtime (e.g. AccessLinkPage.tsx). Coverage metrics overstate
  reality until these are fixed.
- [OPEN] (bidi) "cells · 0 translated (0%) 3" reorders under RTL — that trailing number is
  the bidi algorithm, not a missing translation. Needs FSI/PDI isolation, not a key.
- [OPEN] (megafiles) ImportDialog.tsx is 3,618 lines / 14 components; ProjectSettings.tsx
  ~195 keys. Split BEFORE keying, not during.
- [OPEN] (stale-surface) The `project-settings` screenshot surface is already wrong: its
  driver stops at /settings which now renders an 8-card index, not the ~150 form strings
  its notes promise. Nothing detects this.

## WS-02 / WS-03 handoff
- [OPEN] (guard-forbidden-suppressions) `eslint-suppressions.json` (WS-02's ratchet
  baseline, generated against the tree as of this commit) still carries entries for
  `src/components/{TerminologyPage,RulesPage,RuleCreateDialog,RuleSuggestDialog}.tsx` —
  files WS-03 is deleting. Not hand-edited out: the suppressions file is meant to stay a
  pure ESLint-generated artifact. Once WS-03's deletion lands, run
  `npx eslint --prune-suppressions 'src/**/*.tsx'` and commit the result — the rule will
  no longer find those files, so pruning drops the stale entries automatically. No
  manual JSON surgery needed.

## Lint-guard limitations (WS-02, i18n/no-unkeyed-string)
- [OPEN] (guard-template-exprs) `tools/eslint-rules/no-unkeyed-string.cjs` cannot see
  template literals WITH expressions (`` `Deleted ${n} files` ``) — only zero-expression
  templates are treated as static strings. Interpolated strings are exactly the ones that
  need catalog placeholders and plural categories, so this is a real coverage hole. Left
  out deliberately: flagging static quasis inside an interpolated template raises the
  false-positive rate a lot (`` `${label}:` `` would report the literal `":"`).
- [OPEN] (guard-hoisted-arrays) Strings in const arrays/objects hoisted outside component
  scope (`const ROLE_OPTIONS = [{ label: 'Owner' }]`, e.g. `LINK_ROLE_OPTIONS` in
  ProjectMembersPage.tsx) are invisible to the rule — no data-flow analysis, so it cannot
  know `.label` later reaches JSX. These two gaps are exactly the mechanisms behind the
  most visible remaining leaks. A later workstream should close them via a typed
  `MessageKey` prop convention rather than extending this AST-only rule.
- [OPEN] (guard-ts-scope) Only `src/**/*.tsx` is linted. User-visible strings assembled in
  plain `.ts` files (error messages in `src/lib/*` that surface in toasts; worker response
  strings the UI renders verbatim) are out of scope for this client-side rule.
- [OPEN] (guard-suppression-granularity) ESLint's bulk suppressions are counted per
  (file, rule), not per line — exceeding a file's suppressed count re-reports every
  suppressed violation in that file as an error (measured: 1 new string in a 20-violation
  file surfaced 21 errors). Moving/reordering code in a suppressed file does not trip it;
  the count is a ceiling, not a fingerprint.

## Quality / polish
- [OPEN] (dup-rule-name) EditorTable.tsx:7169 renders `{rule.name}` immediately before
  `— {inf.message}`, which already contains the name. It prints twice. Pre-existing bug
  found during the audit.

## [DONE] resolved traces
