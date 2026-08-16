# SWARM TRACES — i18n coverage completion

Companion to `docs/swarm/I18N-COVERAGE-ORCHESTRATION.md`. Open items an agent (or the
orchestrator after context compaction) picks up. Never delete a trace — mark it `[DONE]`.

See also the older `docs/swarm/I18N-TRACES.md` from the AQU-511/AQU-832 waves; its BLOCKERS
(email locale, marketing/admin skips, server error-code contract) are still open and are
**not** re-litigated here.

## BLOCKERS (surface to user)

<!-- [OPEN] (id) description — blocker / how-to-fix — file:line -->

## Detector blind spots (WS-SCAN owns closing these)

- [OPEN] (tmpl-expr) Template literals with expressions are never flagged by
  `i18n/no-unkeyed-string`. These are the strings that most need catalog placeholders and
  plural categories, so the hole is substantive, not cosmetic. —
  `tools/eslint-rules/no-unkeyed-string.cjs`
- [OPEN] (hoisted-const) Strings in `const` arrays/objects outside component scope are
  invisible to the rule (no data-flow analysis). — same file
- [OPEN] (non-tsx) The rule is scoped to `src/**/*.tsx`; UI-facing strings in `src/**/*.ts`
  (`src/lib/**` toast/error/option tables) are entirely unguarded. — `eslint.config.js`
- [OPEN] (ignored-files) `IGNORED_FILE_PATTERNS` exempts admin/legal/dev surfaces by policy.
  The scan must still enumerate them so the exemption stays an auditable decision. —
  `tools/eslint-rules/allowlist.cjs`

## Deferred (decided, not forgotten)

<!-- carried forward from I18N-TRACES.md; re-confirm before changing -->
- [OPEN] (marketing) ~670 strings in `src/pages/Homepage|CaseStudy|PrivacyPolicy`. SKIP:
  prerendered in Node with no locale, so runtime `t()` is invisible to crawlers. Real
  localization = per-locale prerendered URLs + hreflang.
- [OPEN] (admin) ~50 strings in `src/components/admin/**`. SKIP: staff-only operational jargon.
- [OPEN] (server-contract) 91 API error sentences need a code+params contract change server-side.

## Quality / polish

<!-- [OPEN] (id) description — file:line -->

## [DONE] resolved traces
