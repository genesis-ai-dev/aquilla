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

## Quality / polish
- [OPEN] (dup-rule-name) EditorTable.tsx:7169 renders `{rule.name}` immediately before
  `— {inf.message}`, which already contains the name. It prints twice. Pre-existing bug
  found during the audit.

## [DONE] resolved traces
