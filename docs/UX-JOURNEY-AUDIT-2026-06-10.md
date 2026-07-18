# codex-web-app (Aquilla) — UX, User-Journey & Business-Logic Audit

_Date: 2026-06-10 · Scope: user experience, end-to-end journeys, and the business logic underpinning them · Analysis only, no code changed · Companion to `docs/AUDIT-2026-06-10.md` (engineering) and `docs/SECURITY-NOTES-2026-06-10.md` (security)._

**Method.** Six parallel deep-dive passes (surface map, new-user journey, core translation journey, import/export/collaboration, business-logic placement, copy/feedback/measurement) plus a spec/persona pass over `~/frontierrnd/aquilla-specs/` and `docs/`. Every finding carries file:line evidence and a **FACT** (verified in code) vs **JUDGMENT** (inference) label. The four headline Critical claims were independently re-verified at the source before publication. What I cannot verify — real user behavior, drop-off rates, actual abuse — is flagged as such; there is almost no product analytics to consult (see F-M1).

**Coverage note.** Depth went to the core 20%: auth/onboarding, the cell-editing/validation loop, import/export, sharing, and oversight rollups. Lighter review: audio/voice studio internals, video attachments, terminology UI details, admin console, Tauri desktop shell.

---

## 1. Executive Summary

**Grade: C+.** The happy path is genuinely strong — time-to-first-value is ~13 interactions with zero waiting and zero required configuration, the invite flow is best-in-class, sync status is honestly surfaced, and lossy exports are labeled. But the edges lie to users in ways that hit exactly this product's value proposition ("scale translation without losing trust"): the password-reset email links to a page that does not exist, so account recovery is 100% broken; deleting a file permanently destroys recorded audio behind a dialog that says "the underlying data is not deleted"; "Validated %" — the one number oversight personas consume — inflates because the per-project validation threshold is enforced nowhere on the server; and a reviewer/viewer gets a fully editable editor whose writes silently die in a `console.warn`. **Top 3 risks:** (1) users permanently locked out of accounts (reset dead end + no email verification = no recovery path at all); (2) trust collapse with the credibility-critical Paratext cohort via silently lossy USFM round-trips, vanishing partial-import reports, and the untruthful delete dialog; (3) unmetered money/abuse exposure on the OpenRouter proxy (any registered user, any model, no quota). **Top 3 opportunities:** (1) account recovery and a real `/login` route are nearly free — the server side is already built; (2) defining "validated" once, server-side, threshold-aware, instantly repairs the manager trust signal across all four surfaces that currently disagree; (3) a minimal notification loop (mentions/replies) converts comments from write-only into the coordination compression the positioning promises — the @mention UI already exists, it just notifies no one.

---

## 2. Product Map

### 2.1 Purpose & users

Aquilla is a browser-first collaborative Bible-translation workspace. Bilingual experts translate scripture cell-by-cell with AI assist, terminology, audio, and back-translation; managers/owners who **cannot read the target language** consume trust signals (validated %, health, progress). First cohort: SIL/UBS Paratext consultants — USFM round-trip fidelity is make-or-break.

**Personas (from `~/frontierrnd/aquilla-specs/01-personas-and-roles.md`):**

| Persona | Role (level) | Reads target lang? | Lives in |
|---|---|---|---|
| Translator (office/field) | contributor (400) | Yes | Cell editor, voice recording |
| Reviewer/consultant | reviewer (300) | Yes | Editor read-mode, validation, comments |
| Project lead | project_lead (500) | Yes | Settings, rules, assignment |
| Project admin / owner | maintainer (600) / owner (700) | Often no | Members, settings, export |
| Org admin (director/VP/onboarding) | org owner | **No** | Dashboard rollups, members, deadlines |
| Donor/observer | viewer (100) | No | Read-only editor, comments |

Key spec invariants: 7-rung role ladder with **max-wins** resolution across direct/group/org/creator paths (AD-12); validation policy = count threshold × role floor × named users; field staff on unreliable connections (CP-1 offline outbox); fully localizable UI (CP-7 — currently English-only).

### 2.2 Surface inventory

29 routes (4 public, 25 authed), ~25 dialogs, 2 transactional emails (password reset, project invite — Resend, best-effort). Entry: edge worker serves marketing `homepage.html` vs app `index.html` on an `aq_hint` cookie ([worker/index.ts:31-41](worker/index.ts)). Onboarding: 6-step wizard (`/onboarding`), re-launchable product tour, per-project setup checklist. Designed empty states for editor/no-file/no-files ([CellAreaPlaceholder.tsx](src/components/CellAreaPlaceholder.tsx)). No toast library — feedback is inline banners + two always-visible sync indicators. No error boundary, no 404 page, no in-app feedback channel. Full route/dialog tables live in the agent inventory; nothing user-facing was found orphaned or unreachable (the one prior QA blocker, `/project/:id/voice`, is now a real route — [App.tsx:162](src/App.tsx:162)).

### 2.3 Core journeys (as implemented)

**J1 — Sign up → first value.** Homepage → `/onboarding` (Welcome → Privacy → Sign-up form → Name → Create project → Ready) → workspace empty state → Import (file or eBible, no key needed) → click cell → type. ~13 interactions, no email wait, no API key. Invite path is faster (~6). **No email verification exists; no `/login` route exists** — returning users re-walk the signup wizard.

**J2 — Translate → validate → oversee.** Edit cell (TipTap, commit on 1.2s idle/blur) → optimistic patch → IndexedDB outbox → `POST /events` → AD-2 first-child-of-parent guard → projection (`cells`, `files` counters) → DO broadcast → peers revalidate. Reviewer clicks validation circle → `cell_validators` row → `cells.validated` flips at **COUNT ≥ 1** ([event-projection.ts:480-487](sync-worker/src/events/event-projection.ts)). Rollups: `files.filled_count/approved_count` → ProjectOverview bars → org portfolio.

**J3 — Import → edit → export (the Paratext trust loop).** Byte-preserving lossless USFM parse, original bytes in server side-car → translated verse spans overridden at export, untouched bytes pass through ([usfm-lossless.ts:280-332](src/lib/parsers/usfm-lossless.ts), [export-route.ts:152-179](sync-worker/src/events/export-route.ts)).

**J4 — Share → join → collaborate.** SharePanel invite (link or email label, role ≤ contributor for links) → `/join/:token` with inline auth + auto-redeem → presence/focus-locks via ProjectSync DO → comments (event-sourced, threaded, resolvable).

**J5 — Oversight.** OrgHome stat cards + ProjectOverview progress/validated bars + deadline status + AD-14 derive-on-read health.

### 2.4 Business-logic location map

| Rule class | Authoritative home | Mirrors / drift |
|---|---|---|
| Event authorization (27 kinds) | sync-worker [role-policy.ts](sync-worker/src/events/role-policy.ts) + symbol-branded `authorize.ts` perimeter | Client mirror byte-identical ([src/lib/sync/role-policy.ts](src/lib/sync/role-policy.ts)) — **clean** |
| Role resolution (max-wins) | [project-permissions.ts:103-186](auth-worker/src/services/project-permissions.ts) — single function | 4 copies of level→name map (currently identical) |
| Validation policy (floor/named/self) | sync-worker [route.ts:374-455](sync-worker/src/events/route.ts) — **clean** | — |
| Validation **count threshold** | **NOWHERE server-side** | client-only [section-progress.ts:48-49](src/lib/progress/section-progress.ts); server flips at 1 |
| Progress %s | recomputed 4 ways (projection, portfolio, useHealth, section-progress) | they disagree (F-B2) |
| Entitlements/quotas | **does not exist** | client-side `record-usage.ts` is telemetry, not metering |
| Frozen-project edit block | **client banner only** ([ProjectWorkspace.tsx:2700](src/components/ProjectWorkspace.tsx)) | schema says "block edits" ([schema.sql:112-115](db/postgres/schema.sql)) |
| Permissions UI gating | dead `ProjectPermissions` model, never populated → all-true default ([useProjectPermissions.ts:4-13](src/hooks/useProjectPermissions.ts)) | live model is `syncRole.level` — two models coexist |

### 2.5 Surprises

1. Server-side account-recovery endpoints are **fully built and completely unreachable** ([auth.ts:318-412](auth-worker/src/routes/auth.ts)) — no client page exists for the URL the email sends.
2. An @mention typeahead ships in CommentsPage, `extractMentions` exists — and has **zero callers**; no notification of any kind exists in any worker.
3. `useComments` exposes `deleteComment`/`editComment` with zero UI callers — users can't fix or remove their own comments.
4. The event-authorization perimeter is lint-enforced and the client/server role tables match byte-for-byte — unusually disciplined for an 8-week prototype.

---

## 3. Audit Report

Findings grouped by dimension, severity-first. **C**ritical / **H**igh / **M**edium / **L**ow. FACT unless marked JUDGMENT.

### 3.1 User journeys & flow integrity

- **C — F-J1: Password reset is a dead end; account recovery is 100% broken.** The reset email links to `${BASE_URL}/reset-password?...` ([auth.ts:302](auth-worker/src/routes/auth.ts)) but no client route, page, or worker handler exists anywhere (repo-wide grep; [App.tsx:139-190](src/App.tsx) has no such route and no catch-all) → blank screen. The verify/reset endpoints ([auth.ts:318-412](auth-worker/src/routes/auth.ts)) are built and unreachable. Combined with no email verification (F-J5), a forgotten password = permanently lost account, and a typo'd signup email is undetectable until that day. There is no support contact in the app.
- **H — F-J2: Expired/invalid invite + signed-out user = silent trap that extracts a signup first.** Every preview failure maps to `null` ([invites.ts:89-125](src/lib/sync/invites.ts)) and JoinPage has no error branch for a null preview — "Loading invitation details…" forever ([JoinPage.tsx:48-62,164-168](src/components/JoinPage.tsx)) while presenting signup. The user learns the link is dead only **after** creating an account. (Signed-in users do get a proper error + recovery copy — the branch exists, it's just unreachable pre-auth.)
- **H — F-J3: No `/login` route; returning users re-run the signup wizard.** Homepage "Sign in" → onboarding step 1 → Privacy → form **defaulted to signup** ([SignInStep.tsx:16](src/components/onboarding/steps/SignInStep.tsx)) → after login, still walked through Name + "Create your first project" with existing projects never shown; escape is a small "Do this later" ([ProjectStep.tsx:158-165](src/components/onboarding/steps/ProjectStep.tsx)). JUDGMENT: High — this is every returning user on every new device.
- **M — F-J4: Session-expiry mid-journey reads as data loss.** 30-day JWTs with no refresh and no 401-driven logout; a signed-out-but-onboarded user at `/` gets a fake-empty dashboard (zero-stat cards, "No projects in this org yet") with sign-in buried at the sidebar bottom ([App.tsx:92-99](src/App.tsx), [OrgHome.tsx:46-62](src/components/org/OrgHome.tsx)). Relatedly, `/projects` spins forever when the org/JWT is absent ([ProjectsList.tsx:18-28](src/components/org/ProjectsList.tsx)).
- **M — F-J5: No email verification at all** ([auth.ts:62-130](auth-worker/src/routes/auth.ts) returns a bearer token immediately). Zero-friction (good) but compounds F-J1 into "no recovery path exists in the product."
- **H — F-J6: No mobile handling in the app.** Fixed `w-64` sidebar, `h-screen` flex, no breakpoints ([AppShell.tsx:38-41](src/components/AppShell.tsx)); OrgHome is hard `grid-cols-6`. Invite emails get opened on phones; a mobile invitee who joins lands in a ~134px column. JUDGMENT: High *for the invite landing path specifically*; desktop-first ICP mitigates the rest.

### 3.2 Onboarding & first-run

Healthy overall — this dimension is a strength. TTFV ≈ 13 interactions, 0 waits, 0 keys (eBible import is keyless); designed empty states with a race-condition guard; auto-opening setup checklist; re-launchable tour. Two real findings:

- **L — F-O1:** Signup username field gives no inline requirements; server 409 doesn't say which field collided ([FrontierSignupForm.tsx:101-105](src/components/git-import/FrontierSignupForm.tsx)).
- **L — F-O2:** Wizard ignores existing users entirely (covered by F-J3).

### 3.3 Information architecture & navigation

- **M — F-IA1: Org management is half-hidden.** Org CRUD is implemented but there's no "Organization" nav entry from the dashboard; multi-project invites are reachable only via `/members`, not from project surfaces (v3-audit [03-projects-orgs-membership.md](docs/v3-audit/03-projects-orgs-membership.md) F1–F6 — still open).
- **M — F-IA2: Naming drift across surfaces** — "cell" is the universal noun for what translators call a verse/segment; [AssignModal.tsx:57](src/components/AssignModal.tsx) hedges with "Books (files)"; four names for AI translation ("Run AI completions" / "Complete all" / "Draft AI translations" / "Generate translation"); three approval verbs (validated / approved / confirmed) across cells, terminology, alignments. Details in §3.9.
- **L — F-IA3:** No 404 page; unknown routes render an empty shell.

### 3.4 Interaction & feedback

- **H — F-F1: Core editor write failures are swallowed.** Cell-commit enqueue failure → `console.warn` only ([EditorTable.tsx:1732](src/components/EditorTable.tsx)); same for validate ([:1865](src/components/EditorTable.tsx)), waive ([:1652,1668](src/components/EditorTable.tsx)), BT persist ([ProjectWorkspace.tsx:1297](src/components/ProjectWorkspace.tsx)), import flush-on-close ([ImportDialog.tsx:133,220](src/components/ImportDialog.tsx)). The outbox chip only covers events that *reached* the outbox; these never did. For a product whose core promise is "your translation is saved," silence here is the worst failure mode.
- **H — F-F2: Raw developer errors render to users, systemically.** The network layer throws `` `createProject failed: HTTP 403 — <body>` ``-style strings and ~30 call sites render `err.message` verbatim ([cloud-projects.ts:69](src/lib/sync/cloud-projects.ts) → [ProjectCreateDialog.tsx:110](src/components/ProjectCreateDialog.tsx); [members.ts:127](src/lib/frontier/members.ts) → ProjectMembersPage; Dashboard, ImportDialog ×8, ProjectSettings, SnapshotCreateDialog…). [lib/audio/ai-error.ts](src/lib/audio/ai-error.ts) already demonstrates the right taxonomy pattern — it's just not applied to the rest of the network layer.
- **H — F-F3: No error boundary, no global error capture.** Zero `ErrorBoundary`/`errorElement`/`window.onerror` hits in src; `posthog.captureException` at exactly 2 sites. A render crash is an unreported white screen. (Shared with the engineering audit; repeated here because it's also a UX dead end.)
- **M — F-F4: Inconsistent destructive-action protection.** The tiered system (checkbox-confirm → typed-confirm) is excellent where applied (trash, snapshot restore, batch validate) — but **rule delete** ([RulesPage.tsx:235-237](src/components/RulesPage.tsx)), **terminology concept delete** ([TerminologyPage.tsx:908-916](src/components/TerminologyPage.tsx)), and **voice character delete** ([CharacterModal.tsx:475-484](src/components/voice/CharacterModal.tsx)) are instant, no confirm, no undo — all shared, hand-curated assets. Snapshot delete is a bare `window.confirm`.
- **L — F-F5:** Silence-on-success in settings (org export policy saves with no acknowledgment, [Settings.tsx:58-71](src/pages/Settings.tsx)); forms otherwise preserve input and validate sanely.

### 3.5 Business-logic correctness

- **C — F-B1: "Validated" has three definitions and the server's is wrong for multi-validator projects.** Server flips `cells.validated` at `COUNT(*) > 0` ([event-projection.ts:480-487](sync-worker/src/events/event-projection.ts)); `project_settings.validationCount` (1–15) **never appears in sync-worker** (verified: zero grep hits); client editor status trusts the server flag ([useCells.ts:169-170](src/hooks/useCells.ts) — whose comment claiming the projection encodes the threshold is false); only sidebar section-progress honors N ([section-progress.ts:48-49](src/lib/progress/section-progress.ts)). Net: on a 2-validator project, ProjectOverview/org portfolio show "Validated 80%" meaning "single-endorsed 80%" — the exact trust signal the non-target-reading oversight personas consume, inflated.
- **C — F-B2: No entitlement model anywhere; the OpenRouter proxy is an open spigot.** JWT auth, then verbatim pass-through of **any model** on the platform key, no quota, no rate limit, no accounting ([chat.ts:46-51,83-90](auth-worker/src/routes/chat.ts)). With open registration (SEC-3 in the security notes), this is unmetered spend exposure. Client `record-usage.ts` is local telemetry, never read for enforcement.
- **H — F-B3: Viewers/reviewers get an editable editor; their writes die silently.** `project.permissions` is never populated for cloud projects → all-true default ([useProjectPermissions.ts:4-13](src/hooks/useProjectPermissions.ts), [cloud-projects.ts:147-181](src/lib/sync/cloud-projects.ts)); `isReadOnly` is never true. The optimistic patch applies **before** the emit; the client role-mirror's `InsufficientRoleError` is caught by no component ([EditorTable.tsx:1718-1733](src/components/EditorTable.tsx)). A consultant types a correction, watches it stick all session, loses it on reload. Silent data loss for a core persona.
- **H — F-B4: "Retain my validations" is a server no-op.** Search-and-replace offers the checkbox ([ParallelPassagesPanel.tsx:359-364](src/components/ParallelPassagesPanel.tsx)), flows `retain_validations` into payloads — zero readers in sync-worker (verified); the projection unconditionally resets validation ([event-projection.ts:296-297](sync-worker/src/events/event-projection.ts)). The UI promises what the server doesn't do.
- **H — F-B5: Frozen projects are fully writable via API.** `is_active=false` "blocks edits" per schema comment; enforcement is a workspace banner. Sync-token mint checks only `archived_at` ([sync-token.ts:72-85](auth-worker/src/routes/sync-token.ts)); the write path checks neither flag.
- **H — F-B6: Membership endpoints have privilege holes.** A project_lead (500) can change any member's role via the add-member upsert ([projects.ts:598-621](auth-worker/src/routes/projects.ts) — only `role > callerRole.level` is rejected, so demoting a fellow 500 to viewer passes); a maintainer (600) can delete a granted owner's row — target level fetched then ignored ([projects.ts:647-669](auth-worker/src/routes/projects.ts)). UI capability descriptions say otherwise.
- **H — F-B7: Trap states in the optimistic-overlay machinery.** (a) Quarantined (`failed`) outbox events replay forever in cell and validator overlays — `peekOutboxBatch` returns all statuses ([outbox.ts:251-275](src/lib/sync/outbox.ts)), both overlays consume unfiltered; a 403-rejected commit keeps displaying as the cell's content until the user finds the inspector's Discard. (b) The optimistic shadow clears only when the server echoes the same value ([useCells.ts:444-452](src/hooks/useCells.ts)); a stale-sibling loser's text stays pinned on screen all session while the banner says it was rejected.
- **M — F-B8: Validate-immediately-after-edit silently doesn't stick** — `emitValidationChange` pins the old projected head, server stores the validator row against the superseded edit ([EditorTable.tsx:1853](src/components/EditorTable.tsx)).
- **M — F-B9: Focus-lock renewal was never wired.** `useFocusLock` (with renewal) has zero non-test consumers; the workspace claims once on focus; the 30s DO lease silently expires mid-edit, after which a second claimant flips A's editor read-only and A's queued commit is discarded with a `console.warn` ([EditorTable.tsx:1708-1712](src/components/EditorTable.tsx)).
- **M — F-B10:** Concurrent invite double-redeem (read-then-mark, not atomic, [projects.ts:898,931-939](auth-worker/src/routes/projects.ts)); accept skips the archived check that preview performs; replay divergence between `/import` (guard bypassed) and `rebuild.ts` (strict) noted in the engineering audit.
- **M — F-B11: Deadline "overdue" flips at UTC midnight** — `Date.parse('YYYY-MM-DD')` in [portfolio.ts:50-53](auth-worker/src/services/portfolio.ts) marks a project overdue early evening the day *before* for users in the Americas, despite the schema's careful calendar-string design.
- **L — F-B12:** "Batch validate…" primary action is a placeholder `console.info` runner ([ProjectWorkspace.tsx:2180-2182](src/components/ProjectWorkspace.tsx)); `validationCountAudio` is a dead setting; `validationHistory` UI can never render.

### 3.6 Business-logic placement & coherence

- **H — F-P1: Two permission models coexist; one is dead.** The numeric `syncRole.level` ladder is live, tested, and mirrored byte-identically client/server (strength). The legacy `ProjectPermissions` object is never populated yet still gates the editor UI (F-B3). Per Rule 7: keep the numeric model, delete the dead one.
- **H — F-P2: Progress is re-derived in ≥4 places that disagree** (projection counters, portfolio endpoint, `useHealth.deriveAuxStats`, `section-progress`) — only the last is threshold-aware. The sidebar file bar and its own section grid can show different "validated" numbers for the same file. This is F-B1 made visible.
- **M — F-P3: No foreign keys by design ("Add FKs later," [schema.sql:17-21](db/postgres/schema.sql)) and no compensating cleanup**: file delete removes the `files` row + R2 only, orphaning cells, comments, terminology rows ([projects.ts:678-720](auth-worker/src/routes/projects.ts)). CommentsPage then lists comments pointing at dead files, with raw UUIDs as the file filter and "Open file" navigating to a dead route ([CommentsPage.tsx:452-454,571-578](src/components/CommentsPage.tsx)).
- **M — F-P4: File lifecycle is the only one outside the event log** — delete is REST, gated at **contributor (400)** while create requires project_lead (500) ([projects.ts:684](auth-worker/src/routes/projects.ts) vs sync-worker role table), and no `file.delete` event kind exists: the most destructive transition is invisible to the audit trail.

### 3.7 Permissions, roles & access UX

- **H — F-A1:** (= F-B3) under-privileged users see fully actionable surfaces; rejection is never explained — not even a "read-only" badge.
- **M — F-A2: Email-labeled invites are cosmetic.** Accept never checks the redeemer's email; the server code comments admit the column situation; the UI labels the field "Recipient email," implying a restriction that doesn't exist ([projects-invites.ts:119-123,207-231](auth-worker/src/routes/projects-invites.ts), [SharePanel.tsx:261-263](src/components/SharePanel.tsx)). Whoever holds the link redeems it.
- **M — F-A3: No-expiry invite links cannot be revoked from any UI** — a DELETE endpoint exists; nothing calls it; SharePanel deliberately doesn't list active invites ([SharePanel.tsx:138-145](src/components/SharePanel.tsx)). Also: client sends `expires_in_days` with its own "confirm server accepts this" TODO; UI default says 7 days, server default is 30 ([invites.ts:76-77](src/lib/sync/invites.ts), [projects-invites.ts:27-29](auth-worker/src/routes/projects-invites.ts)).
- **M — F-A4:** SharePanel hardcodes `callerMaxRole = MAINTAINER` ([SharePanel.tsx:90](src/components/SharePanel.tsx)) — a project_lead is offered grants the server 403s.
- **Strength:** RemoveOrgMemberDialog enumerates per-project memberships before revoking — the AD-12 revocation-discipline spec done right.

### 3.8 Edge cases & resilience (user's seat)

- **C — F-E1: File delete permanently destroys audio behind a false reassurance.** Dialog: *"The underlying data is not deleted from disk"* ([ProjectWorkspace.tsx:3171](src/components/ProjectWorkspace.tsx) — verified). Reality: hard-deletes the `files` row and **wipes every R2 object under the file including all per-cell audio recordings** ([admin.ts:85-115](sync-worker/src/admin.ts)). Contributor (400) suffices. No undo, no trash, no recovery. For the oral-translation workflow this is the single worst data-loss trap in the product — and the asymmetry is backwards: projects get recoverable trash with honest confirmation; files get permanent destruction with a reassuring lie.
- **H — F-E2: Partial-import results are destroyed before the user can read them.** The Paratext importer carefully builds "Imported N; skipped M: …" (designed "so a consultant knows exactly what didn't come across," [import.ts:954-960](src/lib/import.ts)) — then `onImported` immediately closes the dialog ([ImportDialog.tsx:628-634,171-172](src/components/ImportDialog.tsx)). 16 of 66 books fail → no durable record of which.
- **H — F-E3: USFM export is labeled non-lossy but verses edited in Aquilla silently drop intra-verse structure.** A verse span includes embedded `\q1-4`, footnotes `\f…\f*`, character markers; when a target cell exists the **whole span is replaced by plain cell text** ([export-route.ts:173-179](sync-worker/src/events/export-route.ts), [usfm-lossless.ts:316-327](src/lib/parsers/usfm-lossless.ts)) with no warning, while the dialog says "Round-trip USFM," `lossy: false` ([ExportDialog.tsx:51-56](src/components/ExportDialog.tsx)). JUDGMENT: for the Paratext cohort this is the precise trust-killer class — the product's *strongest* engineering (byte-canonical side-car) undermined by its packaging.
- **H — F-E4: Re-import silently duplicates everything.** No file-level idempotency or name/bookCode collision warning; re-importing the same Paratext project (the natural "did it work?" move, and the move the export UI itself recommends) mints 66 duplicate files ([import.ts:725](src/lib/import.ts), `handleImported`).
- **H — F-E5: Single-cell AI "Generate" auto-commits over existing — even validated — human text with no confirmation** ([useCompletion.ts:186-189](src/hooks/useCompletion.ts), enable-conditions at [EditorTable.tsx:2770-2776](src/components/EditorTable.tsx) never check existing content). Batch paths correctly target only empty cells. Recoverable via cell history, but nothing says so at the moment of risk. For an "expert-at-center" product, AI silently replacing expert work is the most reassurance-worthy moment in the app.
- **M — F-E6: File delete forks local/server state by design** — local IDB delete first, server call fire-and-forget; on failure the file resurrects on next load (acknowledged in code, [ProjectWorkspace.tsx:1998-2010](src/components/ProjectWorkspace.tsx)).
- **M — F-E7:** DOCX/PPTX side-car silently skipped over 512KB at import; user discovers at export time via a 404 with "re-import to enable" advice that won't help ([import.ts:1187-1199](src/lib/import.ts)).
- **L — F-E8:** Offline is handled well (outbox + indicators) but there's no explicit "you're offline, changes queued" banner in the workspace; 10k-cell files are virtualized (fine); zero-item states are designed.

### 3.9 Copy, errors & trust

- **M — F-C1: Internal spec IDs and engineering jargon in shipped UI.** A user tooltip reads "…hasn't been validated yet (AD-14)" with "retrieval neighborhood" ([EditorTable.tsx:3005](src/components/EditorTable.tsx)); also "side-car bytes," "audit events," "Outbox inspector," "few-shot examples," "karaoke timings." Trivial fixes, outsized trust damage with non-technical consultants.
- **M — F-C2: Approval-verb collision** — cells are "validated," terminology is "Approved/Rejected," alignments are "confirmed/invalidated"; "termbase" vs "term base" in the same file ([EditorTable.tsx:1428,1442](src/components/EditorTable.tsx)).
- **M — F-C3: Manager-facing "Translated %" counts unreviewed AI batch output identically to human work** (AI commits are ordinary commits; nothing labels machine-drafted volume). JUDGMENT: a non-target-reading owner sees "Translated 90%" minutes after "Complete all." Mitigated by the separate Validated bar — which F-B1 currently inflates.
- **L — F-C4:** Terse dead-end fallbacks ("Invite failed.", "Save failed", "Something went wrong."); "Login failed (500)".

### 3.10 Measurement & feedback loops

- **H — F-M1: The core loop is unmeasured and failures are invisible.** ~20 PostHog events skew to creation/AI; **no events for cell commit, validation, import completion, invite redemption, outbox-stuck**; `captureException` at 2 sites; nothing in any worker; no in-app "report a problem." You cannot currently answer "where do users drop off?" or "how often do imports partially fail?"
- **M — F-M2: Analytics consent defaults on.** `isAnalyticsEnabled()` returns true when no choice is recorded ([analytics-consent.ts:7](src/lib/analytics-consent.ts)) — events fire before the consent step is reached — and `posthog.identify(username, {username, email})` uses PII as the distinct ID ([useFrontierSession.ts:16-23](src/hooks/useFrontierSession.ts)).

### 3.11 Strengths (preserve these)

1. **Time-to-first-value and the invite flow** — keyless eBible import, lazy personal orgs (no org-creation wall), JoinPage inline-auth auto-redeem, designed empty states with race guards.
2. **Sync transparency** — always-visible outbox chip with drill-in inspector, per-record diagnosis ("Sign in to retry"), Retry/Discard; honest offline tooltips.
3. **The event-sourced core's honesty** — AD-2 dead-letter over silent LWW, stale-sibling banners with history deep-links, own-write suppression; byte-canonical USFM side-car design.
4. **Tiered confirmations where applied** — checkbox-confirm with consequence copy → typed-confirm for snapshot restore (which also explains that history preserves current values).
5. **Honest lossy-export labeling** (for the formats it covers) and partial-export skip reporting.
6. **Discipline at the authorization perimeter** — symbol-branded, lint-enforced single choke point; client/server role tables in verified lock-step.

---

## 4. Improvement Strategy

### Theme 1 — The UI makes promises the system doesn't keep
F-E1 (delete dialog lie), F-B4 (retain-validations no-op), F-A2 (cosmetic email binding), F-E3 (non-lossy label on lossy path), F-B12 (placeholder buttons), F-A3 (expiry picker the server may ignore). **Target state / principle: every claim in the UI is either enforced by the server or removed from the UI.** Cheapest wins in the whole audit live here — several are one-line copy changes or removing a checkbox.

### Theme 2 — "Validated" must mean one thing
F-B1, F-P2, F-C3 share one root: the product's core trust signal has no authoritative definition. **Target: the validation threshold is evaluated in exactly one server-side place; every surface (cell status, sidebar, ProjectOverview, org portfolio, Living Memory) consumes that result; machine-drafted volume is visibly distinct from human-translated.** Principle: oversight personas who can't read the target language must be able to trust the number — that's the product's stated reason to exist.

### Theme 3 — Failures must be loud to the user and visible to the team
F-F1/F-F2/F-F3, F-B3, F-B7, F-E2, F-M1. The architecture is honest (dead-letters, quarantine) but the last mile to the human is `console.warn`. **Target: every failed user action produces user-visible feedback through one error-mapping layer (extend the `ai-error.ts` taxonomy pattern); every crash and quarantine produces telemetry; the core journey has funnel events.**
 
### Theme 4 — One permission model, reflected truthfully, with the holes closed
F-B3/F-P1 (dead model gates the UI), F-B5 (frozen writable), F-B6 (membership holes), F-A4. **Target: `syncRole.level` is the only model; the editor renders read-only from it; the server checks lifecycle flags on the write path and target-role caps on membership mutations.**

### Theme 5 — Destruction needs a recovery story
F-E1, F-F4, F-E4, F-A3, plus F-J1 (account recovery). **Target: every destructive action has truthful confirmation **and** either undo, trash, or an explicit "permanent" warning; accounts are always recoverable.** Projects already model this correctly — extend that pattern to files, rules, concepts, voices, invites.

### Explicitly NOT recommending now
- **Full mobile-responsive app** — desktop ICP; fix only the JoinPage landing readability. Revisit when field-staff usage materializes.
- **Localization (CP-7)** — spec-required eventually, but a structural effort; flagged as an open question on timing, not scheduled here.
- **Unifying audio validation with text validation** — needs a product decision first (open question), not engineering.
- **A full notification center/inbox** — start with email-on-mention/reply only; an inbox is premature for the user count.
- **Billing/plans** — not needed yet; a server-side model allowlist + per-user budget on the proxy is the minimum that closes the money hole (tracked as [AQU-265](https://linear.app/frontierrandd/issue/AQU-265/hard-usage-caps-on-platform-paid-ai-endpoints-openrouter-proxy-interim) — hard cap now, billing surface later).
- **FK retrofit across the schema** — engineering-audit territory; here we only need delete-path cleanup or tombstone handling for comments.
- **Full role-ladder RLS in Postgres** — do NOT encode the 7-rung max-wins ladder in SQL policies; it would duplicate the app's single resolution point and drift. But DO add the minimal tenant-isolation backstop (task 2.10) now that the datastore is Neon Postgres — write-granularity stays in the workers, which are already a clean perimeter.

### What "done" looks like
1. Zero dead-end journeys: reset-password completes; signed-out invite errors render; `/login` exists; expired sessions prompt sign-in in place.
2. On a seeded project with `validationCount=2`, all four progress surfaces report the same Validated % — and it requires 2 validators (contract test).
3. Zero user-facing strings containing `HTTP \d{3}` or internal function names; zero internal spec IDs (AD-\d+) in UI copy (lintable).
4. Every destructive action: truthful copy + confirm; file delete is recoverable or marked permanent and gated ≥ project_lead.
5. PostHog funnel exists for signup→import→first-commit→first-validate; error boundary + `captureException` wired; outbox quarantine emits an event.
6. OpenRouter proxy enforces a model allowlist + per-user daily token budget (contract test).
7. A viewer (100) opening the editor sees read-only cells and a role badge; no write is enqueued client-side.

---

## 5. Task Plan

Effort: S < 2h · M = half-day · L = 1–2 days · XL = needs breakdown. Risk = could the change itself confuse users / break workflows / alter permissions-billing behavior.

### Milestone 0 — Safety net

| # | Task | Files/surfaces | Acceptance criteria | Effort | Risk | Deps |
|---|---|---|---|---|---|---|
| 0.1 | Global error boundary + `captureException` + `window.onerror`/`unhandledrejection` | App.tsx, lib/posthog.ts | Forced render throw shows branded recovery screen with reload; event lands in PostHog | M | Low | — |
| 0.2 | Funnel instrumentation: signup steps, import start/success/partial, first cell commit, validate, invite redeem, outbox quarantine | onboarding steps, ImportDialog, events-emit, outbox-flush | Funnel visible in PostHog on dev session | M | Low | — |
| 0.3 | Contract tests freezing current role tables, validation policy enforcement points, and progress-counter semantics (characterization tests before behavior changes) | sync-worker tests, auth-worker tests | Tests document today's behavior incl. the 1-validator flip; later milestones flip them intentionally | L | Low | — |
| 0.4 | Fix analytics consent default-off until chosen; hash the PostHog distinct ID | analytics-consent.ts:7, useFrontierSession.ts | No events before consent; no raw email as distinct id | S | Low | — |

### Milestone 1 — Critical: stop losing data, money, access, trust

| # | Task | Files/surfaces | Acceptance criteria | Effort | Risk | Deps |
|---|---|---|---|---|---|---|
| 1.1 | **Ship `/reset-password` page** (server endpoints already exist) | new route + form; App.tsx; auth.ts:318-412 | Email link → form → new password → signed in. E2E test | M | Low | — |
| 1.2 | **Truthful file deletion**: fix dialog copy now; then soft-delete/trash or explicit "permanently deletes audio" + raise gate to 500 | ProjectWorkspace.tsx:3171, projects.ts:684, admin.ts | Copy matches reality; contributor cannot hard-destroy audio | S (copy) + L (trash) | Med (role change) | 0.3 |
| 1.3 | **Quota the OpenRouter proxy**: model allowlist + per-user daily token budget + 429 copy. **Tracked: [AQU-265](https://linear.app/frontierrandd/issue/AQU-265/hard-usage-caps-on-platform-paid-ai-endpoints-openrouter-proxy-interim)** (hard cap only; full usage/billing surface deliberately deferred) | auth-worker/src/routes/chat.ts | Over-budget request → friendly 429; contract test; spend capped | M | Med (could block real users — log-only mode first) | 0.2 |
| 1.4 | **Read-only editor for under-privileged roles**: populate permissions from `syncRole.level`, render read-only + role badge, surface `InsufficientRoleError` if it still fires | useProjectPermissions.ts, cloud-projects.ts:147, EditorTable.tsx, ProjectWorkspace.tsx:1862 | Viewer sees uneditable cells + badge; no optimistic patch before authorization | L | Med (legit editors must not lose access — max-wins resolution must feed it) | 0.3 |
| 1.5 | **Surface editor write failures**: enqueue-failure banner ("couldn't save locally — copy your text"), filter `failed` records out of overlays, clear optimistic shadow on rejection | EditorTable.tsx:1732, outbox.ts:251, useCells.ts:444 | Rejected/quarantined edits stop displaying as live content; user told at failure time | L | Med (overlay logic is AQU-247-sensitive — don't reintroduce row reordering) | 0.3 |
| 1.6 | **JoinPage error branch for null preview** | invites.ts:89-125, JoinPage.tsx:48-62 | Expired link, signed-out → "link no longer valid" before any signup | S | Low | — |
| 1.7 | **USFM export honesty**: detect intra-verse markers lost in translated spans; warn per-export ("N verses contained footnotes/poetry markers") | export-route.ts:152-179, ExportDialog.tsx | Export of edited footnoted verse triggers warning; clean export doesn't | M | Low | — |
| 1.8 | **Persist partial-import report**: keep dialog open on partial failure, or write report to a project notice | ImportDialog.tsx:628-671 | 16 skipped books → user can read/copy the list after import | S | Low | — |
| 1.9 | **Confirm before AI overwrites non-empty cells** (single-cell Generate), noting history recovery | useCompletion.ts:186, EditorTable.tsx:2741-2776 | Generate on non-empty cell asks first; empty cell unchanged | S | Low | — |

### Milestone 2 — High-leverage

| # | Task | Files/surfaces | Acceptance criteria | Effort | Risk | Deps |
|---|---|---|---|---|---|---|
| 2.1 | **One authoritative "validated"**: enforce `validationCount` threshold server-side; all surfaces consume it (see sketch) | event-projection.ts:476-498, cells-read routes, portfolio.ts, useCells.ts, section-progress.ts | Done-criterion #2 passes; existing 1-validator projects unaffected (N defaults 1) | XL → break down | High (changes displayed numbers for existing users — comms note) | 0.3 |
| 2.2 | **Error-mapping layer**: one taxonomy (extend ai-error.ts pattern) wrapping fetch helpers; kill raw `HTTP nnn` strings | lib/sync/*, lib/frontier/*, ~30 call sites | Done-criterion #3 lint passes | L | Low | — |
| 2.3 | **`/login` route + returning-user flow**: direct login page; post-login skip Name/Project steps when user has orgs/projects; homepage "Sign in" → `/login` | App.tsx, OnboardingWizard.tsx, Homepage.tsx | Returning user: homepage → login → dashboard in 3 interactions | M | Low | — |
| 2.4 | **Invite truth & control**: either enforce email binding or relabel as link invite; list + revoke active invites; verify/fix `expires_in_days` handling | SharePanel.tsx, projects.ts:738-950, invites.ts:76 | UI claims match server behavior; open links revocable | L | Med | — |
| 2.5 | **Minimal notification loop**: email on @mention and on reply (extractMentions has zero callers today); wire comment delete/edit UI | comment-helpers.ts, CommentsPage, auth-worker email service | Mentioned user receives email with deep link; users can edit/delete own comments | L | Low | — |
| 2.6 | **Close membership/lifecycle holes**: target-role cap on member delete; split add vs role-change endpoints; check `is_active`+`archived_at` on write path; align SharePanel role offers with caller's level | projects.ts:598-669, sync-token.ts:72, route.ts | Lead can't demote peers; maintainer can't remove owner; frozen project rejects writes | M | Med (permissions behavior change — announce) | 0.3 |
| 2.7 | **Retain-validations**: implement server-side re-anchoring or remove the checkbox | ParallelPassagesPanel.tsx:359, event-projection.ts | No silent no-op either way | S (remove) / L (implement) | Low | 2.1 |
| 2.8 | **Re-import collision guard**: warn on matching bookCode/name; offer replace-vs-duplicate | import.ts, ProjectWorkspace.handleImported | Re-importing same Paratext project prompts instead of duplicating 66 files | M | Low | — |
| 2.9 | Wire or remove "Batch validate" placeholder; fix focus-lock renewal (mount `useFocusLock`) or lengthen lease + warn on takeover | ProjectWorkspace.tsx:2180, useFocusLock.ts | No dead primary actions; no silent mid-edit commit discard | M | Med | — |
| 2.10 | **Minimal tenant-isolation RLS on Neon Postgres** (defense-in-depth backstop now that we're on PG): one `app_user_can_access_project(project_id)` SQL helper (membership via any path: direct/group/org/creator) + project-scoped policies on `cells`, `events`, `files`, `comments`, `cell_validators`, `cell_audio`, `project_settings`, snapshots. Workers connect as a **non-owner runtime role** (RLS applies); the current role stays table **owner** for migrations/admin/support — owners bypass RLS by default, which matters on Neon where `BYPASSRLS` isn't grantable. The db shim ([db/shim/postgres.ts](db/shim/postgres.ts)) sets `SET LOCAL app.user_id` per transaction and **refuses identity-less queries** outside an explicit `asAdmin()` path. Tenant isolation only — no role-ladder logic in SQL | db/postgres/schema.sql, db/shim/postgres.ts, both workers' Hyperdrive config | Test: query with missing/foreign project scope returns 0 rows under the runtime role; admin console + migrations still work via owner role; `ALTER TABLE … DISABLE ROW LEVEL SECURITY` documented as instant rollback per table | L | Med (a missed `SET LOCAL` = silent 0-row bugs — shim guard + staging soak before prod) | 0.3 |

### Milestone 3 — Quality & polish

| # | Task | Acceptance criteria | Effort |
|---|---|---|---|
| 3.1 | Copy pass: remove AD-14/jargon, unify AI-action naming, "termbase," approval verbs; glossary doc for UI nouns | No internal IDs in UI; one name per concept | M |
| 3.2 | Confirmations for rule/concept/voice/snapshot deletes (checkbox tier) | No instant-destroy of shared assets | S |
| 3.3 | Distinguish machine-drafted volume in progress bars/Overview ("drafted by AI, awaiting review") | Manager can tell AI drafts from human work | M |
| 3.4 | Session-expiry UX: 401 → in-place sign-in prompt; fix `/projects` infinite spinner | No fake-empty dashboard | M |
| 3.5 | Deadline overdue computed against end-of-day local/project TZ | No premature overdue flag | S |
| 3.6 | Comments: map file UUIDs to names; tombstone for deleted files; scroll-to-cell | No raw UUIDs; no dead links | M |
| 3.7 | Success acknowledgments for settings saves; offline banner in workspace | Visible save state | S |
| 3.8 | Editor a11y: keyboard model for grid, `role="textbox"` on target editor, `aria-live` on toast div | Keyboard-only cell traversal possible | L |
| 3.9 | Delete dead code: `projects-invites.ts` orphan route file, `lib/migrate/gitlab/*`, dead `ProjectPermissions` type, `validationCountAudio`, `validationHistory` UI | Grep-clean | M |

### Quick wins (do immediately — all S, high impact)
1.2-copy (fix the delete-dialog lie — one line) · 1.6 (JoinPage error branch) · 1.8 (keep partial-import report visible) · 1.9 (AI overwrite confirm) · 2.7-remove (drop the no-op checkbox) · 3.2 (delete confirms) · 0.4 (consent default) · the "AD-14" tooltip line from 3.1.

### Implementation sketches — top 3

**1.1 `/reset-password` page.** Add route in [App.tsx](src/App.tsx) (eager, public) rendering a small form: read `token`+`username` from query, new-password field reusing the signup checklist component, call the existing reset endpoint ([auth.ts:318-412](auth-worker/src/routes/auth.ts)), then sign in and redirect to `/`. Gotchas: tokens are multi-valid until consumed (L-2 in journey findings) — fine for v1; handle the expired-token branch with the JoinPage-style recovery copy ("request a new link" → prefilled forgot form); add a `*` catch-all route at the same time so future bad links never render blank. Migration: none — no users have ever completed this flow. **Coordinate with the parked `followup/remove-resend-cloudflare-email` branch** (Resend → Cloudflare Email Service swap, unmerged — aquilla.app dashboard onboarding required before merge): the reset flow only touches the email-*sending* seam, so either land that branch first or keep the page provider-agnostic rather than building new Resend-specific plumbing twice. That branch also addresses the raw "RESEND_API_KEY is not configured"-style errors that currently leak to the forgot-password form.

**2.1 One authoritative "validated."** Decide write-time vs read-time (spec leans read-time — Open Question 1). Pragmatic path: keep `cell_validators` as the record; change the projection's `validated` recompute to `COUNT(*) >= project.validationCount` (read project settings once per event batch, default 1); keep `endorsement_count` as-is. Then delete the client-side threshold re-derivations: `section-progress` and `useHealth` consume the server flag instead of recomputing. Backfill: one-time recompute of `cells.validated` + `files.approved_count` for projects with N>1 (set-based SQL, per the D1/Postgres playbook — no per-row loops). Gotchas: numbers managers see will *drop* on multi-validator projects — that's the fix working, but it needs a release note; characterization tests from 0.3 flip intentionally; keep the icon's full/partial distinction (it's good UX) but derive both states from the same server response.

**1.2 Truthful file deletion.** Step 1 (today): change [ProjectWorkspace.tsx:3171](src/components/ProjectWorkspace.tsx) copy to "This permanently deletes the file's cells and all recorded audio for this file. This cannot be undone," and add the checkbox tier. Step 2: gate the route at 500 ([projects.ts:684](auth-worker/src/routes/projects.ts)) — comms note for existing contributors. Step 3 (the real fix): make delete an event (`file.delete`) with soft-delete semantics mirroring project trash — tombstone the `files` row, defer R2 wipe 30 days, add "Recently deleted" to the file sidebar. Gotchas: the local-first fork (F-E6) — make local delete contingent on server ack now that it's a soft delete and cheap to retry; comments/terminology referencing the file should render tombstones (pairs with 3.6).

---

## 6. Open Questions

1. **Validation threshold timing** — spec describes configuration but not enforcement point; `04-features/review-and-validation.md` reportedly says read-time. Confirm read-time vs projection-time before task 2.1.
2. **Export role floor** — maintainer-by-default means contributors can't export their own work ([export-route.ts:62-71](sync-worker/src/events/export-route.ts)). Deliberate for IP control, or accidental friction for translators?
3. **File deletion semantics** — is permanent audio destruction at contributor level ever intended, or should files get project-style trash? (Task 1.2 assumes trash.)
4. **Email-bound invites** — enforce binding (check redeemer email) or relabel as link invites? Security vs friction call.
5. **Audio validation** — `validationCountAudio` exists but is dead; ProjectOverview has a TODO. Is oral-translation validation a separate count, the same circle, or out of scope for now? Blocks any oral-cohort oversight story.
6. **"Translated %" semantics** — should unreviewed AI drafts count as translated for managers, or get their own segment (task 3.3)? Affects how Wendi/Randall read the dashboard.
7. **Self-validation default-on** — `allowSelfValidation` defaults permissive and the client never gates it. Intended for small teams, or should the default flip?
8. **OpenRouter proxy intent** — is free-for-all-models a deliberate alpha growth lever (accepted spend risk) or an oversight? Determines whether 1.3 is log-only or enforcing.
9. **Localization timing** — CP-7 says no hardcoded English from day one; the app is English-only with a thin `useTranslation` shim. When does the field-staff persona make this load-bearing?
10. **Mobile scope** — is "invitee opens link on phone" worth a minimal responsive pass on JoinPage + read-only workspace, or explicitly out of scope until the desktop cohort is won?
11. **Frozen (`is_active=false`) semantics** — schema says block edits, server doesn't. Is "frozen" meant to be advisory (banner only) or enforced? Determines 2.6 scope.
