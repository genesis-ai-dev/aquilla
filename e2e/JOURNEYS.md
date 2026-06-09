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
| Rules       | Amend rule button navigates to rules?focus=autofix    | `e2e/specs/rules/rule-drawer.smoke.spec.ts` (extended)             |   ✅   |
| Editor      | Import dialog back-to-types button returns to landing | `e2e/specs/editor/import-back-to-types.smoke.spec.ts`              |   ✅   |
| Projects    | Terminology candidate term "Promote to managed" opens Edit concept dialog | `e2e/specs/projects/terminology-promote-candidate.smoke.spec.ts` | ✅ |
| Editor      | File rename suggestion banner (numbered family) appears and can be dismissed | `e2e/specs/editor/suggestion-banner-dismiss.smoke.spec.ts` | ✅ |
| Editor      | Suggestion banner Apply all renames files and shows undo toast; Undo reverts | `e2e/specs/editor/suggestion-banner-apply-undo.smoke.spec.ts` | ✅ |
| Editor      | Suggestion banner Review dialog shows per-file checkboxes; Cancel closes     | `e2e/specs/editor/suggestion-banner-review-dialog.smoke.spec.ts` | ✅ |
| Editor      | Expand file row in sidebar reveals FileSectionGrid section rows; click navigates | `e2e/specs/editor/sidebar-file-expand-sections.smoke.spec.ts` | ✅ |
| Editor      | Per-file "Apply rename suggestion" sparkle applies one rename and shows undo toast | `e2e/specs/editor/suggestion-banner-per-file-apply.smoke.spec.ts` | ✅ |
| Rules       | Delete a custom rule removes it from the list          | `e2e/specs/rules/rule-delete.smoke.spec.ts`             |   ✅   |
| Terminology | Delete managed concept removes it from the list        | `e2e/specs/projects/terminology-delete-concept.smoke.spec.ts` | ✅ |
| Editor      | Pre-acceptance warning band for forbidden terminology rendering | `e2e/specs/editor/preacceptance-warning-band.smoke.spec.ts` | ✅ |
| Editor      | RTL hint "Adjust" button opens view settings menu and dismisses hint | `e2e/specs/editor/rtl-hint-adjust-opens-settings.smoke.spec.ts` | ✅ |
| Editor      | Workspace "Settings" dropdown item navigates to project settings     | `e2e/specs/editor/workspace-settings-navigate.smoke.spec.ts`   |   ✅   |
| Projects    | Settings nav section link click scrolls to anchor      | `e2e/specs/projects/project-settings-nav-link-click.smoke.spec.ts` | ✅ |
| Editor      | "Next unfinished" button enabled after import; navigates without error | `e2e/specs/editor/next-unfinished-button.smoke.spec.ts` | ✅ |
| Editor      | EditorModeToggle Text↔Audio lens switch (aria-pressed) | `e2e/specs/editor/editor-mode-toggle.smoke.spec.ts`     |   ✅   |
| Editor      | Bold keyboard shortcut (Ctrl+B) toggles bold mark     | `e2e/specs/editor/formatting-bold-keyboard-shortcut.smoke.spec.ts` | ✅ |
| Editor      | Escape key clears cell selection (no editable focused) | `e2e/specs/editor/selection-clear-escape.smoke.spec.ts`           |   ✅   |
| Comments    | Submit comment via Ctrl+Enter keyboard shortcut        | `e2e/specs/editor/comment-submit-keyboard.smoke.spec.ts`          |   ✅   |
| Terminology | Violations inbox: expand concept row → see cell violations | `e2e/specs/projects/terminology-violations-expand.smoke.spec.ts` | ✅ |
| Comments    | CommentsPage Refresh button reloads data              | `e2e/specs/editor/comments-page-refresh.smoke.spec.ts`        |   ✅   |
| Comments    | CommentsPage "Back to project" returns to workspace   | `e2e/specs/editor/comments-page-back-nav.smoke.spec.ts`       |   ✅   |
| Auth        | Account switcher renders signed-in accounts           | `e2e/specs/orgs/account-switcher.smoke.spec.ts`               |   ✅   |
| Auth        | Signup form show/hide password + checklist            | `e2e/specs/orgs/account-signup-form.smoke.spec.ts` + `account-signup-password-checklist.smoke.spec.ts` | ✅ |
| Auth        | Login form show/hide password toggle                  | `e2e/specs/orgs/login-form-show-hide-password.smoke.spec.ts`  |   ✅   |
| Auth        | Forgot password flow opens reset form                 | `e2e/specs/orgs/account-add-forgot-password.smoke.spec.ts` + `account-reset-password-form.smoke.spec.ts` | ✅ |
| Auth        | Dev-only logout route clears session → /onboarding    | `e2e/specs/auth/dev-logout-route.smoke.spec.ts`               |   ✅   |
| Onboarding  | Wizard renders name step and advances                 | `e2e/specs/projects/onboarding-wizard.smoke.spec.ts` + `onboarding-name-step.smoke.spec.ts` + `onboarding-privacy-continue.smoke.spec.ts` + `onboarding-project-step.smoke.spec.ts` | ✅ |
| Projects    | Archive and restore project                           | `e2e/specs/projects/archive.smoke.spec.ts`                    |   ✅   |
| Projects    | Archived projects page lists archived items           | `e2e/specs/projects/archived-projects-page.smoke.spec.ts`     |   ✅   |
| Projects    | Project deadline set and clear                        | `e2e/specs/projects/project-deadline.smoke.spec.ts`           |   ✅   |
| Projects    | Project overview assign work form                     | `e2e/specs/projects/project-overview-assign-work.smoke.spec.ts` + `project-overview-assign-work-submit.smoke.spec.ts` | ✅ |
| Projects    | Project overview overflow menu (archive/share/etc.)   | `e2e/specs/projects/project-overview-overflow-menu.smoke.spec.ts` |   ✅   |
| Projects    | Projects list page renders project cards              | `e2e/specs/projects/projects-list-page.smoke.spec.ts`         |   ✅   |
| Projects    | Project card role badge shows user's role             | `e2e/specs/projects/project-card-role-badge.smoke.spec.ts`    |   ✅   |
| Projects    | Org home project name filter narrows list             | `e2e/specs/projects/org-home-project-filter.smoke.spec.ts`    |   ✅   |
| Projects    | Org home status filter (All/Active/Stalled/Overdue)   | `e2e/specs/projects/org-home-status-filter.smoke.spec.ts`     |   ✅   |
| Projects    | Project settings user section (username/author)       | `e2e/specs/projects/project-settings-user-section.smoke.spec.ts` |   ✅   |
| Projects    | Project settings AI instructions textarea             | `e2e/specs/projects/project-settings-ai-instructions.smoke.spec.ts` |   ✅   |
| Projects    | Project settings context controls section             | `e2e/specs/projects/project-settings-context-controls.smoke.spec.ts` |   ✅   |
| Projects    | Project settings terminology link navigates           | `e2e/specs/projects/project-settings-terminology-link.smoke.spec.ts` |   ✅   |
| Projects    | Project settings voice studio link navigates          | `e2e/specs/projects/project-settings-voice-studio-link.smoke.spec.ts` |   ✅   |
| Projects    | Project settings assistant language select            | `e2e/specs/projects/project-settings-assistant-language.smoke.spec.ts` |   ✅   |
| Projects    | Project settings API key show/hide toggle             | `e2e/specs/projects/project-settings-api-key-toggle.smoke.spec.ts` |   ✅   |
| Projects    | Project settings termbase sharing section             | `e2e/specs/projects/project-settings-termbase-sharing.smoke.spec.ts` |   ✅   |
| Projects    | Multi-project invite submit from share panel          | `e2e/specs/projects/multi-project-invite-submit.smoke.spec.ts` |   ✅   |
| Orgs        | Org rename from org switcher                          | `e2e/specs/orgs/org-switcher-rename.smoke.spec.ts` + `org-rename.smoke.spec.ts` | ✅ |
| Orgs        | Org settings page renders and shows rename            | `e2e/specs/orgs/org-settings.smoke.spec.ts` + `org-settings-rename.smoke.spec.ts` | ✅ |
| Orgs        | Members matrix drill-down row per member              | `e2e/specs/orgs/members-matrix-drill-down.smoke.spec.ts`      |   ✅   |
| Orgs        | Members matrix add role via cell editor               | `e2e/specs/orgs/members-matrix-add-role.smoke.spec.ts`        |   ✅   |
| Orgs        | Members matrix remove role via cell editor            | `e2e/specs/orgs/members-matrix-remove-role.smoke.spec.ts`     |   ✅   |
| Orgs        | Member access panel expand shows per-project access   | `e2e/specs/orgs/member-access-panel-expand.smoke.spec.ts`     |   ✅   |
| Orgs        | Assigned to me page shows inbox                       | `e2e/specs/orgs/assigned-to-me-page.smoke.spec.ts` + `assigned.smoke.spec.ts` | ✅ |
| Orgs        | Preferences page analytics toggle                     | `e2e/specs/orgs/preferences-analytics-toggle.smoke.spec.ts` + `preferences-analytics-disabled-warning.smoke.spec.ts` | ✅ |
| Orgs        | Preferences AI provider expand/save/clear             | `e2e/specs/orgs/preferences-ai-provider.smoke.spec.ts` + `preferences-ai-provider-expand.smoke.spec.ts` + `preferences-ai-provider-save.smoke.spec.ts` | ✅ |
| Orgs        | Access model legend dialog opens                      | `e2e/specs/orgs/access-model-legend.smoke.spec.ts`            |   ✅   |
| Orgs        | Team create, rename, edit description                 | `e2e/specs/orgs/teams.smoke.spec.ts` + `team-rename.smoke.spec.ts` + `team-edit-description.smoke.spec.ts` | ✅ |
| Orgs        | Team add/remove member, change role                   | `e2e/specs/orgs/team-add-member.smoke.spec.ts` + `team-remove-member.smoke.spec.ts` + `team-member-role-change.smoke.spec.ts` | ✅ |
| Orgs        | Team attach/detach project                            | `e2e/specs/orgs/team-attach-project.smoke.spec.ts` + `team-detach-project.smoke.spec.ts` | ✅ |
| Orgs        | Team delete dialog                                    | `e2e/specs/orgs/team-delete.smoke.spec.ts`                    |   ✅   |
| Orgs        | Teams sort and filter                                 | `e2e/specs/orgs/teams-sort-and-filter.smoke.spec.ts`          |   ✅   |
| Orgs        | Color theme picker                                    | `e2e/specs/orgs/color-theme-picker.smoke.spec.ts`             |   ✅   |
| Orgs        | Theme toggle (dark/light)                             | `e2e/specs/orgs/theme-toggle.smoke.spec.ts`                   |   ✅   |
| Editor      | Cell action popover shows Record audio + Add comment  | `e2e/specs/editor/cell-action-popover.smoke.spec.ts`          |   ✅   |
| Editor      | Cell details expansion panel tabs (Decay/BT/Issues/History) | `e2e/specs/editor/cell-details.smoke.spec.ts` + `cell-expansion-bt-tab.smoke.spec.ts` + `cell-expansion-decay-tab.smoke.spec.ts` + `cell-expansion-issues-tab.smoke.spec.ts` | ✅ |
| Editor      | Issue pill hover popover shows rule infraction details | `e2e/specs/editor/issue-pill-hover-popover.smoke.spec.ts`    |   ✅   |
| Editor      | /project/:id/voice deep-link activates audio lens     | `e2e/specs/editor/voice-deep-link.smoke.spec.ts`              |   ✅   |
| Editor      | Cell history drawer shows edit history                | `e2e/specs/editor/cell-history-drawer.smoke.spec.ts`          |   ✅   |
| Editor      | Decay breakdown popover opens from cell indicator     | `e2e/specs/editor/decay-breakdown-popover.smoke.spec.ts`      |   ✅   |
| Editor      | Sync status indicator in workspace status bar         | `e2e/specs/editor/sync-status-indicator.smoke.spec.ts`        |   ✅   |
| Editor      | Workspace status bar shows file progress              | `e2e/specs/editor/workspace-status-bar.smoke.spec.ts`         |   ✅   |
| Editor      | Workspace breadcrumb back button navigates            | `e2e/specs/editor/workspace-breadcrumb-back.smoke.spec.ts`    |   ✅   |
| Editor      | Workspace header dashboard link navigates home        | `e2e/specs/editor/workspace-header-dashboard-link.smoke.spec.ts` |   ✅   |
| Editor      | Workspace overflow close project navigates dashboard  | `e2e/specs/editor/workspace-overflow-close-project.smoke.spec.ts` |   ✅   |
| Editor      | Tab strip open/close file tabs                        | `e2e/specs/editor/tab-strip.smoke.spec.ts`                    |   ✅   |
| Editor      | File filter sidebar input narrows file list           | `e2e/specs/editor/file-filter.smoke.spec.ts`                  |   ✅   |
| Editor      | File move to corpus dialog                            | `e2e/specs/editor/file-move-corpus.smoke.spec.ts`             |   ✅   |
| Editor      | File delete via right-click menu                      | `e2e/specs/editor/file-delete.smoke.spec.ts`                  |   ✅   |
| Editor      | File rename via right-click menu                      | `e2e/specs/editor/file-rename.smoke.spec.ts`                  |   ✅   |
| Editor      | No-file placeholder renders when no file open         | `e2e/specs/editor/editor-no-file-placeholder.smoke.spec.ts`   |   ✅   |
| Editor      | Confirm action dialog requires checkbox               | `e2e/specs/editor/confirm-action-dialog-checkbox.smoke.spec.ts` |   ✅   |
| Editor      | Sidebar corpus collapse toggle                        | `e2e/specs/editor/sidebar-corpus-collapse.smoke.spec.ts`      |   ✅   |
| Editor      | Import dialog opens and shows upload/eBible options   | `e2e/specs/editor/import-dialog.smoke.spec.ts`                |   ✅   |
| Editor      | eBible import search and select corpus                | `e2e/specs/editor/import-dialog-ebible.smoke.spec.ts` + `import-dialog-ebible-search.smoke.spec.ts` | ✅ |
| Editor      | Export scope toggle (file vs project)                 | `e2e/specs/editor/export-scope-toggle.smoke.spec.ts`          |   ✅   |
| Editor      | Export lossy format warning badge                     | `e2e/specs/editor/export-lossy-warning.smoke.spec.ts`         |   ✅   |
| Editor      | Search scope toggle (file / project / passages)       | `e2e/specs/editor/search-scope-toggle.smoke.spec.ts`          |   ✅   |
| Editor      | Search mode passages toggle                           | `e2e/specs/editor/search-mode-passages-toggle.smoke.spec.ts`  |   ✅   |
| Editor      | Ctrl+Shift+R opens search+replace panel               | `e2e/specs/editor/search-replace-keyboard-shortcut.smoke.spec.ts` |   ✅   |
| Editor      | Ctrl+Shift+F opens search in project scope            | `e2e/specs/editor/search-shift-f-project-scope.smoke.spec.ts` |   ✅   |
| Editor      | Outbox inspector popover shows pending ops            | `e2e/specs/editor/outbox-inspector-popover.smoke.spec.ts`     |   ✅   |
| Editor      | Selection bar bulk validate + unvalidate              | `e2e/specs/editor/selection-bar.smoke.spec.ts` + `selection-bar-bulk-validate.smoke.spec.ts` + `selection-bar-unvalidate.smoke.spec.ts` + `selection-bar-clear.smoke.spec.ts` | ✅ |
| Editor      | Formatting italic toggle via toolbar                  | `e2e/specs/editor/formatting-italic-toggle.smoke.spec.ts`     |   ✅   |
| Editor      | View settings menu toggles line numbers + cell labels | `e2e/specs/editor/view-settings-menu.smoke.spec.ts` + `view-settings-cell-labels-toggle.smoke.spec.ts` + `view-settings-text-direction.smoke.spec.ts` | ✅ |
| Editor      | RTL hint dismiss button removes hint                  | `e2e/specs/editor/rtl-hint-dismiss.smoke.spec.ts`             |   ✅   |
| Editor      | Video attachment remove clears saved URL              | `e2e/specs/editor/video-attachment-dialog.smoke.spec.ts`      |   ✅   |
| Editor      | Setup checklist drawer expands items + skip           | `e2e/specs/editor/setup-checklist.smoke.spec.ts` + `setup-checklist-item-expand.smoke.spec.ts` + `setup-checklist-skip.smoke.spec.ts` | ✅ |
| Editor      | Setup checklist AI models section expand              | `e2e/specs/editor/setup-checklist-ai-models-expand.smoke.spec.ts` |   ✅   |
| Editor      | Setup checklist invite creates share link             | `e2e/specs/editor/setup-checklist-invite-create-link.smoke.spec.ts` |   ✅   |
| Editor      | AI setup dialog opens and configures provider         | `e2e/specs/editor/ai-setup-dialog.smoke.spec.ts` + `ai-setup-dialog-custom-provider.smoke.spec.ts` | ✅ |
| Editor      | AI completion dialog opens (mock LLM)                 | `e2e/specs/editor/ai-completion-dialog.smoke.spec.ts`         |   ✅   |
| Comments    | Comments page filters expand                          | `e2e/specs/editor/comments-filters-expand.smoke.spec.ts`      |   ✅   |
| Comments    | Comments page show resolved toggle                    | `e2e/specs/editor/comments-show-resolved.smoke.spec.ts`       |   ✅   |
| Comments    | Comments page sort select changes order               | `e2e/specs/editor/comments-sort-select.smoke.spec.ts`         |   ✅   |
| Comments    | Comments page search box filters threads              | `e2e/specs/editor/comments-search-filter.smoke.spec.ts`       |   ✅   |
| Comments    | Comment close with reply button                       | `e2e/specs/editor/comment-close-with-reply.smoke.spec.ts`     |   ✅   |
| Comments    | Cross-user comment visibility                         | `e2e/specs/collab/cross-user-comment.smoke.spec.ts`           |   ✅   |
| Comments    | Cross-user validation visibility                      | `e2e/specs/collab/cross-user-validate.smoke.spec.ts`          |   ✅   |
| Rules       | Edit rule inline                                      | `e2e/specs/rules/edit-rule.smoke.spec.ts`                     |   ✅   |
| Rules       | Rule toggle enabled/disabled                          | `e2e/specs/rules/rule-toggle-enabled.smoke.spec.ts` + `rule-editor-enabled-checkbox.smoke.spec.ts` | ✅ |
| Rules       | Built-in rule enable toggle + severity                | `e2e/specs/rules/builtin-rule-enable-toggle.smoke.spec.ts` + `builtin-rule-severity.smoke.spec.ts` | ✅ |
| Rules       | Org rule enable toggle                                | `e2e/specs/rules/org-rule-enable-toggle.smoke.spec.ts`        |   ✅   |
| Rules       | Org rule create                                       | `e2e/specs/rules/org-rule-create.smoke.spec.ts`               |   ✅   |
| Rules       | Rule row expand/collapse                              | `e2e/specs/rules/rule-row-expand.smoke.spec.ts`               |   ✅   |
| Rules       | Rule editor mode/severity/regex/autofix toggles       | `e2e/specs/rules/rule-editor-mode-selector.smoke.spec.ts` + `rule-editor-severity-toggle.smoke.spec.ts` + `rule-editor-regex-toggle.smoke.spec.ts` + `rule-editor-autofix-toggle.smoke.spec.ts` | ✅ |
| Rules       | Rule dialogs (import/suggest disabled states)         | `e2e/specs/rules/rule-dialogs.smoke.spec.ts` + `rule-import-dialog-disabled.smoke.spec.ts` + `rule-suggest-dialog-disabled.smoke.spec.ts` | ✅ |
| Rules       | Rules page add rule dialog opens                      | `e2e/specs/rules/rules-page-add-rule-dialog.smoke.spec.ts`    |   ✅   |
| Rules       | Rules page back to editor navigation                  | `e2e/specs/rules/rules-page-back-to-editor.smoke.spec.ts`     |   ✅   |
| Rules       | Rule create dialog test button                        | `e2e/specs/rules/rule-create-dialog-test-button.smoke.spec.ts` |   ✅   |
| Rules       | Violation popover shows details                       | `e2e/specs/rules/violation-popover.smoke.spec.ts`             |   ✅   |
| Terminology | Terminology page renders + add concept dialog         | `e2e/specs/projects/terminology.smoke.spec.ts` + `terminology-add-concept.smoke.spec.ts` | ✅ |
| Terminology | Edit concept dialog                                   | `e2e/specs/projects/terminology-edit-concept.smoke.spec.ts`   |   ✅   |
| Terminology | Concept status select (draft/approved/old)            | `e2e/specs/projects/terminology-concept-status-select.smoke.spec.ts` |   ✅   |
| Terminology | Concept notes field                                   | `e2e/specs/projects/terminology-concept-notes.smoke.spec.ts`  |   ✅   |
| Terminology | Add rendering to concept                              | `e2e/specs/projects/terminology-add-rendering.smoke.spec.ts`  |   ✅   |
| Terminology | Rendering status select (preferred/alternate/forbidden)| `e2e/specs/projects/terminology-rendering-status-select.smoke.spec.ts` |   ✅   |
| Terminology | Term detail popover from concept row                  | `e2e/specs/projects/terminology-term-detail.smoke.spec.ts`    |   ✅   |
| Terminology | Candidate terms tab renders mined terms               | `e2e/specs/projects/terminology-candidates-tab.smoke.spec.ts` |   ✅   |
| Terminology | Export CSV and TBX buttons                           | `e2e/specs/projects/terminology-export.smoke.spec.ts`         |   ✅   |
| Terminology | Import termbase dialog opens                          | `e2e/specs/projects/terminology-import-dialog.smoke.spec.ts`  |   ✅   |
| Terminology | Term lookup popover + apply rendering                 | `e2e/specs/projects/term-lookup-popover.smoke.spec.ts` + `term-lookup-apply-rendering.smoke.spec.ts` | ✅ |
| Memory      | Living memory page renders entries                    | `e2e/specs/projects/living-memory.smoke.spec.ts`              |   ✅   |
| Memory      | Add / edit / delete living memory entry               | `e2e/specs/projects/living-memory-add-entry.smoke.spec.ts` + `living-memory-edit-entry.smoke.spec.ts` + `living-memory-delete-entry.smoke.spec.ts` | ✅ |
| Memory      | Living memory empty state                             | `e2e/specs/projects/living-memory-empty-state.smoke.spec.ts`  |   ✅   |
| Memory      | Living memory standards section                       | `e2e/specs/projects/living-memory-standards-section.smoke.spec.ts` |   ✅   |
| Voice       | Voice creation and engine select                      | `e2e/specs/orgs/voice-creation.smoke.spec.ts` + `voice-engine-select.smoke.spec.ts` | ✅ |
| Voice       | Voice color picker                                    | `e2e/specs/orgs/voice-color-picker.smoke.spec.ts`             |   ✅   |
| Voice       | Voice make default + save                             | `e2e/specs/orgs/voice-make-default.smoke.spec.ts` + `voice-save.smoke.spec.ts` | ✅ |
| Voice       | Voice Gemini API key toggle                           | `e2e/specs/orgs/voice-gemini-api-key-toggle.smoke.spec.ts`    |   ✅   |
| Voice       | Audio mode lens toggle in workspace                   | `e2e/specs/orgs/audio-mode.smoke.spec.ts`                     |   ✅   |
| Voice       | Audio by character view                               | `e2e/specs/orgs/audio-by-character.smoke.spec.ts`             |   ✅   |
| Voice       | Audio recording modal opens                           | `e2e/specs/orgs/audio-recording-modal.smoke.spec.ts`          |   ✅   |
| Projects    | Org overview page renders rollup + filter             | `e2e/specs/projects/org-overview.smoke.spec.ts`               |   ✅   |
| Projects    | Project create form validation (name + source required) | `e2e/specs/projects/project-create-form-validation.smoke.spec.ts` |   ✅   |
| Projects    | Project create language tooltip                       | `e2e/specs/projects/project-create-language-tooltip.smoke.spec.ts` |   ✅   |
| Projects    | Project create advanced shape section (radio buttons) | `e2e/specs/projects/project-create-advanced-shape.smoke.spec.ts` |   ✅   |
| Projects    | Project settings advanced LLM section expands         | `e2e/specs/projects/project-settings-advanced-llm.smoke.spec.ts` |   ✅   |
| Projects    | Project settings audio media strategy buttons         | `e2e/specs/projects/project-settings-audio-strategy.smoke.spec.ts` |   ✅   |
| Projects    | Project settings decay section expands                | `e2e/specs/projects/project-settings-decay.smoke.spec.ts`     |   ✅   |
| Projects    | Project settings more save options → Close without saving | `e2e/specs/projects/project-settings-more-save-options.smoke.spec.ts` |   ✅   |
| Projects    | Project settings named validators input               | `e2e/specs/projects/project-settings-named-validators.smoke.spec.ts` |   ✅   |
| Projects    | Project settings nav search filter                    | `e2e/specs/projects/project-settings-nav-search.smoke.spec.ts` |   ✅   |
| Projects    | Project settings termbase publish toggle              | `e2e/specs/projects/project-settings-termbase-publish-toggle.smoke.spec.ts` |   ✅   |
| Projects    | Project settings validation section                   | `e2e/specs/projects/project-settings-validation.smoke.spec.ts` + `project-settings-validation-count.smoke.spec.ts` | ✅ |
| Projects    | Assign work panel in project overview                 | `e2e/specs/projects/assign-work-panel.smoke.spec.ts`          |   ✅   |
| Projects    | All routes return 200 / don't crash                   | `e2e/specs/projects/route-health.smoke.spec.ts`               |   ✅   |
| Sharing     | Share dialog opens with correct default state         | `e2e/specs/projects/share-dialog.smoke.spec.ts`               |   ✅   |
| Sharing     | Invite email validation (invalid email stays disabled) | `e2e/specs/projects/share-invite-email-validation.smoke.spec.ts` |   ✅   |
| Sharing     | Invite expiry select changes expiry                   | `e2e/specs/projects/share-invite-expiry-select.smoke.spec.ts` |   ✅   |
| Sharing     | Invite role select changes role                       | `e2e/specs/projects/share-invite-role-select.smoke.spec.ts`   |   ✅   |
| Sharing     | Invite @username verified chip appears                | `e2e/specs/projects/share-invite-username-verified.smoke.spec.ts` |   ✅   |
| Rules       | Rule promote to org dialog                            | `e2e/specs/rules/rule-promote-to-org.smoke.spec.ts`           |   ✅   |
| Rules       | Rules page terminology link navigates                 | `e2e/specs/rules/rules-page-terminology-link.smoke.spec.ts`   |   ✅   |
| Rules       | Waive and unwaive a violation                         | `e2e/specs/rules/waive-violation.smoke.spec.ts`               |   ✅   |
| Terminology | Violations tab shows inbox content                    | `e2e/specs/projects/terminology-violations-tab.smoke.spec.ts` |   ✅   |
| Editor      | Setup checklist AI instructions edit + reset          | `e2e/specs/editor/setup-checklist-ai-instructions-edit.smoke.spec.ts` |   ✅   |
| Editor      | Workspace actions dropdown lists available actions    | `e2e/specs/editor/workspace-actions-dropdown.smoke.spec.ts`   |   ✅   |
| Editor      | Workspace actions cell scroll to target cell          | `e2e/specs/editor/workspace-actions-cell-scroll.smoke.spec.ts` |   ✅   |
| Debug       | Debug view accessible at /debug                       | `e2e/specs/editor/debug-view.smoke.spec.ts`                   |   ✅   |
| Debug       | Admin console tabs (users/orgs/projects/teams/activity) | `e2e/specs/orgs/admin-console.smoke.spec.ts` + `admin-console-users-tab.smoke.spec.ts` + `admin-console-orgs-tab.smoke.spec.ts` + `admin-console-projects-tab.smoke.spec.ts` + `admin-console-teams-tab.smoke.spec.ts` + `admin-console-activity-tab.smoke.spec.ts` | ✅ |
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
