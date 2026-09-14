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
| Orgs | Add member to org, member sees it | `e2e/specs/orgs/members.smoke.spec.ts` |
| Orgs | Account switcher sessions | `e2e/specs/orgs/account-switcher.smoke.spec.ts` |
| Orgs | Preferences persist across reload | `e2e/specs/orgs/preferences-persist-reload.smoke.spec.ts` |
| Orgs | Billing & usage shows the Field Plan CTA and agent-credit meter | `e2e/specs/orgs/org-settings-billing.smoke.spec.ts` |
| Orgs | Owner exports selected projects as one org ZIP | `e2e/specs/orgs/org-egress.smoke.spec.ts` |
| Auth | First-login / account-setup status (sentinel) | `e2e/specs/auth/login-account-setup-status.smoke.spec.ts` |
| Editor | Import markdown, edit cell, persists across reload | `e2e/specs/editor/import-and-edit.smoke.spec.ts` |
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
| Collab | One editor's successive commits chain linearly (same focus session, across a reload, and from a second tab of the same user) so ordinary typing is never refused as bumped | `e2e/specs/collab/commit-chain-linear.smoke.spec.ts` |
| Collab | Member presence indicators | `e2e/specs/collab/member-presence-popover.smoke.spec.ts` |
| Collab | BT edit locked for reviewer | `e2e/specs/collab/bt-edit-locked-for-reviewer.smoke.spec.ts` |
| Collab | Cross-user comment | `e2e/specs/collab/cross-user-comment.smoke.spec.ts` |
| Collab | Cross-user validate | `e2e/specs/collab/cross-user-validate.smoke.spec.ts` |
| Sharing | Invite link → join → dashboard visibility (surface) | `e2e/specs/projects/share-invite.smoke.spec.ts` |
| Terminology | Wildcard term chip (domain sentinel) | `e2e/specs/terminology/wildcard-term-chip.smoke.spec.ts` |
| Admin | Billing credit catalog and organization usage grants | `e2e/specs/projects/admin-console-billing.smoke.spec.ts` |

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
| Org access lifecycle (multi-path revoke) | `e2e/specs/orgs/org-access-lifecycle.spec.ts` |
| Legacy D1-only first login | `e2e/specs/auth/legacy-user-first-login.spec.ts` |
| Agent changeset approval | `e2e/specs/agent/changeset-approval.spec.ts` |
| Translate-as-read drafting workflow | `e2e/specs/ai/translate-as-read.spec.ts` |
| Agent draft / sidebar | `e2e/specs/ai/agent-draft.spec.ts` |
| Completion races / lanes / footnotes | `e2e/specs/ai/completion-*.spec.ts` |
| Agent-import sandbox | `e2e/specs/agent-import.spec.ts` |
| Account switch cross-tab | `e2e/specs/orgs/account-switch-cross-tab.spec.ts` |
| Session-expired banner | `e2e/specs/auth/session-expired-banner.smoke.spec.ts` |

## Covered in RTL

UI chrome that used to be one smoke file per click is covered under
`src/**/*.test.tsx`. Do **not** re-add Playwright for these:

- View settings, tab strip, selection bar, outbox inspector, term-lookup popover,
  video attachment dialog, cell-expansion Escape close, setup-checklist expand/skip
  (except survives-refresh, which stays smoke)
- Auth form micro-UI: show/hide password, signup checklist, forgot/reset form chrome
- Project settings pane links / toggles (except rename/save persistence smoke)
- Import dialog chrome / specialized options landing (except persist-reload journeys), including the mutually exclusive Biblica title choice and its independent sentence-split option (`ImportDialog.biblicaEdition.test.tsx`)
- Preferences toggles / theme / app font size (except persist-reload)
- Rules page toggles / severity / regex mode (RTL on RulesPage + rule editor)
- Comments page empty / filter / sort chrome (RTL + comments-page surface session)
- Living-memory empty states and section IA (index → brief/instructions/quality/knowledge/examples panes, collapsed prediction prompt, role gates — RTL in `LivingMemoryPage.component.test.tsx`; entry points and legacy settings redirects in `ProjectSettings.subMenuIA.test.tsx` + `shell-routing.test.ts`)
- Back-translation generation, editing, stale/provenance, and statistical-pairs comparison (`BacktranslationPanel.test.tsx`); the cross-user edit lock remains in the smoke keep-list
- Admin console tab clicks, formatting Ctrl+B alone, breadcrumb-only nav
- Milestone split-view (one whole division at a time vs continuous file): the switch lives in ⋯ → Editor settings; the pager stays on the editor (`ViewSettingsMenu.test.tsx`, `EditorTable.splitMilestones.test.tsx`, `ChapterNavigator.test.tsx`)
- Clone-voice button on a source cell opens the New voice modal in place without switching to the Voices dock tab (`CloneVoiceModalHost.test.tsx`, `CellVoicePanel.chip.test.tsx`)
- New-voice Kokoro speaker dropdown grouped by project target language, with a playable sample per voice (`NewVoiceModal.test.tsx`)
- AI model consent dialog: Just Kokoro starts that model's download (Enable all is not required) (`AiModelConsentDialog.test.tsx`)
- Mobile sidebar sheet chrome (org + editor dock): header PanelLeft opens a left sheet — RTL in `AppShell.test.tsx`. Org navigate-and-close also has `e2e/specs/orgs/mobile-sidebar-sheet.smoke.spec.ts`

When you change one of these surfaces, update the matching `*.test.tsx`. If RTL
is missing, add it — then delete any leftover smoke, do not park it as non-smoke.
