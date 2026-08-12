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
- [OPEN] (server-contract) 91 API error sentences. Defer the code+params contract change.
  The cheap client-side half shipped in wave 2 (WS-07, AQU-820) — see the WS-07 section
  below for what landed and what's left of the 36 `body.error` call sites.

## Known hazards for any agent touching these
- [OPEN] (control-flow-string) OrgBreadcrumb.tsx:115 branches on `section !== "Projects"`,
  5 callers pass that literal. Keying it naively duplicates a crumb in every non-English
  locale. Translating this string CHANGES BEHAVIOUR.
- [DONE] (keyed-but-dead) The 6 sites where a fully-translated key existed but
  `err.message` won at runtime are fixed — see the WS-07 section below. One more,
  structurally identical, pattern remains at EditorTable.tsx:4407/4481
  (`editor.write.saveFailed` / `saveSourceFailed`) — left alone because the editor
  namespace and this file are WS-06 territory, not because it's fine.
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

## WS-07 handoff (AQU-820, error-message i18n wiring)
- [OPEN] (verbatim-bypass-remainder) `messageForStatus()` (src/lib/errors/user-error.ts) is
  now keyed and every UserError-throwing call site inherits translation for free. The
  auth.ts cluster (6 sites) and 6 keyed-but-dead sites are fixed (see DONE below). Of the
  ~36-site audit, these still lift `body.error`/`body.detail`/`body.message` from a server
  response and show it verbatim, unlocalized, instead of routing through
  messageForStatus/UserError or a keyed frame — not verified case-by-case whether each
  variable actually reaches the DOM, so treat as "needs a look", not "confirmed bug":
  - src/components/ProjectSettings/SourceLinkSection.tsx:92
  - src/lib/monday/api.ts:35-36
  - src/lib/terminology/subscriptions-api.ts:36
  - src/lib/agent/artifact-upload.ts:70
  - src/lib/frontier/admin.ts:142
  - src/lib/frontier/parse-document.ts:29
  - src/lib/sync/archive.ts:78
  - src/lib/diarization/run-diarization.ts:114
  - src/pages/ApproveChangeset/ApproveChangeset.tsx:74
  Also non-keyed (not server-text, but still untranslated hardcoded fallback strings),
  same "err instanceof FrontierAuthError ? err.message : <hardcoded>" shape as the
  auth.ts/Login.tsx precedent this wave deliberately left alone:
  - src/components/git-import/FrontierLoginForm.tsx:55 ("Login failed")
  - src/components/git-import/FrontierSignupForm.tsx:143 ("Sign up failed")
  - src/components/git-import/FrontierForgotPasswordForm.tsx:46 ("Failed to send reset email")
  - src/pages/Login.tsx:59 ("Login failed") — login()'s own messages
    ("Invalid username or password" etc.) were kept as-is per the brief: they're the
    in-file precedent for "never show raw server text", just not yet keyed themselves.
  `src/lib/sync/cloud-projects.ts:366` was in the original grep hit but is a false
  positive — it already routes through `UserError`, which never puts the raw body in
  `.message` (only `.raw`/`.cause`), so it needed no change.

## [DONE] resolved traces
- [DONE] (AQU-820) `messageForStatus()` in src/lib/errors/user-error.ts — the 9 hardcoded
  HTTP-status sentences (400/401/403/404/409/410/429/5xx/default) plus the 2 in
  `toUserFacingError` (offline, generic fallback) are now keyed under `error.network.*` in
  src/lib/i18n/namespaces/error.ts. Runs outside React, so it reads the active locale via
  a small `t()` that mirrors I18nProvider's provider-less fallback (readStoredLocale +
  CATALOGS + translate). Every UserError/messageForStatus caller across the app gets
  translated messages for free.
- [DONE] (AQU-820) auth.ts's 6 `body.error`/`body.detail` bypass sites (register,
  redeemAccessLink, requestPasswordReset, verifyResetToken, verifyEmail, resetPassword)
  now throw client-controlled, keyed messages instead of raw server text — login()'s
  never-surface-server-body pattern applied to the rest of the file. register() is the one
  exception that still shows server detail (woven into a translated frame,
  `auth.signup.failedWithDetail`), because a username/email-conflict reason is genuinely
  actionable and the server doesn't enumerate a fixed set of values for it.
  redeemAccessLink()'s fix also closes a latent oracle risk: the function used to show
  whatever `body.error` the server sent, which could in principle vary by failure reason
  even though the file's own doc comment requires every failure to look identical.
- [DONE] (AQU-820) 6 keyed-but-dead sites fixed: AccessLinkPage.tsx (the confirmed
  example — removed a vestigial `/^Login failed/` regex check that made
  `auth.accessLink.genericError` unreachable), ResetPassword.tsx x2
  (`auth.resetPassword.failedToSend`/`failedToReset`), VerifyEmailPage.tsx
  (`auth.verifyEmail.verificationFailed`), VideoAttachmentDialog.tsx
  (`common.uploadFailed` — was showing raw IndexedDB exceptions), AssignModal.tsx
  (`dialog.assign.error.unknown`). The ResetPassword/VerifyEmailPage sites needed no
  component-side edit: their existing `err instanceof FrontierAuthError ? err.message : t(…)`
  ternary was already correct once auth.ts stopped putting raw server text in `.message`.
  Regression coverage: src/lib/frontier/auth.test.ts (server body text no longer reaches
  `.message`, even when the server varies it) and
  src/components/VideoAttachmentDialog.test.tsx (keyed message wins over a raw thrown
  error).

## Quality / polish
- [OPEN] (dup-rule-name) EditorTable.tsx:7169 renders `{rule.name}` immediately before
  `— {inf.message}`, which already contains the name. It prints twice. Pre-existing bug
  found during the audit.

## [DONE] resolved traces

## Wave 1 additions
- [OPEN] (load-flakes) `src/components/PermissionDeniedAlert.test.tsx` and
  `src/context/OrgContext.test.tsx` pass in isolation but fail intermittently under
  full-suite parallel load. THREE separate swarm agents reported these as "pre-existing
  failures" when they are load flakes. Every agent brief now warns about them. Real fix:
  isolate the shared localStorage/DOM state these tests race on. Until then they can mask a
  genuine regression.
- [OPEN] (stale-hashes) `source-hashes.json` does not exist yet. WS-01's staleness detection
  only activates for a key once an import touches it, so English that changes under an
  already-translated key is still undetected today. The wave-4 re-translation pass will
  populate it. Latent gap, not live protection.
- [DONE] (autopilot-aria) `autopilot.inspector.activity.logAria` now carries its own context
  entry in `autopilot.ts`, and `LEGACY_CONTEXT_GAPS` is empty. The carve-out's self-correcting
  check stays exercised: `catalogContextIssues()` takes the gap list as an optional argument,
  so the stale-exemption path is still covered with the real list empty.
- [OPEN] (lint-blind-spots) The ESLint rule cannot see template literals with expressions,
  strings in hoisted const arrays, or `.ts` files. Those are exactly the mechanisms behind the
  most visible leaks — typed `MessageKey` props (WS-05/WS-06) are the compensating control.
- [DONE] (import-data-loss) i18n:import now merges. Verified: 2-key partial import preserves
  all 1,335 translations; `--replace` retains the destructive path.

## Wave 2 additions
- [DONE] (permission-alert-flake) Fixed: the test gated on prop-derived text then counted
  styled spans, while the account name arrived from an async session. Waits on the async
  value now. Full suite 7121/7121.
- [OPEN] (orgcontext-flake) `src/context/OrgContext.test.tsx` is the remaining known load
  flake — same class, not yet diagnosed. Passes 5/5 in isolation.
- [OPEN] (movetocorpus) `MoveToCorpusDialog` inside ProjectWorkspace.tsx (~line 6600) still
  hardcodes "Move to corpus" / "Ungrouped" / "Create a corpus" / "Corpus name". Out of WS-05's
  named scope. Cancel/Save there can reuse common.cancel/common.save.
- [OPEN] (derivetitle-parallel-source) `editor.navTitle.*` is a parallel English source for
  words `nav.*` also owns; one collision ("Terminology") already surfaced and was deduped.
  Several more (`Members`, `Teams`, `Project settings`) will collide once the org/settings
  sweeps add their keys. Decide ownership before wave 4 rather than minting exceptions.
- [OPEN] (ws07-remainder) ~9 verbatim `body.error` sites remain, listed in WS-07's handoff
  section: SourceLinkSection, monday/api, terminology/subscriptions-api, agent/artifact-upload,
  frontier/admin, frontier/parse-document, sync/archive, diarization/run-diarization,
  ApproveChangeset.
- [OPEN] (ungrouped-sentinel) `group-by-corpus.ts` / `section-index.ts` "Ungrouped" is a
  load-bearing sentinel compared by `AssignModal.tsx:293,608` and `ExpandableFileList.tsx:132`.
  Needs a stable identity key split from the display label before it can be localized.

## Wave 2 verification (live Arabic run, integration branch)
Confirmed FIXED on screen: Terminology → المصطلحات · Setup: 2/4 → الإعداد: 2/4 ·
Synced → متزامن · No file open → لا ملف مفتوح · Comments → التعليقات · empty state fully Arabic.
Still English, each attributable to a LATER scheduled wave (not a wave-2 miss):
- [OPEN] (import-button) The top-left "Import" button lives in `ImportDialog.tsx` (3,618 lines,
  ~183 keys) — the import/export area, wave 4. WS-05 keyed `nav.workspaceActions.import`
  (→ استيراد) for the workspace-action registry, which is a different control.
- [OPEN] (breadcrumb) "Editor / Dev Project / Dev Org / All organizations" — "All organizations"
  is `src/components/org/OrgHome.tsx:723`, the org/teams area (wave 3/4). "Dev Project" and
  "Dev Org" are DATA and correctly stay untranslated.
