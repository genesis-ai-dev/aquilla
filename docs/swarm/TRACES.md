# SWARM TRACES — i18n coverage

## BLOCKERS (surface to user)
- [OPEN] (email-locale) Email localization is architecturally blocked: no `users.locale`
  column, no worker reads Accept-Language, `aquilla-locale` is client localStorage only.
  Sends are async so only the ACTOR's locale is in scope, not the recipient's — and invite
  recipients often have no user row. Needs a schema migration + a product decision on what
  locale an invite is sent in. — auth-worker/src, sync-worker/src
- [OPEN] (permission-denied-alert-contract) WS-14 changed the shared
  `PermissionDeniedAlert` component's props: `action: string` → `action: MessageKey`,
  `requiredRole?: string` → `requiredRoleLevel?: RoleLevel` (src/components/
  PermissionDeniedAlert.tsx), so a caller can't leak untranslated English into an
  otherwise-localized alert. `src/components/ProjectSettings.tsx`'s call site (mine) is
  updated. `src/components/ProjectMembersPage.tsx:480-483` (WS-11's file, forbidden to
  WS-14) still passes the old raw strings (`action="add members to this project"`,
  `requiredRole="Maintainer or higher"`) and now fails `tsc -b --noEmit` with TS2322 —
  the one remaining type error in the tree as of this handoff. Precedent: the
  orchestrator log (WS-02/03 handoff row, 08-12) already resolved one cross-workstream
  `PermissionDeniedAlert` conflict the same way (fix the shared contract, patch the other
  call site at integration). Two-line fix once picked up: `action="projectMembers.<a
  new key naming 'add members to this project'>"` (or a shared key WS-11 mints) and
  `requiredRoleLevel={ROLE.MAINTAINER}` (from `@/lib/frontier/roles`).

## Deferred (decided, not forgotten)
- [OPEN] (marketing) 670 strings across src/pages/Homepage|CaseStudy|PrivacyPolicy.
  SKIP: no marketing render tree mounts I18nProvider and prerender-marketing.ts renders
  once in Node with no locale, so runtime localization is invisible to crawlers. Real
  localization = per-locale prerendered URLs + hreflang. Revisit only if the locale set
  expands toward buyer languages. Residual: 4 keys for the analytics opt-in control.
- [OPEN] (admin) ~50 strings in src/components/admin/**. SKIP: staff-only, operational
  jargon. Recorded as a decision, not neglect.
- [OPEN] (server-contract) 91 API error sentences. Defer the code+params contract change.
  The cheap client-side half is now complete (WS-07, AQU-820): no audited call site
  still shows server text verbatim. What the contract change would BUY is now a
  concrete list — see `server-contract-codes` in the WS-07 section for the three
  distinctions the client had to collapse for want of an error code.

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
- [OPEN] (megafiles) ImportDialog.tsx is 3,618 lines / 14 components. WS-14 (project
  settings) considered this same advice for ProjectSettings.tsx (2,041 lines) and
  deliberately did NOT split it before keying: the file is a single component with
  heavy shared local state (~30 `useState`s feeding one `handleSave`), so a split would
  be a real refactor with its own regression risk, not a mechanical extraction — see the
  WS-14 handoff section below for the reasoning. It stayed one file, fully keyed
  (~330 keys once duplicates were consolidated, not the ~195 originally estimated). The
  advice still holds for whichever wave picks up ImportDialog.tsx.
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
- [DONE] (verbatim-bypass-remainder) All 9 remaining sites were checked
  case-by-case against the DOM. 7 reached the user and are fixed; 2 were false
  positives. See the DONE entries below for what each became.
- [OPEN] (server-contract-codes) Three of the fixes had to COLLAPSE a
  distinction the server does make, because the server expresses it only in
  untranslated prose:
  - `parse-document`: the worker separates "unsupported type" / "image-only or
    encrypted" / "extractor threw" (auth-worker/src/routes/parse-document.ts
    :170,196,201). The client now shows one keyed sentence naming the likely
    causes, because the 422 case interpolates a raw exception and there is no
    code to branch on.
  - `monday`, `termbase`: the server's reason string is the only signal for
    *why* a call failed; the client now shows a per-call-site keyed sentence
    ("Couldn't save the Monday board link.") which says WHAT failed, not why.
  Each is a strictly better user-facing outcome than untranslated server prose,
  but the lost precision is real and comes back only with the deferred
  `server-contract` item (error CODE + params). Do not "fix" these by
  re-introducing the passthrough.
- [OPEN] (approve-changeset-unkeyed) `src/pages/ApproveChangeset/ApproveChangeset.tsx`
  now uses keyed error messages but the REST of the page is still hardcoded
  English (0 other `t()` calls in the file). It is a standalone route with no
  owning workstream — nobody's sweep currently includes it.
- [OPEN] (monday-section-unkeyed) Same shape: `MondayIntegrationSection.tsx` and
  `OrgSettingsMonday.tsx` now render translated errors, but their own labels and
  the `Sync failed: {err}` / `Sync failed{: reason}` notice built inline at
  MondayIntegrationSection.tsx:274,278 are unkeyed and still interpolate raw
  server text from `MondaySyncResult.error` (a 200-response field, so it never
  passed through `readError`). That notice is the one remaining raw-server-text
  path in the Monday surface.
- [OPEN] (dev-login-message) `devLogin()` in src/lib/frontier/auth.ts still
  throws `Dev login failed (${res.status})`. Left alone deliberately: it is
  `import.meta.env.DEV`-gated and never reachable in a production build.

## WS-14 handoff (AQU-832, project creation / settings / sharing)

Scope: `ProjectCreateDialog.tsx`, `SharePanel.tsx`, `ProjectSettings.tsx` + its
`ProjectSettings/*` sub-panels (`SettingsNav`, `ValidationSettingsSection`,
`DecaySettingsSection`, `AudioMediaStrategySection`, `SourceLinkSection`,
`LanguagesSection`, `ExperimentalFlagsSection` — already fully keyed by a prior wave,
verified not re-touched), and `PermissionDeniedAlert.tsx`'s project-settings call site.
Namespace `projectSettings`, ~330 keys (not the ~195 originally estimated for
ProjectSettings.tsx alone — the audit undercounted; ProjectCreateDialog.tsx and
SharePanel.tsx together contributed roughly as many again).

- [DONE] (formatList-verified) The brief's structural blocker #1 — "verify a prior wave
  converted the 'Saved: X, Y, Z.' call site to `formatList`" — was already true
  (`ProjectSettings.tsx:812-813` pre-dates this wave). What was NOT done: the 32
  `changedFieldLabels.push("lowercase english")` field-noun literals feeding that list.
  All 32 are now `t("projectSettings.field.*")` or reuse an existing FieldLabel/section
  key (see the no-duplicates note below). The `>3 changed` branch ("Saved N changes: …
  +M more.") is now `plural({ other: "Saved {count} changes: …" })` —
  `projectSettings.save.savedMany` — since it wasn't counted-string-safe before (a raw
  template literal with no CLDR forms).
- [DONE] (permission-denied-alert) Structural blocker #2. `PermissionDeniedAlert.tsx`'s
  `action`/`requiredRole` props were raw `string`s a caller could (and did) pass
  untranslated English into. Now `action: MessageKey` and `requiredRoleLevel?: RoleLevel`
  — the component resolves both itself via `t()`/`resolveRoleName()`, so a caller
  physically cannot pass raw English and have it compile. New composed key
  `projectSettings.permission.roleOrHigher` ("{role} or higher") reuses
  `resolveRoleName()`/`common.role.*` rather than minting a duplicate "Maintainer"
  label, per the brief's "roles are done, don't mint labels" instruction — same pattern
  now covers the two `sharedDisabledTooltip`/`renameDisabledTooltip` strings on
  ProjectSettings.tsx that also used to say "Maintainer or higher" by hand. This is a
  **shared component** — see the BLOCKERS entry above for the one cross-workstream call
  site (ProjectMembersPage.tsx, WS-11) this leaves broken until picked up.
- [DONE] (no-duplicates-sweep) `no-duplicates.test.ts`'s third assertion
  ("does not let one exception excuse a second unrelated collision") turned out to be a
  **hard block** on any 2+-key unexcused collision, not the warn-only first assertion the
  doc narrative leads with — this wave's first ~250-key draft tripped it 3 different ways
  (SharePanel's "Loading…" vs `common.loading`, a stray "Add" vs `common.add`, and a
  breadcrumb "Project" vs `common.project`), then a systematic audit found 30 more
  collision groups once the whole file was written. Resolution split two ways: (1)
  **within `projectSettings` itself** — mostly a Title-Case FieldLabel and a lowercase
  `field.*` delta-list noun for the same concept (e.g. "Model"/"model",
  "Bible resources"/"Bible resources") — consolidated onto ONE key each (13 nouns
  deleted from `field.*`, the call site now reuses the label/section key; the delta-list
  sentence loses its all-lowercase styling for those items — e.g. "Saved: Model, Max
  Tokens." rather than "Saved: model, max tokens." — a minor, accepted English cosmetic
  regression, not a translation-fidelity one). "Target language"/"Source language"/
  "Project name" each had a THIRD, sentence-case copy in `ProjectCreateDialog.tsx` too —
  also consolidated onto the settings-page Title-Case key, so the create dialog's
  labels are now Title Case where they used to be sentence case (see
  `ProjectCreateDialog.extraLanguages.test.tsx`, updated). (2) **cross-namespace**, where
  the colliding key lives in a namespace this wave is forbidden to edit (audio/
  autopilot/editor/fileDetails/nav/search) — 15 reviewed entries added to
  `duplicate-exceptions.ts`, each justified by a genuine surface/role difference (a
  settings-card heading vs a nav-title, a term of art vs an everyday word), never by
  case alone (the doc explicitly forbids that reason, and it's checked mechanically —
  `no-duplicates.test.ts`'s second assertion hard-fails a case-only-justified entry the
  moment the string stops colliding).
- [DONE] (audio-media-labels) `AUDIO_MEDIA_STRATEGY_LABELS` in
  `src/lib/parsers/types.ts` (a pure-lib data table, only consumed by
  `AudioMediaStrategySection.tsx`) changed from `{ name, description }` string pairs to
  `{ nameKey, descriptionKey }` `MessageKey`s, mirroring `roleNameKey()`/
  `roleDescriptionKey()` in `src/lib/frontier/roles.ts` — same "pure lib returns a
  descriptor, caller resolves it" shape already established there.
- [DEFERRED] (monday-trio) `MondayIntegrationSection.tsx` + `MondayLinkedView.tsx` +
  `MondayMappingEditor.tsx` (~50 strings, per the audit's own scope call) — left
  entirely unkeyed, per instruction. Added a SWARM-TODO comment naming the deferral at
  the top of `MondayIntegrationSection.tsx` so the next wave finds it without re-auditing.
- [SKIPPED] (termbase-sharing) `TermbaseSharingSection.tsx` — gated behind
  `SHOW_TERMBASE_SHARING_IN_SETTINGS = false` in `ProjectSettings.tsx`; per instruction,
  untouched.
- [SKIPPED] (local-models) `ProjectSettings/LocalModelsSection.tsx` — per instruction,
  this is dead code from the settings surface's perspective (it actually mounts on
  `/preferences`, another agent's area per `docs/swarm/ORCHESTRATION.md`); untouched.
- [DEFERRED] (settings-search-keywords) `ALL_SECTIONS[].label` in `ProjectSettings.tsx`
  is fully keyed (also reused as the matching Card's `<CardTitle>` where the text
  matches exactly). `ALL_SECTIONS[].keywords` — the ~110-string English-only
  search-matching index the audit counted separately from the 483 — was left as
  literal English on purpose: it's compared against the raw (English) search-box input,
  not rendered, so keying the array without ALSO building a per-locale keyword index and
  reworking the match to try every locale's terms would be pure catalog bloat with zero
  UX effect. Real localization of settings search is its own follow-up (translate the
  query, or maintain keyword lists per locale) — flagging, not silently skipping.
- [DEFERRED] (zod-validation-messages) `src/lib/forms/schemas.ts`'s `requiredString()`/
  `optionalString` build a hardcoded `"${label} is required"` message consumed by
  `<FieldError>` across MANY forms outside this wave's scope (org create/rename, team
  create, login, onboarding steps, AddConceptDialog, provider sections — see the
  file's other callers). `ProjectCreateDialog.tsx`'s own two `superRefine` custom
  messages ("Target language is required", "Choose an upstream project") ARE this
  wave's own code and are now keyed (`projectSettings.create.validation*`), built via a
  new `buildProjectSchema(t)` — `useMemo`'d in the component since Zod schemas are
  normally built at module scope where `useT()` isn't callable. The shared
  `requiredString()`/`optionalString` helper itself was left untouched: fixing it
  properly needs either a `MessageKey`-accepting variant or routing `FieldError`'s
  rendering through `t()`, and touching it here would silently affect every other
  workstream's forms without their review. Flagging for a coordinated follow-up, not
  fixing in isolation.
- [DONE] (permission-alert-test) Added two explicit regression tests to
  `PermissionDeniedAlert.test.tsx` (`AQU-832: resolves \`action\` through the message
  catalog rather than rendering it verbatim`, and the equivalent for
  `requiredRoleLevel`) — the brief specifically asked for proof the component renders
  translated action/role rather than raw English, which is the failure mode the old
  `string` props allowed.
- [DONE] (eslint-i18n-guard) `eslint-suppressions.json` pruned for every file this wave
  touched — `i18n/no-unkeyed-string` now reports 0 remaining unkeyed strings in
  `ProjectCreateDialog.tsx`, `SharePanel.tsx`, `ProjectSettings.tsx`, and all 5 keyed
  `ProjectSettings/*.tsx` sub-panels (2 residual literal API path fragments in
  `ProjectSettings.tsx`, `/chat/completions` and `/models`, marked
  `// i18n-exempt` — technical path text inside `<code>`, not prose).

## [DONE] resolved traces
- [DONE] (AQU-820) `src/lib/i18n/standalone.ts` — the provider-less `t()` that
  WS-07 had copy-pasted into `user-error.ts` and `frontier/auth.ts` is now one
  shared module, and both files import it. Nine more non-React modules needed
  the same helper; a tenth copy was not the answer.
- [DONE] (AQU-820) 7 verbatim-bypass sites fixed. The shape is the same
  everywhere: the thrown `.message` is now a client-chosen keyed sentence, and
  the server's raw string moves to `.cause` (or `UserError.raw`) so DevTools
  keeps it.
  - `SourceLinkSection.tsx` → throws `UserError`, catch renders
    `toUserFacingError(err, "project").message` (which also covers the offline
    case the old `err.message` catch showed as "Failed to fetch").
  - `monday/api.ts` → `readError()` takes a `MessageKey`; 11 new
    `error.monday.*` keys replace 11 hardcoded English fallbacks.
  - `terminology/subscriptions-api.ts` → same, 7 `error.termbase.*` keys. Its
    old fallbacks were bare diagnostics (`publishTermbase failed: HTTP 500`),
    i.e. worse than the server text they were falling back from.
  - `agent/artifact-upload.ts` → `common.uploadFailed` + new
    `error.upload.emptyFile`/`tooLarge` (the two client-side pre-checks were
    also unkeyed English).
  - `frontier/parse-document.ts` → new `error.parseDocument.failed`. The 200-
    with-no-`text` branch ("Worker returned empty text.") folds into the same
    message: identical dead end for the user.
  - `sync/archive.ts` → `parseError()` returns
    `messageForStatus(status, raw, "project").message`. `linkProjectSource()`
    now really throws `UserError`, which its doc comment had claimed all along.
  - `ApproveChangeset.tsx` → 3 new `error.changeset.*` keys; the status-based
    branch it already had is now the ONLY branch.
- [DONE] (AQU-820) 2 of the 9 audited sites are FALSE POSITIVES, verified, no
  change made — same reason as `cloud-projects.ts:366`:
  - `frontier/admin.ts:142` — `readError(res)`'s return feeds
    `new UserError(res.status, <here>)`, i.e. the `rawBody` parameter. It lands
    on `.raw`/`.cause`, never on `.message`.
  - `diarization/run-diarization.ts:114` — `ProjectWorkspace` stores the thrown
    message in `diarizeError` but only ever reads it as a BOOLEAN (line 4913,
    picking the keyed `nav.fileMenu.diarizeFailed` label). The string itself
    never renders. The module's other messages ("diarization cancelled",
    "diarization timed out") confirm the intent: these are diagnostics.
- [DONE] (AQU-820) The 4 non-keyed hardcoded fallbacks are keyed, plus
  `login()`'s own messages which wave 2 deliberately left:
  `auth.login.failed` (new) covers Login.tsx, FrontierLoginForm, and both of
  `login()`'s non-401 throws; `auth.login.invalidCredentials` (new) covers the
  401. FrontierSignupForm reuses `auth.signup.failedGeneric` and
  FrontierForgotPasswordForm reuses `auth.resetPassword.failedToSend` rather
  than minting near-duplicates. `login()` no longer puts `(${res.status})` in
  the visible message — `FrontierAuthError.status` already carried it.
  Regression coverage: the 6 lib/page tests that ASSERTED the old passthrough
  are inverted (they encoded the bug), and `parse-document.test.ts` is new.
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
- [DONE] (ws07-remainder) All 9 closed: 7 fixed, 2 false positives (frontier/admin,
  diarization/run-diarization — neither string reaches the DOM). See the WS-07 section.
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
