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
| Agent connection | Browser consent issues a scoped credential; revocation blocks Agent API access | `e2e/specs/agent/agent-connection.smoke.spec.ts` |
| Orgs | Add member to org, member sees it | `e2e/specs/orgs/members.smoke.spec.ts` |
| Orgs | Account switcher sessions | `e2e/specs/orgs/account-switcher.smoke.spec.ts` |
| Orgs | Preferences persist across reload | `e2e/specs/orgs/preferences-persist-reload.smoke.spec.ts` |
| Orgs | Billing & usage preserves existing access and distinguishes persisted personal/team scope across creation, navigation, and reload; selected-plan links require an explicit workspace and reject incompatible scope; offer tabs, cadence, Stripe-derived display, and workspace plan review are covered in RTL; authenticated review restrictions and current-price validation are covered in worker integration tests; sandbox checkout → signed initial payment → workspace plan, retries, confirmed checkout expiry/replacement, rollback, isolation, and JSON persistence are covered against real Postgres; signed renewal/failure/recovery/cancellation, delayed events, concurrent revisions, and atomic lifecycle rollback are covered against real Postgres; effective Free allowance after payment failure crosses Postgres → API → browser; existing-plan upgrade/downgrade review preserves Stripe proration parameters and renewal timing through real signed activation → review → Postgres; its API client and review UI are covered in RTL; native single-item catalog → checkout → signed activation → scope-specific hosted portal is covered in worker/real-Postgres tests; captured Stripe upgrade/credit-downgrade/cancel_at shapes, early invoice replay, and concurrent native update retries preserve usage anchors in real-Postgres tests; durable provider-cost reservations and settlements compose signed activation with exact-period admission, equal per-tool multipliers, concurrent request limits, retries, and Free fallback in real-Postgres tests (local authenticated chat JSON/SSE, import-classification, agent per-step (orchestrator turn and nested drafting), and autopilot graph-call admission/settlement (owner-funded background runs pause at the span edge on exhaustion), including charged malformed output, weekly exhaustion mid-run, and held-request reconciliation from provider generation records, are covered through the real handlers and Postgres; live-provider and other endpoint wiring remains pending); Manage billing and safe portal failures are covered in RTL; hosted portal sessions are covered through signed activation → Postgres → authenticated route → Stripe request in worker and real-Postgres tests; paid plan/cadence/period display is covered in RTL and persisted plan reload/workspace isolation crosses Postgres → API → browser | `e2e/specs/orgs/org-settings-billing.smoke.spec.ts` |
| Orgs | Owner exports selected projects as one org ZIP | `e2e/specs/orgs/org-egress.smoke.spec.ts` |
| Auth | First-login / account-setup status (sentinel) | `e2e/specs/auth/login-account-setup-status.smoke.spec.ts` |
| Editor | Import markdown, edit cell, persists across reload and immediate hard navigation; cold opens reveal complete source/target rows while the remaining rows load | `e2e/specs/editor/import-and-edit.smoke.spec.ts` |
| Editor | Adaptive cell pages preserve ordering and show download progress | Covered in worker integration (`cells-read.test.ts`) and RTL (`CellLoadingProgress.test.tsx`, `useActiveCellStore.stale-rejection.test.tsx`) |
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
| Collab | One editor's successive commits chain linearly (same focus session, reload, second tab, three pending corrections on an existing target head, and edits after an unacknowledged human/AI draft including timeout/retry and a correction still only in the editor buffer); corrections and their validation survive navigation and reload | `e2e/specs/collab/commit-chain-linear.smoke.spec.ts` |
| Collab | Member presence indicators | `e2e/specs/collab/member-presence-popover.smoke.spec.ts` |
| Collab | BT edit locked for reviewer | `e2e/specs/collab/bt-edit-locked-for-reviewer.smoke.spec.ts` |
| Collab | Cross-user comment | `e2e/specs/collab/cross-user-comment.smoke.spec.ts` |
| Collab | Cross-user validate | `e2e/specs/collab/cross-user-validate.smoke.spec.ts` |
| Sharing | Invite link → join → dashboard visibility (surface) | `e2e/specs/projects/share-invite.smoke.spec.ts` |
| Terminology | Wildcard term chip (domain sentinel) | `e2e/specs/terminology/wildcard-term-chip.smoke.spec.ts` |
| Admin | Billing credit catalog and organization usage grants | `e2e/specs/projects/admin-console-billing.smoke.spec.ts` |

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
| Biblica study notes import (incl. division bookmarks + front/back matter volumes) | `e2e/specs/editor/import-biblica-study-notes.spec.ts` |
| Treasure Hunt Bible import | `e2e/specs/editor/import-treasure-hunt-bible.spec.ts` |
| Reach 4 Life import | `e2e/specs/editor/import-reach4life.spec.ts` |
| EBL guide import (whole guide + topic/lesson sections) | `e2e/specs/editor/import-ebl.spec.ts` |
| Contextual run pill | `e2e/specs/contextual/run-pill.spec.ts` |
| Project overview autopilot | `e2e/specs/projects/project-overview-autopilot.spec.ts` |
| Org access lifecycle (multi-path revoke; AQU-435/1107 org Contributor sees no projects) | `e2e/specs/orgs/org-access-lifecycle.spec.ts` |
| Legacy D1-only first login | `e2e/specs/auth/legacy-user-first-login.spec.ts` |
| Agent changeset approval | `e2e/specs/agent/changeset-approval.spec.ts` |
| Pointed term forms: mark folding, the saved project affix inventory, and a per-form exclusion that survives reload | `e2e/specs/terminology/pointed-term-forms.spec.ts` |
| Merge duplicate concepts: survivor keeps the union of renderings, the merged-away concept is gone for a second member and after reload (AQU-1337; dialog rules + role gate covered in RTL) | `e2e/specs/terminology/merge-duplicates.spec.ts` |
| Translate-as-read drafting workflow | `e2e/specs/ai/translate-as-read.spec.ts` |
| Agent draft / sidebar | `e2e/specs/ai/agent-draft.spec.ts` |
| Completion races / lanes / footnotes | `e2e/specs/ai/completion-*.spec.ts` |
| Agent-import sandbox | `e2e/specs/agent-import.spec.ts` |
| Account switch cross-tab | `e2e/specs/orgs/account-switch-cross-tab.spec.ts` |
| Session-expired banner | `e2e/specs/auth/session-expired-banner.smoke.spec.ts` |

## Covered in RTL

UI chrome that used to be one smoke file per click is covered under
`src/**/*.test.tsx`. Do **not** re-add Playwright for these:

- DOM navigation and editing: plan inspector editor link, filename keyboard
  access, corpus rename input, read-surface button activation, and cell labels
  (`PlanInspector.test.tsx`, `ProjectOverview.test.tsx`, `FileRow.test.tsx`,
  `ExpandableFileList.test.tsx`, `EditorCellSurface.test.tsx`,
  `EditorTable.editorActions.test.tsx`). Pending-edit page-hide flush is covered
  in `TranslatedEditor.commit.test.tsx` and import-and-edit smoke.

- View settings, tab strip, selection bar, outbox inspector, term-lookup popover,
  video attachment dialog, cell-expansion Escape close, setup-checklist expand/skip
  (except survives-refresh, which stays smoke)
- Live connection popover: keyboard open/close, observed upload/download activity, and offline readings (`SyncStatusIndicator.test.tsx`); passive sampling, five-minute totals/average/slowest reply, failure counts, sample freshness, expiry, and five-second chart buckets (`connection-activity.test.ts`); separate traffic/reply scales and honest gaps for missing samples (`ConnectionHistoryChart.test.tsx`).
- Auth form micro-UI: show/hide password, signup checklist, forgot/reset form chrome
- Project settings pane links / toggles (except rename/save persistence smoke)
- Import dialog chrome / specialized options landing (except persist-reload journeys), including the mutually exclusive Biblica title choice and its independent sentence-split option (`ImportDialog.biblicaEdition.test.tsx`)
- Preferences toggles / theme / app font size (except persist-reload)
- Rules page toggles / severity / regex mode (RTL on RulesPage + rule editor)
- Comments page empty / filter / sort chrome (RTL + comments-page surface session)
- Living-memory empty states and section IA (index → brief/instructions/quality/knowledge/examples panes, collapsed prediction prompt, role gates — RTL in `LivingMemoryPage.component.test.tsx`; entry points and legacy settings redirects in `ProjectSettings.subMenuIA.test.tsx` + `shell-routing.test.ts`)
- Back-translation generation, editing, stale/provenance, and statistical-pairs comparison (`BacktranslationPanel.test.tsx`); the cross-user edit lock remains in the smoke keep-list
- Admin console tab clicks, formatting Ctrl+B alone, breadcrumb-only nav
- Milestone split-view (one whole division at a time vs continuous file): the switch lives in ⋯ → Editor settings; the pager stays on the editor (`ViewSettingsMenu.test.tsx`, `EditorTable.splitMilestones.test.tsx`, `ChapterNavigator.test.tsx`). Jumps into the paged view — an Assigned-to-me entry and a recording-modal cell change turning to the milestone that holds the target cell (`EditorTable.milestoneJumpTargets.test.tsx`, `milestone-jump-targets.test.ts`); a Files-panel chapter row or a contextual-run range chip turning to the milestone that contains the target cell (`ScrollToGroupHandler.test.tsx`)
- Clone-voice button on a source cell opens the New voice modal in place without switching to the Voices dock tab (`CloneVoiceModalHost.test.tsx`, `CellVoicePanel.chip.test.tsx`)
- New-voice leftover Kokoro project defaults remap to Inworld; picker offers Inworld / Gemini / MMS (`NewVoiceModal.test.tsx`)
- Inworld Voice Design starting-point chips (Agent, Narrator, Instructor, Pirate — Companion removed AQU-1378) (`InworldVoiceDesignField.test.tsx`, `inworld-voice-design.test.ts`)
- AI model consent dialog: Just Whisper starts that model's download (Enable all is not required) (`AiModelConsentDialog.test.tsx`)
- Org add-member dialog defaults to Contributor and states that org membership below Maintainer does not open projects (`MembersPage.test.tsx`; access-panel copy in `MemberAccessPanel.test.tsx`)
- Mobile sidebar sheet chrome (org + editor dock): header PanelLeft opens a left sheet — RTL in `AppShell.test.tsx`. Org navigate-and-close also has `e2e/specs/orgs/mobile-sidebar-sheet.smoke.spec.ts`

When you change one of these surfaces, update the matching `*.test.tsx`. If RTL
is missing, add it — then delete any leftover smoke, do not park it as non-smoke.

Parallel Bibles missing-reference empty state is covered in RTL:
`src/components/ParallelBiblesSidebar.test.tsx` (absent/book-only references,
version picker access, and recovery when a valid reference appears).
