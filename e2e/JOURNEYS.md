# E2E User-Journey Map

> Canonical map of **cross-layer** product journeys to smoke specs.
> AI coders: grep this file by keyword. If your change touches a journey here,
> **extend that spec**. Add a new smoke row only when the [smoke admission
> test](./README.md#smoke-admission) passes. UI chrome belongs in Vitest/RTL
> (see [Covered in RTL](#covered-in-rtl) below) — not a new smoke file.

## Smoke keep-list (cross-layer journeys + surface sessions)

Target is ~25 true product lies; surface sessions (one `test()` / one reset) and
domain sentinels bring the on-disk smoke count to ~35 — still the merge gate,
not a micro-spec farm.

| Area | Journey | Spec |
| --- | --- | --- |
| Projects | Create project, appears on dashboard | `e2e/specs/projects/create.smoke.spec.ts` |
| Projects | Open / delete / restore from trash | `e2e/specs/projects/project-trash.smoke.spec.ts` |
| Projects | App shell still routes | `e2e/specs/projects/route-health.smoke.spec.ts` |
| Projects | Project settings rename/save persists | `e2e/specs/projects/project-settings.smoke.spec.ts` |
| Projects | Knowledge Base upload, extracted-text read, and delete persist through Postgres + R2 (via Living Memory → Knowledge, `/project/:id/memory/knowledge`) | `e2e/specs/projects/project-settings.smoke.spec.ts` |
| Projects | Setup checklist survives refresh | `e2e/specs/editor/setup-checklist-survives-refresh.smoke.spec.ts` |
| Agent connection | Browser consent issues a scoped credential; OAuth selects current organizations in Act mode; later organizations stay excluded; revocation blocks Agent API access | `e2e/specs/agent/agent-connection.smoke.spec.ts` |
| Agent workbench | The workbench shows the file open in the editor — the Document view lists its cells, a reload keeps them, and Text returns to the same file (AQU-1496) | `e2e/specs/agent/workbench-open-file.smoke.spec.ts` |
| Orgs | Add member to org, member sees it | `e2e/specs/orgs/members.smoke.spec.ts` |
| Orgs | Account switcher sessions | `e2e/specs/orgs/account-switcher.smoke.spec.ts` |
| Orgs | Preferences persist across reload | `e2e/specs/orgs/preferences-persist-reload.smoke.spec.ts` |
| Orgs | Billing & usage preserves existing access and distinguishes persisted personal/team scope across creation, navigation, and reload; selected-plan links require an explicit workspace and reject incompatible scope; offer tabs, cadence, Stripe-derived display, and workspace plan review are covered in RTL; authenticated review restrictions and current-price validation are covered in worker integration tests; sandbox checkout → signed initial payment → workspace plan, retries, confirmed checkout expiry/replacement, rollback, isolation, and JSON persistence are covered against real Postgres; signed renewal/failure/recovery/cancellation, delayed events, concurrent revisions, and atomic lifecycle rollback are covered against real Postgres; effective Free allowance after payment failure crosses Postgres → API → browser; existing-plan upgrade/downgrade review preserves Stripe proration parameters and renewal timing through real signed activation → review → Postgres; its API client and review UI are covered in RTL; native single-item catalog → checkout → signed activation → scope-specific hosted portal is covered in worker/real-Postgres tests; captured Stripe upgrade/credit-downgrade/cancel_at shapes, early invoice replay, and concurrent native update retries preserve usage anchors in real-Postgres tests; durable provider-cost reservations and settlements compose signed activation with exact-period admission, equal per-tool multipliers, concurrent request limits, retries, and Free fallback in real-Postgres tests (local authenticated chat JSON/SSE, import-classification, agent per-step (orchestrator turn and nested drafting), and autopilot graph-call admission/settlement (owner-funded background runs pause at the span edge on exhaustion), including hosted Whisper admission and settlement from real client WAVs, charged malformed output, weekly exhaustion mid-run, and held-request reconciliation from provider generation records, are covered through the real handlers and Postgres; live-provider and other endpoint wiring remains pending); Manage billing and safe portal failures are covered in RTL; hosted portal sessions are covered through signed activation → Postgres → authenticated route → Stripe request in worker and real-Postgres tests; paid plan/cadence/period display is covered in RTL and persisted plan reload/workspace isolation crosses Postgres → API → browser | `e2e/specs/orgs/org-settings-billing.smoke.spec.ts` |
| Orgs | Owner exports selected projects as one org ZIP | `e2e/specs/orgs/org-egress.smoke.spec.ts` |
| Auth | First-login / account-setup status (sentinel) | `e2e/specs/auth/login-account-setup-status.smoke.spec.ts` |
| Editor | Import markdown, edit cell, persists across reload and immediate hard navigation; cold opens reveal complete source/target rows while the remaining rows load; imported video automatically links its picture and preserves signed range playback and seeking after reload; YouTube imports support a picture only with later caption attachment, original media with configured ASR or embedded-caption review, and user caption exports with unchanged original download | `e2e/specs/editor/import-and-edit.smoke.spec.ts` |
| Importing | Media with companion or embedded MP4/M4A captions preserves reviewed wording, cue boundaries, playable source clips, and byte-exact original media across publication and reload. Attaching captions creates an independent track; counted overwrite preserves other wording and source audio. Pasted and uploaded scripts reuse persisted word timings, preserve paragraph boundaries, save reviewed independent tracks, and retain byte-exact original script downloads (SPA → sync-worker → Postgres + R2). Preview, confidence, boundary correction, and consent changes also have RTL coverage | `e2e/specs/editor/import-media-captions.smoke.spec.ts` |
| Editor | Adaptive cell pages preserve ordering and show download progress | Covered in worker integration (`cells-read.test.ts`) and RTL (`CellLoadingProgress.test.tsx`, `useActiveCellStore.stale-rejection.test.tsx`) |
| Editor | Hidden cells are not work — excluded from progress (numerator and denominator, live in both directions), health, automatic drafting and search (AQU-1424) | Covered in worker integration (`sync-worker/src/__tests__/hidden-cells-progress.test.ts` — progress projection, `files` counters, FTS; `auth-worker/src/__tests__/hidden-cells-agent.test.ts` — the shared cell selector behind autopilot and the agent's read/draft, plus agent search) and RTL/unit (`useActiveCellStore.hiddenProgress.test.ts`, `src/lib/completion/draft-targets.test.ts`, `src/lib/health/excluded-cell.test.ts`). No new smoke: the hide/show journey itself is AQU-1422's row, and nothing here can lose data, access or a committed artifact — a regression misreports a number or wastes a credit. |
| Editor | Import EPUB package, preserve spine order, commit source bytes | `e2e/specs/editor/import-epub.smoke.spec.ts` |
| Editor | EPUB chapter picker excludes navigation, cover, and notes by default | `e2e/specs/editor/import-epub-picker.smoke.spec.ts` |
| Editor | Commit survives stale in-flight refetch | `e2e/specs/editor/commit-survives-stale-refetch.smoke.spec.ts` |
| Editor | Re-import updates source while preserving target | `e2e/specs/editor/reimport-preserves-target.smoke.spec.ts` |
| Editor | eBible import persists across reload | `e2e/specs/editor/import-ebible-persists-reload.smoke.spec.ts` |
| Editor | Comment writes through events | `e2e/specs/editor/comments.smoke.spec.ts` |
| Editor | Export downloads (own-format, original blob vs injected USFM) | `e2e/specs/editor/export.smoke.spec.ts` |
| Editor | Workspace actions dropdown (E2E harness sentinel) | `e2e/specs/editor/workspace-actions-dropdown.smoke.spec.ts` |
| Rules | Enable built-in rule, see violation in editor | `e2e/specs/rules/violation.smoke.spec.ts` |
| Rules | Custom rule create / edit / toggle (surface session) | `e2e/specs/rules/rules-crud.smoke.spec.ts` |
| Validation | Editing a cell auto-validates | `e2e/specs/validation/validate.smoke.spec.ts` |
| Validation | Validation history persists across navigation | `e2e/specs/validation/validation-persists-navigation.smoke.spec.ts` |
| AI | Sparkle fills a cell | `e2e/specs/ai/completion.smoke.spec.ts` |
| Collab | File propagates alice → bob | `e2e/specs/collab/file-propagation.smoke.spec.ts` |
| Collab | Concurrent cell edit propagates alice → bob after cold import setup on a throttled renderer | `e2e/specs/collab/concurrent-edit.smoke.spec.ts` |
| Collab | Same-parent commits held behind a request barrier on a throttled (3G-like) network converge, keep both edits in history, stay stable, and the bumped edit is promotable | `e2e/specs/collab/concurrent-edit-throttled.smoke.spec.ts` |
| Collab | One editor's successive commits chain linearly (same focus session, reload, second tab, three pending corrections on an existing target head, a quick Tab / Shift+Tab re-edit of an empty or translated verse while its first save is still being written to the outbox (AQU-1578), and edits after an unacknowledged human/AI draft including timeout/retry and a correction still only in the editor buffer); corrections and their validation survive navigation and reload | `e2e/specs/collab/commit-chain-linear.smoke.spec.ts` |
| Collab | Member presence indicators | `e2e/specs/collab/member-presence-popover.smoke.spec.ts` |
| Collab | BT edit locked for reviewer | `e2e/specs/collab/bt-edit-locked-for-reviewer.smoke.spec.ts` |
| Collab | Cross-user comment | `e2e/specs/collab/cross-user-comment.smoke.spec.ts` |
| Collab | Cross-user validate | `e2e/specs/collab/cross-user-validate.smoke.spec.ts` |
| Sharing | Invite link → join → dashboard visibility (surface) | `e2e/specs/projects/share-invite.smoke.spec.ts` |
| Terminology | Wildcard term chip (domain sentinel) | `e2e/specs/terminology/wildcard-term-chip.smoke.spec.ts` |
| Admin | Billing credit catalog and organization usage grants; weekly allowance grants persist through admin → Postgres → workspace usage, while global Free limits and personal-workspace exceptions are covered in worker integration and RTL tests | `e2e/specs/projects/admin-console-billing.smoke.spec.ts` |

## Smart journeys (adaptive navigation, independent outcomes)

Aquilla owns these contracts, fixtures, and release evidence. The pinned Jev
dependency chooses browser actions. See [smart testing](../smart-tests/README.md)
for commands, limits, and qualification requirements. These runs currently
provide advisory evidence; they do not silently replace a release check.

| Outcome | Conditions | Journey |
| --- | --- | --- |
| Open a project and file, edit the intended translation, preserve every other source/target, and read the correction in server state and a fresh session | Normal; immediate hard navigation after input; delayed HTTP | `smart-tests/journeys/edit-durability.spec.ts` |
| Rename a project, rename a file, or post exactly one comment on the intended cell; retain identities and all translation content | Separate reset fixture per outcome; authoritative API and fresh browser verification | `smart-tests/journeys/project-outcomes.spec.ts` |
| Sign off on exactly one finished translation; keep every other row unsigned and every translation byte unchanged | Normal; immediate hard navigation the moment the control flips | `smart-tests/journeys/validation-outcomes.spec.ts` |
| Reject a missing write and a corrupted target, accept a real durable edit | Model-free oracle qualification | `smart-tests/journeys/qualification.spec.ts` |
| Reject an unsigned file and a misplaced sign-off, accept a real validation | Model-free oracle qualification | `smart-tests/journeys/qualification.spec.ts` |
| Expose meaningful controls to Jev's actual DOM reader, and activate a target before offering fill | Eight initial route surfaces and editor activation | `smart-tests/journeys/dom-audit.spec.ts` |

### Planned smart journeys

The backlog, highest value first. Each row needs a synthetic starting state,
a goal free of test selectors, an authoritative oracle, and a realistic
adverse condition before it is written. Add a journey only when its oracle
can fail a broken build; a green run against a working build proves nothing
on its own. Move a row into the table above when it lands, and record what
the covered outcome actually is rather than what it was meant to be.

| # | Outcome a user cares about | Authoritative oracle | Adverse condition | Why adaptive |
| --- | --- | --- | --- | --- |
| 1 | A reviewer withdraws a sign-off they gave in error, and the row stops counting as approved | `cell_validators` projection plus the event log holding both a `cell.validate` and its `cell.unvalidate` | Withdraw immediately after granting, before the first flush | The withdraw control lives inside a popover the sign-off journey never opens |
| 2 | Two people edit the same cell offline and both edits survive reconcile, with one winning head | Per-cell history: both commits logged, exactly one projected head, loser reported in `stale[]` | Partition one writer, edit both, then rejoin | The parent-chain rule is the core architecture claim and has no adaptive coverage |
| 3 | A translator finds and replaces a term across a file without touching unmatched cells | Projection: every matched cell changed, every unmatched cell's value and chain head identical | Navigate away mid-replace | Replace is destructive at scale; a wrong match set is invisible in the UI |
| 4 | An invited member joins and sees exactly the projects their role allows | `projects` read as the invitee, plus a denied read on an unshared project | Accept the invite in a second browser session | Permission leaks are the highest-severity failure and need a real second identity |
| 5 | An export round-trips: what a user downloads re-imports to the same cells | Re-import the downloaded bytes and compare projections cell by cell | Export while one cell has an unflushed edit | Byte-level fidelity is what the product promises publishers |
| 6 | A staged agent changeset only reaches translations after a human approves it | Projection unchanged while staged; changed only after approval; changeset row's status | Reject one changeset, approve another | The approval gate is a safety property; it must fail closed |
| 7 | A source re-import updates source text and leaves every human translation intact | Projection: source values change, target values and target heads do not | Re-import while a target edit is in flight | The destructive path most likely to silently lose human work |
| 8 | A contributor records audio on a cell and it plays back after a reload | R2 object plus the cell's audio projection | Reload before the upload completes | Media upload has no adaptive coverage and fails differently from text |

Rows 1 and 3 are the cheapest to add next: both reuse the existing seeded
file and need no second identity or media fixture.

## Adversarial journeys (deployed dev, advisory)

Jev attacks the deployed dev build under hostile conditions, red-team goals,
and reworded goals; a snapshot oracle over every touched project decides.
Findings file as Linear Triage tickets under AQU-1330. A model-free canary
gates each run. See [the adversarial suite](../smart-tests/adversarial/README.md).
The catalogue lives in `smart-tests/adversarial/attacks.ts`.

## Journeys moved to another repository

| Area | Journey | Current owner |
| --- | --- | --- |
| Marketing | Homepage book-a-call | `aquilla-marketing`: producer behavior is covered by `src/pages/Homepage/BookCallSection.test.tsx`; the immediate API consumer remains covered by `auth-worker/src/__tests__/contact.test.ts` here. The old app-repo smoke was retired when this repo stopped building the marketing page (AQU-918). |

## Surface sessions (one `test()`, one reset)

These absorb several UI assertions that still need a real browser route.
Each file collapses chrome into **one** `test()` with `test.step()` so the
`{ alice }` fixture runs `resetBackend()` **once** for N checks — not once per
former micro-test. Do **not** use a bare `beforeEach` seed without depending on
`{ alice }` (the fixture wipe races the seed). True journeys (collab, invite
accept, import-and-edit, …) stay hermetic per-test.

| Surface | Spec |
| --- | --- |
| Comments page empty / filters / sort / search / back-nav / resolved | `e2e/specs/editor/comments-page.smoke.spec.ts` |
| Onboarding wizard steps | `e2e/specs/projects/onboarding.smoke.spec.ts` |
| Formatting bubble + shortcuts + loss warning | `e2e/specs/editor/formatting.smoke.spec.ts` |
| Search toolbar + replace + scope | `e2e/specs/editor/search.smoke.spec.ts` |
| Rules create / edit / delete / org / dialogs | `e2e/specs/rules/rules-crud.smoke.spec.ts` |
| Share invite link chrome (role / expiry / copy / email) | `e2e/specs/projects/share-invite.smoke.spec.ts` (chrome session only; join/accept tests stay per-test) |

`teams.smoke.spec.ts` is **not** a surface session — create/delete/member/
attach mutations conflict across steps, so it keeps hermetic per-test resets.

`violation.smoke.spec.ts` stays separate from `rules-crud` (editor-side effect).

## Full suite only (not smoke)

Expensive format/agent/access journeys live as `*.spec.ts` and run on
`pnpm test:e2e` / release — not pre-push, not default smoke:

| Journey | Spec |
| --- | --- |
| IDML roundtrip / IME / protected slots | `e2e/specs/editor/idml-roundtrip.spec.ts` |
| Biblica study notes import (incl. division bookmarks + front/back matter volumes) | `e2e/specs/partner-integrations/biblica/import-biblica-study-notes.spec.ts` |
| Treasure Hunt Bible import | `e2e/specs/partner-integrations/biblica/import-treasure-hunt-bible.spec.ts` |
| Reach 4 Life import | `e2e/specs/partner-integrations/biblica/import-reach4life.spec.ts` |
| EBL guide import (whole guide + topic/lesson sections) | `e2e/specs/partner-integrations/biblica/import-ebl.spec.ts` |
| Contextual run pill | `e2e/specs/contextual/run-pill.spec.ts` |
| Project overview autopilot | `e2e/specs/projects/project-overview-autopilot.spec.ts` |
| Org access lifecycle (multi-path revoke; AQU-435/1107 org Contributor sees no projects) | `e2e/specs/orgs/org-access-lifecycle.spec.ts` |
| Legacy D1-only first login | `e2e/specs/auth/legacy-user-first-login.spec.ts` |
| Agent changeset approval | `e2e/specs/agent/changeset-approval.spec.ts` |
| Pointed term forms: mark folding, the saved project affix inventory, and a per-form exclusion that survives reload | `e2e/specs/terminology/pointed-term-forms.spec.ts` |
| Merge duplicate concepts: survivor keeps the union of renderings, the merged-away concept is gone for a second member and after reload (AQU-1337; dialog rules + role gate covered in RTL) | `e2e/specs/terminology/merge-duplicates.spec.ts` |
| Repetition auto-propagation: typing a translation into a repeated segment (validated by the edit itself) fills the file's other identical-source rows once the cell is left; filled rows stay unvalidated; the projection and a cold reload agree (AQU-1484 — not smoke: a regression leaves rows unfilled, it loses nothing. The settle-on-leave timing, the mid-typing hold and the self-validation-off gate are covered in RTL, `EditorTable.repetitionTrigger.test.tsx`; the per-cell chain/pin planning in `repetition-propagation.test.ts`) | `e2e/specs/validation/repetition-propagation.spec.ts` |
| Sibling merge: a linked sibling's translations fold into the host as a real lane (a lane record, the switcher shows it, rename works) through the identity → sync call on the real schema (AQU-1550 — not smoke: no UI yet, and a failed merge leaves the donor live. The lane record, its position, re-runs and the no-orphan-on-failure rule are covered in the worker suite, `merge-sibling-lane-record.test.ts`; the fold token's claims and the duplicate-name refusal in auth-worker's `merge-sibling.test.ts`) | `e2e/specs/projects/merge-sibling.spec.ts` |
| Translate-as-read drafting workflow | `e2e/specs/ai/translate-as-read.spec.ts` |
| Agent draft / sidebar | `e2e/specs/ai/agent-draft.spec.ts` |
| Completion races / lanes / footnotes | `e2e/specs/ai/completion-*.spec.ts` |
| Agent-import sandbox | `e2e/specs/agent-import.spec.ts` |
| Account switch cross-tab | `e2e/specs/orgs/account-switch-cross-tab.spec.ts` |
| Six simultaneous editors (write + live-update latency under whole-BSB helloao import) | `e2e/specs/collab/six-editor-concurrency.spec.ts` |
| Session-expired banner | `e2e/specs/auth/session-expired-banner.smoke.spec.ts` |

## Covered in RTL

UI chrome that used to be one smoke file per click is covered under
`src/**/*.test.tsx`. Do **not** re-add Playwright for these:

- Unified Agent conversation/document/knowledge navigation and same-task
  re-selection: covered in RTL (`AgentWorkbench.test.tsx`, `workspace-location.test.ts`).
  The former competing Team/Chat tabs and mandatory three-pane layout are retired.
- Unsent Agent messages, context chips, and attachment ownership across views,
  conversations, and accounts: covered in composer draft-store and composer RTL.
- Focused task-draft review stays on the Agent route, preserves the task language
  lane and editor Audio/Text preference, and uses the existing contextual approval
  transport. Navigation and approval wiring are covered in `AgentDraftReview.test.tsx`.
- Optional paired document context uses the existing cell renderer/commit callbacks
  in one aligned scrolling surface: covered in `AgentDocumentContext.test.tsx`.
- Agent Team header, roster/card access, and toolbar identity across tabs:
  covered in RTL (`TeamThreadsView.test.tsx`, `AgentWorkbench.test.tsx`)
- Agent task message grouping, routine-activity disclosure, explicit step
  inspection, Escape priority, and focus return: covered in RTL
  (`TeamThreadDetail.test.tsx`, `TeamThreadsView.test.tsx`)
- Agent pending-review/question header and links to focused task review:
  covered in RTL (`TeamConversationHeader.test.tsx`, `TeamThreadsView.test.tsx`)
- Agent chat options, confirmed reset, preserved applied events, and pinned
  Team chat navigation: covered in RTL (`AgentChatOptions.test.tsx`,
  `AgentWorkbench.test.tsx`, `AgentDockPanel.test.tsx`)
- Workspace sidebar hide/show restoration and Agent Back navigation:
  covered in RTL (`LeftDock.test.tsx`, `useDockTabs.test.ts`,
  `useWorkspaceDockTabs.test.ts`, `AgentWorkbench.test.tsx`,
  `workbench-layout.test.ts`)
- Collapsed-rail history and footer controls: covered in RTL
  (`NavHistoryControls.test.tsx`, `AppShell.test.tsx`)
- The Assigned-to-me inbox never reports an answer it does not have: no
  "You have no open assignments." while the scoped read is outstanding (the org
  directory resolves asynchronously, so this is the normal cold-load path), and
  an org switch returns to the skeleton rather than showing the previous org's
  rows (AQU-1251 — `AssignedToMe.test.tsx`, `AssignedToMe.orgSwitch.test.tsx`).
- DOM navigation and editing: plan inspector editor link, filename keyboard
  access, corpus rename input, read-surface button activation, and cell labels
  (`PlanInspector.test.tsx`, `ProjectOverview.test.tsx`, `FileRow.test.tsx`,
  `ExpandableFileList.test.tsx`, `EditorCellSurface.test.tsx`,
  `EditorTable.editorActions.test.tsx`). Pending-edit page-hide flush is covered
  in `TranslatedEditor.commit.test.tsx` and import-and-edit smoke.

- View settings, tab strip, selection bar, outbox inspector, term-lookup popover,
  video attachment dialog, cell-expansion Escape close, setup-checklist expand/skip
  (except survives-refresh, which stays smoke)
- AI availability after an offline → online cycle (AQU-1377): a health probe forced
  while the browser is offline records no snapshot, the browser `online` event forces
  a fresh probe that re-enables the AI controls, and a batch refused because the
  service is unreachable surfaces an explicit banner instead of a silent no-op
  (`frontier-health.test.tsx`, `useCompletion.unavailable.test.ts`). UI gating only —
  no data, access or committed artifact is at risk, so per the rules above this stays
  RTL rather than becoming a smoke journey.
- Live connection popover: keyboard open/close, observed upload/download activity, and offline readings (`SyncStatusIndicator.test.tsx`); passive sampling, five-minute totals/average/slowest reply, failure counts, sample freshness, expiry, and five-second chart buckets (`connection-activity.test.ts`); separate traffic/reply scales and honest gaps for missing samples (`ConnectionHistoryChart.test.tsx`).
- Auth form micro-UI: show/hide password, signup checklist, forgot/reset form chrome.
  Also the refused-sign-up redirection (AQU-1345): a 409 shows the "sign in instead"
  copy with word-for-word identical wording whichever datastore reserved the identity,
  and the Sign in action carries the typed identifier into the login field
  (`FrontierSignupForm.identityTaken.test.tsx`, `FrontierLoginForm.prefill.test.tsx`).
  The migration itself on that subsequent login is unchanged by that work and stays
  covered where it already was.
- Project settings pane links / toggles (except rename/save persistence smoke)
- Linking an **established** project to another project's source from Project Settings
  → Source & sync (AQU-1525): the entry point's role gate, picker contents (every
  accessible project, never this one, never an archived one), the live/consumes-source
  shape it posts, the seed self-heal fallback, and the cycle refusal are in
  `LinkSourceSection.test.tsx`; the pane mounting it in
  `ProjectSettings.subMenuIA.test.tsx`. That linking is **additive** — the first mirror
  sync after linking leaves every pre-existing file, translation and validation row
  byte-identical, and a same-named upstream file lands beside the project's own — is
  pinned against real Postgres in `sync-worker/src/__tests__/link-sync-additive-established.test.ts`.
  The cross-layer walk (link from settings in the browser, then assert the mirrored files
  appear while the pre-existing file's translations survive) is NOT yet a smoke journey —
  AQU-1525 left it open because it could not be executed where the fix was made; it is
  the remaining item on that issue's automated-coverage checklist.
  The pre-link confirm step (AQU-1526) is RTL/unit too: the clash arithmetic — matched
  ignoring letter case, reported in the upstream's spelling, listed once per name — in
  `link-source-preview.test.ts`, and the step's states (count, same-name warning that
  does not block, empty upstream, an unreadable upstream file list that is never shown
  as a count of zero, and cancel) in `LinkSourceSection.test.tsx`. No data or artifact
  is at risk before confirming and the step crosses no second service, so per the rules
  above it stays RTL rather than becoming a smoke journey.
  The Import dialog's second entry point to the same action (AQU-1527, "From another
  project" on the landing screen) is RTL in `ImportDialog.linkProject.test.tsx`: the tile
  routes to the flow, back links nothing, the shared pre-link preview appears on this
  path too (the flow is one component — `ProjectSettings/LinkSourceFlow.tsx` — so the two
  entry points cannot diverge), confirming posts the live/consumes-source shape and closes
  the dialog, and the two unusable cases (already linked, below project lead) are shown
  disabled with their reason. The cross-layer walk is the SAME still-open item AQU-1525
  left: one smoke journey covering link-then-assert-mirrored-files serves both entry
  points, and it is tracked there rather than duplicated here.
  A link whose FIRST MIRROR SYNC FAILED (AQU-1544) is RTL/unit as well. The link is saved
  and then filled by that sync; when it failed, every entry point used to carry on as if
  it had worked. What the user is shown instead — the link was saved, the source files
  have not arrived, "Try again" — is pinned per entry point: the shared flow in
  `LinkSourceSection.test.tsx` (the success callback does not fire; a retry that fails
  keeps the message and the action; one that works finishes as a normal link), the Import
  dialog staying open in `ImportDialog.linkProject.test.tsx`, and Create New Project →
  Linked target in `ProjectCreateDialog.linked.test.tsx`, where the dialog's real output
  is passed through the real landing banner (`LinkSeedFailedNotice.test.tsx` covers the
  banner alone). The workspace's zero-file self-heal no longer failing quietly is in
  `ProjectWorkspace.selfheal.test.ts`, and Project Settings telling a never-synced link
  ("Not synced yet" / "Sync now") from a healthy one in `SourceLinkSection.test.tsx`.
  It stays out of smoke for the reason the rules give: it is a message and a retry on a
  failure path, nothing is lost that was not already missing, and reproducing it needs
  the sync service to be made to fail, which the local e2e stack has no switch for.
  The page BEHIND Project Settings listing a new link's files without a reload (AQU-1570)
  is RTL too. Settings is a route modal over the still-mounted workspace or overview,
  each with its own `useProject`; the link flow, "Try again" and a "Sync now" that brought
  content in announce the change (`lib/sync/project-record-changed.ts`) and every
  `useProject` for the project re-resolves. Pinned where it escaped, in the composition:
  `LinkSourceSection.pageBehind.test.tsx` renders the real flow beside a real `useProject`
  consumer (files listed after a link and after a retry that works; nothing re-read when
  the first sync failed), with the hook's own contract in `useProject.test.tsx` and Sync
  now's in `SourceLinkSection.test.tsx`. It is a stale read with nothing lost, so it stays
  out of smoke; the AQU-1525 smoke walk above would cover it once it exists.
  A link to a LARGE upstream seeding at all (AQU-1543: statement size; AQU-1563: the
  first sync folding the whole history at once ran the ProjectSync Durable Object out
  of its 128 MB) is worker-tested against real Postgres. `link-sync-large-upstream.test.ts`
  pins that no statement grows with the upstream; `link-sync-windowed.test.ts` pins that
  the delta is read and committed in bounded windows (events and payload bytes), that an
  interrupted sync resumes at its last finished window, that one event per window ends in
  exactly the state one window gives (both link shapes), and that `POST /link/sync` keeps
  calling budgeted invocations until the link is caught up. No smoke: local workerd does
  not enforce the memory limit the bug hit, so a browser walk would pass on the broken
  code too; what bounds memory is that no read or write grows with the upstream.
  An OPEN live-linked project following its upstream without a reload (the AQU-479
  push accelerator; AQU-1545 hide/show and rename) is worker/unit-tested. Which upstream
  changes notify, per link shape, is one definition shared with the mirror sync and is
  pinned through the real `POST /events` route in `sync-worker/src/__tests__/link-notify.test.ts`
  (hide, show, rename, clone gets nothing, consumes-target links hear translations).
  A sync asked for mid-sync gets a fresh fold (`rerun-single-flight.test.ts`). On the
  client, a burst keeps its trailing sync and a frame landing mid-sync is owed another
  (`ws-reconciler.test.ts`); the frame-time staleness read fires no sync of its own
  (`useStaleSourceCells.test.tsx`); after the sync, progress is re-read and the file list
  re-read when a frame said files moved (`ProjectWorkspace.pushedLinkSync.test.ts`).
  Not smoke: a missed push loses nothing — the lazy pull on the next file open is the
  floor — and the walk needs two projects, a link and a second socket.
- A ONE-TIME COPY of another project's source — the Cloned shape at Create New Project,
  and the snapshot a detach freezes — bringing in exactly the files it shows (AQU-1608) is
  auth-worker-tested against real Postgres in
  `auth-worker/src/__tests__/source-linking-deleted-file-cells.test.ts`. Both flows are one
  function, `snapshotSourceCells`, which copied file rows through `snapshotSourceFiles`
  (live files only) and then every source cell in the upstream, so a file the upstream had
  moved to Recently deleted contributed lines keyed to a file row the new project does not
  have. Pinned there for all four shapes: the whole-project copy, a subset copy, a followed
  file deleted upstream after the link was made (the detach half), and an upstream with
  nothing deleted. No smoke, and this is the reason rather than the usual one — the walk is
  cheap, but what went wrong is INVISIBLE on the surface a walk would check: the file list
  was always right, and the stray rows showed only through project-wide search
  (`scoped-search.ts` matches `cells` on `project_id` alone) and the health rollup's
  `DISTINCT file_id`. A browser walk that asserted the file list would have passed on the
  broken code; what the copy must hold is that its files and its lines are one set, which is
  a server-state assertion. The manual walk is still worth running once per release and is
  on this issue's QA checklist; it needs a three-file upstream with a phrase unique to the
  deleted file, which no standing fixture provides.
- Import dialog chrome / specialized options landing (except persist-reload journeys), including the mutually exclusive Biblica title choice and its independent sentence-split option (`ImportDialog.biblicaEdition.test.tsx`)
- Preferences toggles / theme / app font size (except persist-reload)
- Account-specific hosted/local Whisper selection, explicit model download consent, and manual/automatic transcription routing (`LocalModelsSection.test.tsx`, `transcription-routing.test.ts`, `auto-transcribe.test.ts`) — covered in RTL/unit tests
- Local Whisper execution device (AQU-1533): the worker runs on WebGPU only when the browser hands out a GPU adapter, and otherwise loads on WASM without attempting WebGPU first — a WebGPU session that fails cannot be retried on WASM in the same worker (`whisper-worker.device.test.ts`). Unit-level only: a browser check needs a launch without a GPU adapter and model weights from external CDNs, so it is a manual verification, not a smoke.
- Rules page toggles / severity / regex mode (RTL on RulesPage + rule editor)
- Comments page empty / filter / sort chrome (RTL + comments-page surface session)
- Comment visibility polish (AQU-1259): the comments page's **Open file** link carries `&comments=1` so arriving in the editor opens that cell's thread instead of only scrolling to the row — the link/reader contract in `project-workspace-lane-deeplink.test.ts`, the page half (unresolved and resolved) in `CommentsPage.test.tsx`. The opt-in **Highlight open comments** editor setting and the leading-edge accent it draws on rows with an unresolved thread are in `ViewSettingsMenu.test.tsx` and `EditorTable.unresolvedCommentHighlight.test.tsx`; AQU-599's always-on badge is unchanged.
- Living-memory empty states and section IA (index → brief/instructions/quality/knowledge/examples panes, collapsed prediction prompt, role gates — RTL in `LivingMemoryPage.component.test.tsx`; entry points and legacy settings redirects in `ProjectSettings.subMenuIA.test.tsx` + `shell-routing.test.ts`)
- Back-translation generation, editing, stale/provenance, statistical-pairs comparison, and — AQU-1408 — the two-reading order (statistical gloss above the AI reading) plus each section's visible descriptor (`BacktranslationPanel.test.tsx`); the cross-user edit lock remains in the smoke keep-list
- Admin console tab clicks, formatting Ctrl+B alone, breadcrumb-only nav
- Milestone split-view (one whole division at a time vs continuous file): the switch lives in ⋯ → Editor settings; the pager stays on the editor (`ViewSettingsMenu.test.tsx`, `EditorTable.splitMilestones.test.tsx`, `ChapterNavigator.test.tsx`). Jumps into the paged view — an Assigned-to-me entry and a recording-modal cell change turning to the milestone that holds the target cell (`EditorTable.milestoneJumpTargets.test.tsx`, `milestone-jump-targets.test.ts`); a Files-panel chapter row or a contextual-run range chip turning to the milestone that contains the target cell (`ScrollToGroupHandler.test.tsx`)
- Milestone picker legibility (AQU-1485): a division title wins the dropdown's width over the per-row progress readout, which is a marker plus a percentage rather than spelled-out words; a title still clipped, and the trigger's collapsed label, reveal themselves on hover (`ChapterNavigator.compactProgress.test.tsx`)
- Clone-voice button on a source cell opens the New voice modal in place without switching to the Voices dock tab (`CloneVoiceModalHost.test.tsx`, `CellVoicePanel.chip.test.tsx`)
- Chapter audio stitch (AQU-1201): concatenate a chapter's verse recordings into one continuous WAV. A checkbox includes chapter-heading takes in that file; the choice is remembered in export-dialog localStorage — RTL in `audio-chapter.group.test.ts`, `audio-chapter.export.test.ts`, `ExportDialog.audio-chapter.test.tsx`, `export-dialog-memory.test.ts`. Existing by-character / by-line exports stay on their own tests.
- New-voice leftover Kokoro project defaults remap to Inworld; picker offers Inworld / Gemini / MMS (`NewVoiceModal.test.tsx`)
- Inworld Voice Design starting-point chips (Agent, Narrator, Instructor, Pirate — Companion removed AQU-1378) (`InworldVoiceDesignField.test.tsx`, `inworld-voice-design.test.ts`)
- AI model consent dialog: Just Whisper starts that model's download (Enable all is not required) (`AiModelConsentDialog.test.tsx`)
- Org add-member dialog defaults to Contributor and states that org membership below Maintainer does not open projects (`MembersPage.test.tsx`; access-panel copy in `MemberAccessPanel.test.tsx`)
- Mobile sidebar sheet chrome (org + editor dock): header PanelLeft opens a left sheet — RTL in `AppShell.test.tsx`. Org navigate-and-close also has `e2e/specs/orgs/mobile-sidebar-sheet.smoke.spec.ts`
- Mobile editor rows stack source and target beside a compact line gutter, share a row-level health indicator, and keep Source/Target language controls side by side. Desktop keeps equal side-by-side columns — covered in RTL (`EditorTable.cellWidth.test.tsx`, `EditorTable.validationGutter.test.tsx`).
- Agent works on compact viewports (2026-09-30, restored after #802 hid it): the single-column Team workspace keeps its entry points below `lg`, and picking a conversation from the mobile sidebar sheet closes the sheet even when only `?conversation=` changes — covered in RTL (`AppShell.test.tsx` sheet close; `FileChapterToolbar.test.tsx` / `LeftDock.test.tsx` for entry-point wiring; `ProjectWorkspaceRoute.test.tsx` for a direct Agent URL staying on Agent). Verified at 375px on the dev stack. AQU-1496: every `/project/:id/...` surface shares one route wrapper — `ProjectWorkspaceRoute.test.tsx` pins it, so a surface hop keeps the workspace (and its open file) mounted; a guard on one surface alone is what broke that.
- AQU-1187 scripture-catalog per-book import: an eBible / Hello AO selection spanning several books emits one source file per book, each carrying `bookCode`, so the files group into OT/NT and order canonically; a single-book selection stays one file and only gains its code. Covered at the import-contract level in `src/lib/import.scripture-books.test.ts` (asserts the real `file.create` bodies, per-book originals, and the re-import collision key) plus `group-by-corpus.test.ts`. The existing `import-ebible-persists-reload.smoke.spec.ts` fixture is a three-verse Genesis corpus, i.e. the single-book path, and stays valid unchanged. The multi-book variant needs a corpus long enough to cross a book boundary (~1.5k lines, generated from the bundled vref list) — worth adding to that spec when a runnable stack is at hand; it was not added blind.
- Linked-video empty table (AQU-1565): a time-ordered file whose media is a LINKED
  video — a YouTube "Link video only" import (AQU-1556) — has no rows of its own, and
  the editor's empty table used to fall through to the prompt for a file with no media
  at all ("No media on this file yet", plus a direct-media-URL field that rejects a
  watch page). What it says instead, what it offers, and what it withholds are covered
  in RTL through the real EditorTable branch (`EditorTable.mediaEmptyState.test.tsx`):
  the linked-video copy with no attach-media prompt and no URL field, the Open Media
  view action and its absence when the table already renders under the timeline, the
  attached caption tracks being NAMED rather than reported absent (their cues live in
  their own content files, so the host file's row count stays at zero), a viewer
  getting the sentence and nothing to click, and the regression guard that a file with
  no linked video keeps the ordinary prompt, direct-URL field included. The decision
  itself is `lib/editor/linked-video-empty-state.test.ts`. No smoke, per the rules: it
  is an empty state in a single component, nothing is lost if it breaks, and the
  picture-only import journey it follows is already walked by
  `e2e/specs/editor/import-and-edit.smoke.spec.ts` (row 31).
- AQU-1187 sidebar/picker book tree: a file spanning several books shows a collapsible header per book in the expanded sidebar row and files the toolbar chapter picker's options under book headings; per-book and non-scripture files render flat exactly as before — covered in RTL (`sidebar/BookHealthSpine.bookTree.test.tsx`, `ChapterNavigator.bookGroups.test.tsx`, `lib/sidebar/book-sections.test.ts`).
- Hide cell / Show cell (AQU-1422): the menu entry's role gate (absent below
  Project Lead, including on a DCS-pinned project where a refusal reason exists),
  the DCS-pinned disabled reason, the IDML row that is parkable although its text
  is not editable, the Show-cell wording flip, and the dimmed eye-off row —
  covered in RTL (`EditorTable.hiddenCells.test.tsx`). The display-list rule that
  drops a parked cell from the text table, the media lens and the chapter counts
  together, and the list-version bumps a live hide/show depends on, are in
  `useActiveCellStore.hiddenCells.test.ts`. The durable contract is a worker unit
  test, not a smoke: `sync-worker/src/__tests__/hidden-cells-projection.test.ts`
  drives the real projection against real Postgres and reads it back out through
  the real cells read route, which is the producer/consumer seam that would
  otherwise fail silently. The emit contract (non-chain-mutating, PROJECT_LEAD
  floor) is in `src/lib/sync/events-emit.hiddenCells.test.ts`.
- Hidden cells leave every export (AQU-1423). The existing export smoke
  (`e2e/specs/editor/export.smoke.spec.ts`, row 38 above) already crosses the
  layers this touches, and hiding adds no new cross-layer contract — it adds a
  predicate to a scoping step that journey already exercises. So the coverage is
  narrower and closer to the failure: `src/lib/export/validation-scope.test.ts`
  for the predicate, `src/lib/export/hidden-cells-export.test.ts` for the
  producer/consumer seam (real cells through the real scoping step into the REAL
  text exporters, asserting the parked line is absent in BOTH languages — the
  failure here is not a missing line but a present one in the source language),
  `src/components/ExportDialog.hiddenCells.test.tsx` for the round-trip formats
  and the dialog's per-format note, and
  `sync-worker/src/__tests__/usfm-export-plan.test.ts` for the server-side USFM
  plan against real Postgres.
- Upstream curation reaches a linked project (AQU-1453, AQU-1546). A hide or a
  show on an upstream source cell travels down every live link, and it is a
  server contract end to end — the fold, the mirror payload and the projection —
  with no UI of its own in the consuming project (a linked project does not offer
  hide/show on mirrored source cells). So the coverage stays where the failure is:
  `sync-worker/src/__tests__/link-sync-visibility.test.ts` against real Postgres.
  AQU-1546 adds the two orders of events that lost the state while the
  hide-last order worked — hide then edit, on a first sync and on an established
  link — and a three-project `A → B → C` chain, where the middle project's hidden
  cells were never hidden by anyone in it and the state exists only on the
  `source.cell.mirror` events it received. No smoke: the downstream rows are
  already there, nothing is lost, and a regression offers work the upstream
  parked rather than destroying it.
- An upstream delete reaches a linked project as a tombstone, and only as one
  (AQU-1567). Like curation above it is a server contract with no UI of its own
  in the consuming project, so it is pinned in
  `sync-worker/src/__tests__/link-sync-tombstone-chain.test.ts` against real
  Postgres: in `A → B → C` the cell A deleted is tombstoned in C with its text
  kept, for a consumes-source and a consumes-target C, and a hide or a new
  translation of it in B does not make it live in C again; an upstream restoring
  the cell with its ORIGINAL text clears the tombstone, on one link and down a
  chain; and a cell the downstream never held gets no row at all — create and
  delete in one window, in different windows of one run, or as an empty
  tombstone already sitting in B — while a later re-create still arrives and a
  replayed window mirrors nothing. `link-sync-windowed.test.ts` pins that
  one-event windows end in the same state. No smoke: the walk needs three
  projects and two links, and crosses no layer the worker test does not already
  run for real.
- In-app feedback (AQU-1028, moved to the Help menu by AQU-1548): the Help ("?") menu's **Feedback** item opens the report dialog, the report is submitted to the team whether or not analytics consent is on, and the optional screen capture attaches / is dismissed / fails — covered in RTL (`ReportProblemButton/ReportProblemDialog.test.tsx`, `HelpMenu.test.tsx` for the entry point, `lib/feedback.test.ts`). The worker side (multipart route, R2 key, mail body, throttle, and the degradations when storage or mail is unbound) is covered against real Postgres in `auth-worker/src/__tests__/feedback.test.ts`.
- A translation note shows the original-language phrase it is about, in its own script and direction, with the occurrence marker and support article — covered in RTL (`TranslationNotesSidebar.originalPhrase.test.tsx`); the producer→panel metadata contract is pinned in `src/lib/notes/note-metadata.test.ts`, `src/lib/parsers/translation-notes.test.ts` and `src/lib/dcs/routes/tsv-notes.test.ts`.

When you change one of these surfaces, update the matching `*.test.tsx`. If RTL
is missing, add it — then delete any leftover smoke, do not park it as non-smoke.

Parallel Bibles missing-reference empty state is covered in RTL:
`src/components/ParallelBiblesSidebar.test.tsx` (absent/book-only references,
version picker access, and recovery when a valid reference appears).
