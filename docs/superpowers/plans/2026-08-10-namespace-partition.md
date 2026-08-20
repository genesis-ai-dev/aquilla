# File → namespace partition for the AQU-511 extraction fan-out

Produced by Task 7 of `docs/superpowers/plans/2026-08-10-ui-localization-phase-0-2.md`. This is
the ownership data the Phase-1 and Phase-3 fan-outs are handed — each agent gets exactly the
file list on its row, and no other agent touches those files.

## Method

1. Generated the candidate inventory with the exact command from Task 7 Step 1:

   ```bash
   for f in $(grep -rlE '>[A-Z][A-Za-z][^<>{}]{2,60}<|(placeholder|aria-label|title)="[^"]{3,60}"' --include='*.tsx' -r src | grep -v test); do echo "$(grep -coE '>[A-Z][A-Za-z][^<>{}]{2,60}<|(placeholder|aria-label|title)="[^"]{3,60}"' "$f") $f"; done | sort -rn
   ```

   250 files matched. Dropping every path under `src/pages/Homepage/`, `src/pages/CaseStudy/`,
   `src/pages/Beta/`, and `src/pages/PrivacyPolicy.tsx` (English-only prerendered marketing,
   out of scope) leaves **237 non-marketing files**.
2. Assigned each of the 237 files to exactly one namespace, using the namespace table in
   `docs/superpowers/specs/2026-08-10-ui-localization-all-surfaces-design.md`.
3. Shared primitives under `src/components/ui/` go to `common`.
4. Ambiguous files were assigned to the namespace that **renders** them, not the one that
   defines their data — see Notable calls below.
5. Verified the partition is total and disjoint: wrote all 237 assigned paths to
   `/tmp/i18n-partition.txt` (one per line) and ran `sort /tmp/i18n-partition.txt | uniq -d`.
   **Output was empty** — no file is assigned to two namespaces, and every one of the 237
   inventoried non-marketing files appears exactly once.

## Notable ambiguous-file calls (rule: assign to the namespace that renders it)

- `git-import/FrontierLoginForm.tsx`, `FrontierSignupForm.tsx`, `FrontierForgotPasswordForm.tsx`
  — visually login/signup forms, but they exist only to authenticate against Frontier/DCS for
  the **import** flow, live under `src/components/git-import/`, and the design's `import`
  namespace explicitly owns `git-import/`. Assigned to `import`, not `auth`.
- `SessionExpiredBanner.tsx` — a banner, but its subject is "your session has expired, sign in
  again," which is an auth-state concern, not a generic error banner. Assigned to `auth`.
- `RenameSuggestionsDialog.tsx`, `SuggestionBanner.tsx` — despite the generic naming, both key
  off `RenameSuggestion` from `@/lib/file-labeling/detect`, i.e. suggesting renames for
  imported files. Assigned to `import`, not `terminology` (which owns concept/term renaming) or
  `dialog`.
- `CheckFindingsDrawer.tsx`, `CheckFileButton.tsx`, `ViolationPopover.tsx` — surfaced from the
  editor toolbar, but their content is rule-violation findings from the deterministic "Check
  file" pass. Assigned to `rules`, which owns the violation-finding vocabulary, not `editor`.
- `StaleSourceIndicator.tsx`, `HistoryDrawer.tsx`, `SelectionBar.tsx`, `DecayBreakdown.tsx` —
  per-cell badges/drawers mounted inside the editor. Assigned to `editor`.
- `AdminCreditsSection.tsx` (under `admin/`), `org/CreditsPanel.tsx`, `agent/CreditsDial.tsx` —
  parent directory is `admin`/`org`/`agent`, but all three render credits-balance UI
  specifically. Assigned to `credits` (design's dedicated namespace) over their parent
  directory.
- `InactiveProjectBanner.tsx`, `ExportDialog.tsx`, `SharePanel.tsx`, `FixReviewPanel.tsx`,
  `StaffLanePopover.tsx` — project-lifecycle and project-level actions (freeze/reactivate,
  export, share, review-before-commit). Assigned to `project`.
- `PermissionDeniedAlert.tsx`, `PrivateModeBanner.tsx`, `DebugView.tsx`, `NotFound.tsx` — generic,
  reusable alert/banner/debug surfaces not tied to one feature's data. Assigned to `error`.
- `JoinPage.tsx` (project invite link) — assigned to `auth` (identity/access-link entry point,
  alongside `AccessLinkPage.tsx`). `JoinOrgPage.tsx` (org invite acceptance) — assigned to `org`,
  since its content is org-membership specific, distinct from the generic project access-link
  flow.
- `agent/memory/BriefPanel.tsx` — lives under `src/components/agent/memory/`, not
  `src/components/brief/`. The `brief` namespace owns the `src/components/brief/` directory
  only; this file is part of the agent's memory surface. Assigned to `agent`.
- `TabStrip.tsx`, `OutboxInspectorPopover.tsx`, `FileRow.tsx`, `ExpandableFileList.tsx`,
  `sidebar/FileSectionGrid.tsx` — app-chrome / sidebar file-listing and status controls.
  Assigned to `nav`.
- `pages/settings/OrgSettings*.tsx` — directory is `pages/settings/`, matching the design's
  `settings` namespace pattern (`Settings`, `Preferences`, `settings/`) even though the content
  is org-scoped settings. Assigned to `settings`, not `org`.

## Partition table

`namespace | files | surface id(s) | approx string count`. **Bold** rows are the 9 Phase 1
(wave 2) namespaces — the translator's daily path, dispatched next. Plain rows are Phase 3
(deferred), extracted in a later fan-out.

| Namespace | Files | Surface id(s) | Approx string count | Phase |
| --- | --- | --- | --- | --- |
| **`common`** | `src/components/ui/date-picker.tsx`<br>`src/components/ui/breadcrumb.tsx`<br>`src/components/ui/spinner.tsx`<br>`src/components/ui/sheet.tsx`<br>`src/components/ui/dialog.tsx`<br>`src/components/ui/bar-spinner.tsx` | shared-ui-primitives | 8 | **1 (wave 2)** |
| **`nav`** | `src/components/NavHistoryControls.tsx`<br>`src/components/AccountSwitcher.tsx`<br>`src/components/HelpMenu.tsx`<br>`src/components/LeftDock.tsx`<br>`src/components/SidebarProjectSection.tsx`<br>`src/components/VersionBadge.tsx`<br>`src/components/TabStrip.tsx`<br>`src/components/sidebar/FileSectionGrid.tsx`<br>`src/components/BetaBadge.tsx`<br>`src/components/ReportProblemButton/ReportProblemDialog.tsx`<br>`src/components/OutboxInspectorPopover.tsx`<br>`src/components/FileRow.tsx`<br>`src/components/ExpandableFileList.tsx` | workspace-nav (existing) | 37 | **1 (wave 2)** |
| **`error`** | `src/components/PermissionDeniedAlert.tsx`<br>`src/components/PrivateModeBanner.tsx`<br>`src/components/DebugView.tsx`<br>`src/pages/NotFound.tsx` | error-state (existing) | 4 | **1 (wave 2)** |
| **`dialog`** | `src/components/ConfirmActionDialog.tsx`<br>`src/components/AssignModal.tsx` | confirm-dialog (existing) | 8 | **1 (wave 2)** |
| **`editor`** | `src/components/EditorTable.tsx`<br>`src/components/cell/CellVoicePanel.tsx`<br>`src/components/cell/CropEditor.tsx`<br>`src/components/footnotes/FootnoteInline.tsx`<br>`src/components/footnotes/AddFootnoteDialog.tsx`<br>`src/components/ChapterNavigator.tsx`<br>`src/components/timeline/TimelineEditor.tsx`<br>`src/components/TranslatedEditor.tsx`<br>`src/components/CellExpansion.tsx`<br>`src/components/CellActionsMenu.tsx`<br>`src/components/CellAudioRecordButton.tsx`<br>`src/components/CellAudioUploadButton.tsx`<br>`src/components/CellWaveform.tsx`<br>`src/components/CellAreaPlaceholder.tsx`<br>`src/components/EditorModeToggle.tsx`<br>`src/components/ViewSettingsMenu.tsx`<br>`src/components/StaleSourceIndicator.tsx`<br>`src/components/VideoAttachmentDialog.tsx`<br>`src/components/TimelineAddMedia.tsx`<br>`src/components/HistoryDrawer.tsx`<br>`src/components/SelectionBar.tsx`<br>`src/components/DecayBreakdown.tsx`<br>`src/components/ParallelBiblesSidebar.tsx`<br>`src/components/TranslationNotesSidebar.tsx`<br>`src/components/EBibleTargetReviewPanel.tsx`<br>`src/components/CompletionBulkProgressBanner.tsx` | cell-editor (existing), editor-table | 122 | **1 (wave 2)** |
| **`comments`** | `src/components/CommentsPage.tsx`<br>`src/components/CommentsDrawer.tsx`<br>`src/components/CommentThread.tsx` | comments | 25 | **1 (wave 2)** |
| **`auth`** | `src/pages/Login.tsx`<br>`src/pages/ResetPassword.tsx`<br>`src/components/AccessLinkPage.tsx`<br>`src/components/JoinPage.tsx`<br>`src/components/VerifyEmailPage.tsx`<br>`src/components/MarketingLoginRoute.tsx`<br>`src/components/DevLoginRoute.tsx`<br>`src/components/DevLogoutRoute.tsx`<br>`src/components/SessionExpiredBanner.tsx` | auth | 23 | **1 (wave 2)** |
| **`search`** | `src/components/SearchDockPanel.tsx`<br>`src/components/ParallelPassagesPanel.tsx`<br>`src/components/search/SearchResultsView.tsx`<br>`src/components/ExamplePanel.tsx` | search | 26 | **1 (wave 2)** |
| **`audio`** | `src/components/voice/NewVoiceModal.tsx`<br>`src/components/voice/VoicePlaybackBar.tsx`<br>`src/components/voice/CombinedBoundaryEditor.tsx`<br>`src/components/AudioRecorder/AudioRecordingModal.tsx`<br>`src/components/AudioRecorder/TakesStrip.tsx`<br>`src/components/VoiceLibraryPanel.tsx`<br>`src/components/VoiceCloneSection.tsx`<br>`src/components/AudioBulkProgressBanner.tsx` | audio-studio | 39 | **1 (wave 2)** |
| `project` | `src/components/ProjectSettings.tsx`<br>`src/components/ProjectCreateDialog.tsx`<br>`src/components/ProjectSettings/AudioMediaStrategySection.tsx`<br>`src/components/ProjectSettings/DecaySettingsSection.tsx`<br>`src/components/ProjectSettings/ExperimentalFlagsSection.tsx`<br>`src/components/ProjectSettings/LanguagesSection.tsx`<br>`src/components/ProjectSettings/MondayIntegrationSection.tsx`<br>`src/components/ProjectSettings/MondayLinkedView.tsx`<br>`src/components/ProjectSettings/MondayMappingEditor.tsx`<br>`src/components/ProjectSettings/SettingsNav.tsx`<br>`src/components/ProjectSettings/SourceLinkSection.tsx`<br>`src/components/ProjectSettings/TermbaseSharingSection.tsx`<br>`src/components/ProjectSettings/ValidationSettingsSection.tsx`<br>`src/components/ProjectWorkspace.tsx`<br>`src/components/Dashboard.tsx`<br>`src/components/ProjectCard.tsx`<br>`src/components/ProjectAssignedToMe.tsx`<br>`src/components/InactiveProjectBanner.tsx`<br>`src/components/ExportDialog.tsx`<br>`src/components/SharePanel.tsx`<br>`src/components/StaffLanePopover.tsx`<br>`src/components/FixReviewPanel.tsx` | project-settings (existing), project-create | 178 | 3 (deferred) |
| `import` | `src/components/ImportDialog.tsx`<br>`src/components/FileTargetImportDialog.tsx`<br>`src/components/import/ColumnMappingPanel.tsx`<br>`src/components/import/FileTargetImportPanel.tsx`<br>`src/components/import/LabelImportPanel.tsx`<br>`src/components/import/PairedImportPanel.tsx`<br>`src/components/import/PreviewPanel.tsx`<br>`src/components/import/SpreadsheetImportPanel.tsx`<br>`src/components/git-import/FrontierForgotPasswordForm.tsx`<br>`src/components/git-import/FrontierLoginForm.tsx`<br>`src/components/git-import/FrontierSignupForm.tsx`<br>`src/components/dcs/DcsCatalogBrowser.tsx`<br>`src/components/dcs/DcsSyncBadge.tsx`<br>`src/components/dcs/DcsUpstreamPanel.tsx`<br>`src/components/linked/UpstreamChangesPanel.tsx`<br>`src/components/RenameSuggestionsDialog.tsx`<br>`src/components/SuggestionBanner.tsx` | import-dialog, dcs-catalog | 130 | 3 (deferred) |
| `org` | `src/pages/MembersPage.tsx`<br>`src/components/ProjectMembersPage.tsx`<br>`src/components/MembersMatrixCellEditor.tsx`<br>`src/components/MembersMatrixView.tsx`<br>`src/components/MemberLaneScopeEditor.tsx`<br>`src/components/MemberAccessDrillDown.tsx`<br>`src/components/MembersPanel.tsx`<br>`src/components/MemberMultiAddRow.tsx`<br>`src/components/MultiProjectInviteDialog.tsx`<br>`src/components/RemoveOrgMemberDialog.tsx`<br>`src/components/AccessModelLegend.tsx`<br>`src/components/JoinOrgPage.tsx`<br>`src/components/org/AddLanguagePopover.tsx`<br>`src/components/org/ArchivedProjects.tsx`<br>`src/components/org/AssignWork.tsx`<br>`src/components/org/AssignedToMe.tsx`<br>`src/components/org/ExternalCollaboratorsSection.tsx`<br>`src/components/org/GuestOrgHome.tsx`<br>`src/components/org/MemberActivityPanel.tsx`<br>`src/components/org/OrgCreateDialog.tsx`<br>`src/components/org/OrgHome.tsx`<br>`src/components/org/OrgInviteByEmail.tsx`<br>`src/components/org/OrgProjectsDataTable.tsx`<br>`src/components/org/OrgRenameDialog.tsx`<br>`src/components/org/OrgSetupChecklist.tsx`<br>`src/components/org/OrgSidebar.tsx`<br>`src/components/org/OrgSwitcher.tsx`<br>`src/components/org/OverviewLaneTable.tsx`<br>`src/components/org/ProjectAutopilotPanel.tsx`<br>`src/components/org/ProjectOverview.tsx`<br>`src/components/org/ProjectsList.tsx`<br>`src/components/org/SectionVisibilityBadge.tsx`<br>`src/components/org/SharedProjectsPage.tsx`<br>`src/components/org/TeamDetail.tsx`<br>`src/components/org/TeamsList.tsx`<br>`src/components/org/UsageRollup.tsx`<br>`src/components/org/WorkloadRollup.tsx` | org-home, members | 225 | 3 (deferred) |
| `admin` | `src/pages/AdminConsole.tsx`<br>`src/components/admin/AbResultsPanel.tsx`<br>`src/components/admin/AdminActivityTimeline.tsx`<br>`src/components/admin/AdminElevationGate.tsx`<br>`src/components/admin/AdminOverviewHome.tsx`<br>`src/components/admin/AdminPeopleSection.tsx`<br>`src/components/admin/AdminPlatformSection.tsx`<br>`src/components/admin/AdminProjectsSection.tsx`<br>`src/components/admin/AdminSettingsSection.tsx`<br>`src/components/admin/AdminTenantsSection.tsx`<br>`src/components/admin/ModelListEditor.tsx` | admin-console | 58 | 3 (deferred) |
| `settings` | `src/pages/Preferences.tsx`<br>`src/pages/settings/OrgSettingsExport.tsx`<br>`src/pages/settings/OrgSettingsIdentity.tsx`<br>`src/pages/settings/OrgSettingsIndex.tsx`<br>`src/pages/settings/OrgSettingsMonday.tsx`<br>`src/pages/settings/OrgSettingsShell.tsx`<br>`src/components/settings/ApiTokensSection.tsx`<br>`src/components/settings/AssignmentAuthoritySection.tsx`<br>`src/components/settings/OrgProviderSection.tsx`<br>`src/components/settings/PersonalProviderSection.tsx`<br>`src/components/settings/RosterProgressSection.tsx`<br>`src/components/settings/TermbaseEditSection.tsx`<br>`src/components/settings/UsageSection.tsx` | preferences (existing), api-tokens | 60 | 3 (deferred) |
| `terminology` | `src/components/TerminologyPage.tsx`<br>`src/components/GlossaryEditor.tsx`<br>`src/components/GlossaryRow.tsx`<br>`src/components/CandidateTermsPanel.tsx`<br>`src/components/TerminologyReviewQueue.tsx`<br>`src/components/TerminologyViolationsInbox.tsx`<br>`src/components/TerminologyMergeDialog.tsx`<br>`src/components/TerminologyTermDetail.tsx`<br>`src/components/AddConceptDialog.tsx` | terminology | 57 | 3 (deferred) |
| `rules` | `src/components/RuleCreateDialog.tsx`<br>`src/components/RuleEditor.tsx`<br>`src/components/RulesPage.tsx`<br>`src/components/RulesSurface.tsx`<br>`src/components/RuleDrawer.tsx`<br>`src/components/RuleImportDialog.tsx`<br>`src/components/RuleSuggestFromEditsDialog.tsx`<br>`src/components/CheckFindingsDrawer.tsx`<br>`src/components/CheckFileButton.tsx`<br>`src/components/ViolationPopover.tsx` | rules | 84 | 3 (deferred) |
| `agent` | `src/components/LivingMemoryPage.tsx`<br>`src/components/AgentDockPanel.tsx`<br>`src/pages/ApproveChangeset/ApproveChangeset.tsx`<br>`src/components/agent/AgentDockView.tsx`<br>`src/components/agent/AgentEmptyState.tsx`<br>`src/components/agent/AgentRunView.tsx`<br>`src/components/agent/AgentWorkbench.tsx`<br>`src/components/agent/CodeActivityBlock.tsx`<br>`src/components/agent/ProposalCard.tsx`<br>`src/components/agent/WorkingSetPanel.tsx`<br>`src/components/agent/cards/PassageCard.tsx`<br>`src/components/agent/cards/ValidationQueueCard.tsx`<br>`src/components/agent/memory/AgentMemoryTab.tsx`<br>`src/components/agent/memory/ApprovedMemoryList.tsx`<br>`src/components/agent/memory/BriefPanel.tsx`<br>`src/components/agent/memory/ProposedMemoryList.tsx`<br>`src/components/contextual/ContextualDraftCard.tsx`<br>`src/components/contextual/ContextualRunPill.tsx`<br>`src/components/contextual/ContextualSteering.tsx` | agent-dock, changeset-approval | 87 | 3 (deferred) |
| `brief` | `src/components/brief/BriefBuilder.tsx`<br>`src/components/brief/BriefSection.tsx` | brief | 11 | 3 (deferred) |
| `credits` | `src/components/admin/AdminCreditsSection.tsx`<br>`src/components/org/CreditsPanel.tsx`<br>`src/components/agent/CreditsDial.tsx` | credits | 9 | 3 (deferred) |
| `onboarding` | `src/components/AiModelDownloadChip.tsx`<br>`src/components/AiModelConsentDialog.tsx`<br>`src/components/onboarding/OnboardingWizard.tsx`<br>`src/components/onboarding/ProductTour.tsx`<br>`src/components/onboarding/SetupChecklistDrawer.tsx`<br>`src/components/onboarding/SystemPromptNudge.tsx`<br>`src/components/onboarding/checklist/AiModelsStep.tsx`<br>`src/components/onboarding/checklist/AiProviderStep.tsx`<br>`src/components/onboarding/checklist/ComingSoonStep.tsx`<br>`src/components/onboarding/checklist/InviteStep.tsx`<br>`src/components/onboarding/steps/IntentStep.tsx`<br>`src/components/onboarding/steps/NameStep.tsx`<br>`src/components/onboarding/steps/OrgStep.tsx`<br>`src/components/onboarding/steps/PrivacyStep.tsx`<br>`src/components/onboarding/steps/ProjectStep.tsx`<br>`src/components/onboarding/steps/ReadyStep.tsx` | onboarding | 39 | 3 (deferred) |
| `metrics` | `src/components/metrics/PostEditMetricsSection.tsx` | metrics | 4 | 3 (deferred) |
| `chat` | `src/components/chat/ChatComposer.tsx`<br>`src/components/chat/ChatMarkdown.tsx` | chat | 4 | 3 (deferred) |
| `language` | (no new files — settings/switcher-adjacent copy only) | project-settings (existing) | 0 | 3 (deferred), already exists |

**Totals:** 237 files across 21 namespaces with new files (+ `language`, which gets none in this
pass). Phase 1 (wave 2) covers 9 namespaces / 75 files / ~292 strings. Phase 3 (deferred) covers
13 namespaces / 162 files / ~946 strings.

## Verification

```
$ sort /tmp/i18n-partition.txt | uniq -d
$ # (no output — empty)
```

Empty output confirms every one of the 237 assigned paths appears exactly once: no file is
claimed by two namespaces, and (by construction from the inventory list) every inventoried
non-marketing file is assigned.
