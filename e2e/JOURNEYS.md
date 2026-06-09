# E2E User-Journey Map

> The canonical mapping of user journeys to spec files. AI coders: when adding a feature, grep this file by keyword. If your feature touches a journey here, **extend that spec**. If it's new, **add a row + new spec**.

| Area        | Journey                                              | Spec                                                          | Smoke? |
| ----------- | ---------------------------------------------------- | ------------------------------------------------------------- | :----: |
| Auth        | API-level login (covered implicitly by every multi-user spec via `ensureAuthState`) | `e2e/helpers/auth.ts` |  n/a   |
| Auth        | UI sign-up / login flow                              | _gap — Plan 2 (no `/login` route; login lives in onboarding)_ |        |
| Auth        | Password reset request                               | _gap — Plan 2_                                                |        |
| Auth        | Switch between two signed-in accounts                | _gap — Plan 2_                                                |        |
| Onboarding  | First-run flow to dashboard                          | _gap — Plan 2_                                                |        |
| Projects    | Create project, appears on dashboard                 | `e2e/specs/projects/create.smoke.spec.ts`                     |   ✅   |
| Projects    | Open / delete / restore from trash                   | `e2e/specs/projects/project-trash.smoke.spec.ts` + `dashboard-trash-expand-restore.smoke.spec.ts` | ✅ |
| Orgs        | Create org                                           | `e2e/specs/orgs/org-switcher-create.smoke.spec.ts`            |   ✅   |
| Orgs        | Add member to org, member sees it                    | `e2e/specs/orgs/members.smoke.spec.ts` (API setup + UI verify) |   ✅   |
| Orgs        | Invite member → member sees all org projects         | `e2e/specs/orgs/org-access-lifecycle.spec.ts` (test 1)        |        |
| Orgs        | Create team → attach project/user → group path fires | `e2e/specs/orgs/org-access-lifecycle.spec.ts` (test 2)        |        |
| Orgs        | Revoke org membership → project disappears           | `e2e/specs/orgs/org-access-lifecycle.spec.ts` (test 3)        |        |
| Orgs        | Full revoke (all paths) → 403 on project endpoint    | `e2e/specs/orgs/org-access-lifecycle.spec.ts` (test 4)        |        |
| Orgs        | Detach group project → role falls back to org baseline | `e2e/specs/orgs/org-access-lifecycle.spec.ts` (test 5)      |        |
| Orgs        | Remove member, change role                           | `e2e/specs/orgs/remove-member-dialog.smoke.spec.ts` + `projects/share-panel-role-change.smoke.spec.ts` | ✅ |
| Orgs        | Send & accept invite                                 | `e2e/specs/orgs/invite-to-projects.smoke.spec.ts` + `pending-invite-revoke.smoke.spec.ts` | ✅ |
| Editor      | Import markdown, edit cell, persists across reload   | `e2e/specs/editor/import-and-edit.smoke.spec.ts`              |   ✅   |
| Editor      | Cmd+K search                                         | `e2e/specs/editor/search.smoke.spec.ts` (toolbar) + `search-keyboard-shortcut.smoke.spec.ts` (Ctrl+K) | ✅ |
| Editor      | Virtualization scroll integrity                      | _gap — Plan 2_                                                |        |
| Rules       | Enable built-in rule, see violation in editor        | `e2e/specs/rules/violation.smoke.spec.ts`                     |   ✅   |
| Rules       | Define custom rule                                   | `e2e/specs/rules/create-rule.smoke.spec.ts`                   |   ✅   |
| Rules       | Auto-correct a violation                             | _gap — Plan 2_                                                |        |
| Validation  | Validate a cell, indicator turns emerald             | `e2e/specs/validation/validate.smoke.spec.ts`                 |   ✅   |
| Validation  | History persists across navigation                   | `e2e/specs/validation/validation-persists-navigation.smoke.spec.ts` | ✅ |
| AI          | Sparkle button fills cell from mock LLM              | `e2e/specs/ai/completion.smoke.spec.ts` (IDB-injected settings)            | ✅ |
| Collab      | File propagates from alice to bob                    | `e2e/specs/collab/file-propagation.smoke.spec.ts` (API project bootstrap)  | ✅ |
| Collab      | Concurrent cell edit propagates alice → bob          | `e2e/specs/collab/concurrent-edit.smoke.spec.ts` (API project bootstrap)   | ✅ |
| Collab      | Conflict resolution on same cell                     | _gap — Plan 2_                                                |        |
| Collab      | Member presence indicators                           | _gap — Plan 2_                                                |        |
| Comments    | Add / edit / resolve comment                         | `e2e/specs/editor/comments.smoke.spec.ts` + `comment-resolve.smoke.spec.ts` + `comment-reply.smoke.spec.ts` | ✅ |
| Comments    | Go to cell from comments page                        | `e2e/specs/editor/comments-go-to-cell.smoke.spec.ts`          |   ✅   |
| Sharing     | Generate invite link / join project via link         | `e2e/specs/projects/share-invite-link.smoke.spec.ts` + `join-page.smoke.spec.ts` | ✅ |
| Sharing     | Copy invite URL from share panel                     | `e2e/specs/projects/share-invite-copy-url.smoke.spec.ts`      |   ✅   |
| Sharing     | Toggle invite mode between @user and email           | `e2e/specs/projects/share-invite-mode-toggle.smoke.spec.ts`   |   ✅   |
| Audio/Video | Import audio file                                    | _gap — Plan 2_                                                |        |
| Audio/Video | Subtitles flow                                       | _gap — Plan 2_                                                |        |
| Settings    | Settings sync between two browsers                   | _gap — Plan 2_                                                |        |
| Settings    | Settings persist across reload                       | `e2e/specs/orgs/preferences-persist-reload.smoke.spec.ts`    |   ✅   |
| Export      | Export to each supported format                      | `e2e/specs/editor/export.smoke.spec.ts` + `export-format-switch.smoke.spec.ts` (partial — all format radio buttons covered) | ✅ |
| Editor      | Formatting bubble menu (bold/italic/underline/strikethrough/code) | `e2e/specs/editor/formatting-bubble-menu.smoke.spec.ts` + `formatting-inline-code-toggle.smoke.spec.ts` + `formatting-underline-strikethrough.smoke.spec.ts` | ✅ |
| Editor      | Formatting loss warning when source has bold/italic   | `e2e/specs/editor/formatting-loss-warning.smoke.spec.ts`      |   ✅   |
| Editor      | File actions hover menu (rename/delete)               | `e2e/specs/editor/file-actions-button.smoke.spec.ts`          |   ✅   |
| Editor      | Corpus rename inline edit                             | `e2e/specs/editor/sidebar-corpus-rename.smoke.spec.ts`        |   ✅   |
| Editor      | Video attachment dialog fill + Save URL               | `e2e/specs/editor/video-attachment-save-url.smoke.spec.ts`    |   ✅   |
| Editor      | Import coming-soon items are disabled                 | `e2e/specs/editor/import-coming-soon-disabled.smoke.spec.ts`  |   ✅   |
| Editor      | Setup checklist coming-soon items visible             | `e2e/specs/editor/setup-checklist-coming-soon-items.smoke.spec.ts` | ✅ |
| Validation  | Remove validation (unvalidate cell)                   | `e2e/specs/validation/cell-unvalidate.smoke.spec.ts`          |   ✅   |
| Rules       | Org rule inline edit (pencil button expands editor)   | `e2e/specs/rules/org-rule-edit.smoke.spec.ts`                 |   ✅   |
| Rules       | Rule editor autofix preview shows before/after        | `e2e/specs/rules/rule-editor-autofix-preview.smoke.spec.ts`   |   ✅   |
| Projects    | Status chip shows Overdue/Due-soon by deadline        | `e2e/specs/projects/project-status-chip.smoke.spec.ts`        |   ✅   |
| Projects    | Living memory back navigation                         | `e2e/specs/projects/living-memory-back-nav.smoke.spec.ts`     |   ✅   |
| Orgs        | Members matrix sole-owner concentration risk          | `e2e/specs/orgs/members-matrix-sole-owner.smoke.spec.ts`      |   ✅   |
| Orgs        | Members matrix access-help tooltip                    | `e2e/specs/orgs/members-matrix-access-help.smoke.spec.ts`     |   ✅   |
| Orgs        | Team detail access-level help indicator               | `e2e/specs/orgs/team-detail-access-level-help.smoke.spec.ts`  |   ✅   |
| Collab      | BT edit locked for reviewer role                      | `e2e/specs/collab/bt-edit-locked-for-reviewer.smoke.spec.ts`  |   ✅   |
| Orgs        | Pending invite targeted-email chip vs open-link badge | `e2e/specs/orgs/pending-invite-targeted-chip.smoke.spec.ts`   |   ✅   |
| Comments    | Stale indicator when translation changes after thread  | `e2e/specs/editor/comment-translation-stale-indicator.smoke.spec.ts` | ✅ |
| Projects    | Project overview per-file stats row after import      | `e2e/specs/projects/project-overview-file-stats.smoke.spec.ts` |   ✅   |
| Projects    | Cross-project termbase subscribe and unsubscribe      | `e2e/specs/projects/termbase-subscribe-unsubscribe.smoke.spec.ts` | ✅ |
| Editor      | Video attachment Remove attachment clears saved URL   | `e2e/specs/editor/video-attachment-remove.smoke.spec.ts`          |   ✅   |
| Projects    | Living memory Recent Examples ValidatedCellCard       | `e2e/specs/projects/living-memory-validated-cell-card.smoke.spec.ts` | ✅ |
| Orgs        | Members matrix org-wide badge for inherited access    | `e2e/specs/orgs/members-matrix-org-wide-badge.smoke.spec.ts`      |   ✅   |
| Editor      | Delete file confirm dialog requires checkbox          | `e2e/specs/editor/delete-file-confirm-dialog.smoke.spec.ts`       |   ✅   |
| Editor      | RTL detection hint shows and can be dismissed         | `e2e/specs/editor/rtl-hint-dismiss.smoke.spec.ts`                 |   ✅   |
| Projects    | Project settings discard-changes dialog (Keep editing / Discard) | `e2e/specs/projects/project-settings-discard-unsaved.smoke.spec.ts` | ✅ |
| Editor      | Next unfinished cell button enabled when cells empty  | `e2e/specs/editor/next-unfinished-button.smoke.spec.ts`            |   ✅   |
| Rules       | Amend rule button navigates to rules?focus=autofix    | `e2e/specs/rules/rule-drawer.smoke.spec.ts` (extended)             |   ✅   |
| Tauri       | Native dialogs / deeplink / updater / fs / keychain  | _gap — Plan 3_                                                |        |

## How to add a journey

1. Pick the right `<area>` directory under `e2e/specs/`. If your journey doesn't fit any existing area, create a new folder.
2. Filename convention: `<journey>.spec.ts` for full-suite, `<journey>.smoke.spec.ts` for the pre-push gate.
3. Use `import { test, expect } from "../../helpers/multi-user"` if your test needs `alice`/`bob`/`carol`. Use `import { test, expect } from "@playwright/test"` for single-user, plus `await resetBackend()` in your own `beforeEach`.
4. Reuse page objects under `e2e/helpers/page-objects/`. Add a new one if no existing class fits.
5. Add a row to this table.
6. Run `npm run test:e2e:smoke` (or full `npm run test:e2e`) to verify.

## Manual checklists

Human-clickable walkthroughs for journeys where automation misses visual or UX edge cases:

| Area | Checklist |
|------|-----------|
| Orgs — access lifecycle (FRO-144) | `e2e/manual-checklists/org-access-walkthrough.md` |
