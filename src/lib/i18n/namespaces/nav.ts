import { defineNamespace, plural } from "./types"

export const nav = defineNamespace({
  keys: {
    "nav.projects": "Projects",
    "nav.settings": "Settings",
    "nav.search": "Search",

    // -- EditorModeToggle / audio-lens-label.ts: header Text/Audio(Media) lens
    // switch (AQU-353). Shared by every entry point that toggles this lens so
    // the name can never drift ("Audio" vs the old sidebar "Voice"). --
    "nav.lens.audio": "Audio",
    "nav.lens.media": "Media",

    // -- NavHistoryControls: back/forward arrows + hold-for-history popover --
    "nav.historyControls.groupLabel": "Page history",
    "nav.historyControls.back": "Back",
    "nav.historyControls.forward": "Forward",
    "nav.historyControls.backTo": "Back to {target}",
    "nav.historyControls.forwardTo": "Forward to {target}",
    "nav.historyControls.backHoldHint": "Back · hold for history",
    "nav.historyControls.forwardHoldHint": "Forward · hold for history",
    "nav.historyControls.noBackHistory": "No back history",
    "nav.historyControls.noForwardHistory": "No forward history",
    "nav.historyControls.emptyList": "No history",

    // -- AccountSwitcher: account menu + auth dialogs --
    "nav.account.addTitle": "Add Frontier account",
    "nav.account.loginTitle": "Log in to Frontier",
    "nav.account.signupTitle": "Create a Frontier account",
    "nav.account.newToFrontier": "New to Frontier?",
    "nav.account.menuLabel": "Account menu: {username}",
    "nav.account.preferences": "Preferences",
    "nav.account.addAnotherAccount": "Add another account",
    "nav.account.logOut": "Log out",
    "nav.account.signOutAllAccounts": "Sign out of all accounts",
    "nav.account.unsavedEditsTitle": "Unsaved edits",
    "nav.account.unsavedEditsDescription": plural({
      one: "You have {count} unsaved edit that hasn't synced to the server. Logging out will discard it. Continue?",
      other: "You have {count} unsaved edits that haven't synced to the server. Logging out will discard them. Continue?",
    }),
    "nav.account.logOutAnyway": "Log out anyway",

    // -- HelpMenu --
    "nav.help.menuLabel": "Help & community",
    "nav.help.tour": "Take the tour",
    "nav.help.docs": "Help",
    "nav.help.discord": "Discord server",
    "nav.help.contactSupport": "Contact support",
    "nav.help.report": "Report",

    // -- LeftDock: tab rail + expand affordance --
    "nav.dock.filesTab": "Files",
    "nav.dock.agentTab": "Agent",
    "nav.dock.agentUnread": "{count} unread",
    "nav.dock.expandSidebar": "Expand sidebar",

    // -- SidebarProjectSection: pinned rows + "More" overflow popover --
    "nav.sidebarSection.more": "More",
    "nav.sidebarSection.moreOptions": "More project options",

    // -- ProjectWorkspace: projectNavItems feeding SidebarProjectSection above --
    "nav.sidebarSection.rules": "Rules",
    "nav.sidebarSection.terminology": "Terminology",
    "nav.sidebarSection.memory": "Memory",
    "nav.sidebarSection.share": "Share",
    "nav.sidebarSection.trash": "Recently deleted",

    // -- ProjectWorkspace: sidebar-footer onboarding "Setup" chip (AQU-695) --
    "nav.sidebarSection.setupChipDismissed": "Setup",
    // {ratio} arrives pre-formatted and bidi-isolated ("⁨2/4⁩") by the caller —
    // see editor.completion.failed for the two-count plural() precedent this
    // follows. `other`/`one` read identically in English (the noun-free "n/N"
    // shorthand doesn't inflect) but the key is still plural()-governed on
    // totalCount so a locale whose equivalent phrasing DOES need agreement can
    // supply distinct forms.
    "nav.sidebarSection.setupChipProgress": plural(
      { one: "Setup: {ratio}", other: "Setup: {ratio}" },
      "totalCount",
    ),
    "nav.sidebarSection.setupChipTooltip": "Reopen the setup checklist anytime from here.",

    // -- workspace-actions/registry.ts: the file-scoped action menu (⋯) and its
    // per-action confirmation dialogs, rendered through ConfirmActionDialog. --
    "nav.workspaceActions.import": "Import",
    "nav.workspaceActions.runCompletions.label": "Run AI completions",
    "nav.workspaceActions.runCompletions.title": "Run completions",
    "nav.workspaceActions.runCompletions.description": plural(
      {
        one: "Generate an approved-example draft package for the next {next} untranslated cell",
        other: "Generate an approved-example draft package for the next {next} untranslated cells",
      },
      "next",
    ),
    // Optional inline clause, spliced in (plain concatenation, not a nested
    // placeholder — see dialog.assign.error.bulkSucceededSuffix for the same
    // "resolve a fragment, concatenate it" composition) between the sentence
    // above and descriptionTail below, only when more cells remain after this
    // package. Leading space is intentional (joins directly onto "cells").
    "nav.workspaceActions.moreAfterThis": " ({count} more after this)",
    "nav.workspaceActions.runCompletions.descriptionTail":
      ". Every draft still needs individual human review.",
    "nav.workspaceActions.completeAll.label": "Draft all (review required)",
    "nav.workspaceActions.completeAll.title": "Draft all untranslated cells",
    "nav.workspaceActions.completeAll.description": plural(
      {
        one:
          "Generate drafts for all {untranslated} untranslated cell, split into " +
          "packages of at most {batchSize}. Packaging preserves context but is not a " +
          "quality guarantee; every draft remains unapproved until a human reviews " +
          "it individually.",
        other:
          "Generate drafts for all {untranslated} untranslated cells, split into " +
          "packages of at most {batchSize}. Packaging preserves context but is not a " +
          "quality guarantee; every draft remains unapproved until a human reviews " +
          "it individually.",
      },
      "untranslated",
    ),
    "nav.workspaceActions.completeAll.confirmLabel": "Draft all",
    "nav.workspaceActions.batchValidate.label": "Batch validate…",
    "nav.workspaceActions.batchValidate.title": "Batch validate",
    "nav.workspaceActions.batchValidate.description": plural(
      {
        one:
          "This marks eligible human-authored or human-edited cells as validated " +
          "under your name. Untouched AI drafts are excluded and still need " +
          "individual review. ({unvalidated} cell is currently unvalidated.)",
        other:
          "This marks eligible human-authored or human-edited cells as validated " +
          "under your name. Untouched AI drafts are excluded and still need " +
          "individual review. ({unvalidated} cells are currently unvalidated.)",
      },
      "unvalidated",
    ),
    // Optional trailing clause (AQU-586 per-run cap), concatenated after the
    // description above — same composition as moreAfterThis.
    "nav.workspaceActions.batchValidate.capNote": plural(
      {
        one:
          " At most {cap} eligible cell are validated per run (project batch " +
          "size); run again to continue.",
        other:
          " At most {cap} eligible cells are validated per run (project batch " +
          "size); run again to continue.",
      },
      "cap",
    ),
    "nav.workspaceActions.export": "Export",
    "nav.workspaceActions.importIntoFile": "Import target translations into this file",
    "nav.workspaceActions.transcribeAll.label": "Transcribe all audio",
    "nav.workspaceActions.transcribeAll.title": "Transcribe all audio in this file",
    "nav.workspaceActions.transcribeAll.description": plural(
      {
        one: "Run Whisper on {n} cell that already has a recording but no karaoke timings yet.",
        other: "Run Whisper on {n} cells that already have a recording but no karaoke timings yet.",
      },
      "n",
    ),
    "nav.workspaceActions.transcribeAll.confirmLabel": "Transcribe all",
    "nav.workspaceActions.synthAll.label": "Generate AI voice for empty cells",
    "nav.workspaceActions.synthAll.title": "Generate AI voice",
    "nav.workspaceActions.synthAll.description": plural(
      {
        one:
          "Generate AI voice audio for {n} cell that has translated text but no " +
          "recording yet. Existing recordings are not touched.",
        other:
          "Generate AI voice audio for {n} cells that have translated text but no " +
          "recording yet. Existing recordings are not touched.",
      },
      "n",
    ),
    "nav.workspaceActions.synthAll.confirmLabel": "Generate audio",
    // AQU-365: the checkbox on the workspace-action confirmation dialog above
    // (distinct from ConfirmActionDialog's generic default, since this one
    // names WHY the checkbox matters — attribution). e2e asserts this exact
    // English text (ai-completion-dialog.smoke.spec.ts).
    "nav.workspaceActions.confirmAttribution":
      "I understand this change will be attributed to my account.",

    // -- ProjectWorkspace: soft-delete confirmation (FRO-272). e2e asserts this
    // exact English text (delete-file-confirm-dialog / file-delete smoke specs). --
    "nav.workspaceActions.deleteFile.title": "Move file to Recently deleted",
    "nav.workspaceActions.deleteFile.description":
      "Move \"{name}\" to Recently deleted? Cells and audio are kept for 30 days. " +
      "You can restore the file or permanently delete it from \"Recently deleted\" " +
      "in the sidebar's More menu.",
    "nav.workspaceActions.deleteFile.confirmLabel": "Move to Recently deleted",

    // -- ProjectWorkspace: fileMenuItems (chapter-row "File options" ⋯ menu) --
    "nav.fileMenu.diarizing": "Diarizing…",
    "nav.fileMenu.applying": "Applying…",
    "nav.fileMenu.diarizeFailed": "Diarize failed",
    "nav.fileMenu.diarize": "Diarize",
    "nav.fileMenu.nextUnfinished": "Next unfinished",
    "nav.fileMenu.extractingVoice": "Extracting voice…",
    "nav.fileMenu.useFileSpeakerAsVoice": "Use file's speaker as a voice",
    "nav.fileMenu.showFileNameSuggestions": plural({
      one: "Show {count} file name suggestion",
      other: "Show {count} file name suggestions",
    }),

    // -- ProjectWorkspace: rename-suggestions undo toast --
    "nav.renameSuggestions.appliedToast": "Applied renames.",
    "nav.renameSuggestions.undo": "Undo",

    // -- VersionBadge / VersionTag: build-info copy control --
    "nav.version.copiedAriaLabel": "Build info copied",
    "nav.version.copyAriaLabel": "Copy build info",
    "nav.version.copiedLabel": "Copied",
    "nav.version.copiedTooltip": "Copied to clipboard",
    "nav.version.copyTooltip": "Click to copy\n{buildInfo}",

    // -- TabStrip: open-file tabs above the editor --
    "nav.tabStrip.openFiles": "Open files",
    "nav.tabStrip.closeTab": "Close {label}",
    "nav.tabStrip.untitledFile": "Untitled file",

    // -- sidebar/FileSectionGrid: per-section rows under an expanded file --
    "nav.fileSectionGrid.progressUnavailable": "Progress unavailable.",
    "nav.fileSectionGrid.sectionProgressTooltip":
      "{section}: {completed}% translated, {validated}% validated",

    // -- BetaBadge --
    "nav.beta.badge": "Beta",
    "nav.beta.title": "Heads up — we're in beta",
    "nav.beta.description":
      "Things might move around, break, or change without warning. That's the deal for now.",
    "nav.beta.pointEvolving": "The UI is actively evolving",
    "nav.beta.pointFeatures": "Features may appear or disappear",
    "nav.beta.pointFeedback": "Your feedback shapes what we build next",
    "nav.beta.joinDiscord": "Join our Discord",

    // -- ReportProblemButton/ReportProblemDialog --
    "nav.report.title": "Report a problem",
    "nav.report.descriptionEnabled":
      "Describe what went wrong. Your report will be sent along with session context.",
    "nav.report.descriptionDisabled":
      "Analytics are off — your report won't be sent automatically. You can copy it to share manually.",
    "nav.report.thanks": "Thanks — report received.",
    "nav.report.replayLinked": "Session replay linked to the report.",
    "nav.report.descriptionFieldLabel": "Description",
    "nav.report.placeholder": "What went wrong?",
    "nav.report.descriptionRequired": "Description is required",
    "nav.report.capturedContext": "Captured context:",
    "nav.report.analyticsOffNotice":
      "Usage data collection is off. Enable it in Preferences if you'd like reports to be sent automatically — or use \"Copy report\" to share it manually.",
    "nav.report.sendReport": "Send report",
    "nav.report.copyReport": "Copy report",
    "nav.report.copied": "Copied!",

    // -- FileRow --
    "nav.fileRow.collapseSections": "Collapse sections",
    "nav.fileRow.expandSections": "Expand sections",
    "nav.fileRow.collapse": "Collapse",
    "nav.fileRow.expand": "Expand",
    "nav.fileRow.timelineOrderedTooltip": "Timeline-ordered (timecodes are the spine)",
    "nav.fileRow.timelineOrderedFile": "Timeline-ordered file",
    "nav.fileRow.importedAsTooltip": "{name} (imported as {originalName})",
    "nav.fileRow.progressAriaLabel": "{translated}% translated, {validated}% validated",
    "nav.fileRow.fileActions": "File actions",
    "nav.fileRow.suggestionTooltip":
      "A cleaner name was detected for this file. Click to apply, or use the Apply button at the top of the sidebar.",
    "nav.fileRow.applyRenameSuggestion": "Apply rename suggestion",

    // -- ExpandableFileList --
    "nav.fileList.filterFiles": "Filter files",
    "nav.fileList.filterPlaceholder": "Filter files...",
    "nav.fileList.clearFilter": "Clear filter",
    "nav.fileList.noFilesMatch": "No files match \"{filter}\".",
    "nav.fileList.noFilesImported": "No files imported yet.",
    "nav.fileList.expandGroup": "Expand {group}",
    "nav.fileList.collapseGroup": "Collapse {group}",
    "nav.fileList.renameGroup": "Rename {group}",

    // -- OutboxInspectorPopover --
    "nav.outbox.popoverAriaLabel": "Pending changes",
    "nav.outbox.title": "Outbox",
    "nav.outbox.allSynced": "All synced",
    "nav.outbox.pendingCount": "{count} pending",
    "nav.outbox.failedCount": "{count} failed",
    "nav.outbox.pendingAndFailedCount": "{pending} pending · {failed} failed",
    "nav.outbox.attempts": plural({
      one: "{count} try",
      other: "{count} tries",
    }),
    // Each summary item is ONE key carrying both the count and its noun, so the
    // translator places the numeral. `<span>{n}</span> {noun}` in JSX froze the
    // numeral before the noun, which several target languages cannot follow;
    // `{count}` is substituted with the styled span at the call site via
    // <RichMessage>, so it appears exactly once and keeps its tabular-nums
    // styling. All four are count-governed: "3 validation" and "3 other" were
    // ungrammatical English, and a bare noun cannot inflect after an Arabic
    // numeral at all.
    "nav.outbox.summaryEdits": plural({
      one: "{count} edit",
      other: "{count} edits",
    }),
    "nav.outbox.summaryValidations": plural({
      one: "{count} validation",
      other: "{count} validations",
    }),
    "nav.outbox.summaryComments": plural({
      one: "{count} comment",
      other: "{count} comments",
    }),
    "nav.outbox.summaryOther": plural({
      one: "{count} other change",
      other: "{count} other changes",
    }),
    "nav.outbox.retryNow": "Retry now",
    "nav.outbox.sessionExpiredAlert":
      "Your session expired. Edits are saved locally — sign in again to retry.",
    "nav.outbox.noPermissionMessage":
      "Some changes weren’t allowed — you may not have permission, or they belong to a different project. Re-signing in won’t help. They stay saved locally until you discard them.",
    "nav.outbox.stuckMessage":
      "Some changes couldn’t be synced after several tries. They stay saved locally until you discard them.",
    "nav.outbox.discardStuckChangesButton": plural({
      one: "Discard {count} stuck change",
      other: "Discard {count} stuck changes",
    }),
    "nav.outbox.allCaughtUpTitle": "You’re all caught up",
    "nav.outbox.allCaughtUpDescription": "Every local change has been synced.",
    "nav.outbox.overflowMore": "+{count} more queued…",
    "nav.outbox.footerPending": "Edits stay saved locally until they sync.",
    "nav.outbox.footerSynced": "Local changes sync automatically.",
    "nav.outbox.statusPending": "Pending",
    "nav.outbox.statusRetrying": "Retrying",
    "nav.outbox.statusNeedsSignin": "Sign in to retry",
    "nav.outbox.statusNoPermission": "Not allowed",
    "nav.outbox.statusStuck": "Stuck",
    "nav.outbox.eventEdit": "Edit",
    "nav.outbox.eventNewCell": "New cell",
    "nav.outbox.eventDeleteCell": "Delete cell",
    "nav.outbox.eventReorderCell": "Reorder cell",
    "nav.outbox.eventSourceEdit": "Source edit",
    "nav.outbox.eventNewSourceCell": "New source cell",
    "nav.outbox.eventValidate": "Validate",
    "nav.outbox.eventUnvalidate": "Unvalidate",
    "nav.outbox.eventNewComment": "New comment",
    "nav.outbox.eventEditComment": "Edit comment",
    "nav.outbox.eventDeleteComment": "Delete comment",
    "nav.outbox.eventResolveComment": "Resolve comment",
    "nav.outbox.eventNewFile": "New file",
    "nav.outbox.eventAttachAudio": "Attach audio",
    "nav.outbox.eventSelectAudio": "Select audio",
    "nav.outbox.eventRemoveAudio": "Remove audio",
    "nav.outbox.previewEditRef": "→ edit {id}",
    "nav.outbox.previewAudioSlot": "{slot} slot",
    "nav.outbox.previewAudio": "audio",
    "nav.outbox.timeJustNow": "just now",
    "nav.outbox.timeSecondsAgo": "{sec}s ago",
    "nav.outbox.timeMinutesAgo": "{min}m ago",
    "nav.outbox.timeHoursAgo": "{hr}h ago",
    "nav.outbox.timeDaysAgo": "{d}d ago",
    "nav.outbox.cellDetailLabel": "Cell",
    "nav.outbox.eventDetailLabel": "Event",
    "nav.outbox.errorDetailLabel": "Error",
    "nav.outbox.discardChangeButton": "Discard this change",
  },
  context: {
    _context: {
      description:
        "Top-level workspace navigation — links and controls in the left sidebar and " +
        "app header that move the user between major areas. Rendered in a narrow " +
        "fixed-width column, so long translations wrap or clip.",
      screenshot: "workspace-nav",
      maxLength: 24,
    },
    keys: {
      "nav.projects": {
        description:
          "Sidebar link to the list of translation projects the user belongs to. Plural " +
          "noun naming a destination, not an action.",
      },
      "nav.settings": {
        description:
          "Sidebar link to the settings area. Plural noun naming a destination.",
      },
      "nav.search": {
        description:
          "Control that opens search across the project's cells. Noun or verb depending " +
          "on what reads naturally as a nav label in the target language. Reused as the " +
          "Search tab label in the left dock's tab rail (icon-only when collapsed, so a " +
          "long translation there only affects the tooltip/aria-label, not layout).",
      },

      // -- EditorModeToggle / audio-lens-label.ts (AQU-353) --
      "nav.lens.audio": {
        description:
          "Second tab of the header Text/Audio segmented lens switch, for a cell-" +
          "ordered file: reveals the cast library, transport and per-line speaker " +
          "chips over the same cells the Text tab edits. Short — sits beside a Pencil-" +
          "icon 'Text' tab in a two-tab segmented control.",
      },
      "nav.lens.media": {
        description:
          "Same second lens tab as nav.lens.audio, relabelled for a time-ordered " +
          "(timeline) file where the lens shows separate media segments rather than " +
          "audio attached to text cells.",
      },

      // -- NavHistoryControls --
      "nav.historyControls.groupLabel": {
        description:
          "Accessible group label (not visible text) wrapping the browser-style back/" +
          "forward arrow buttons in the top-left app chrome.",
      },
      "nav.historyControls.back": {
        description:
          "Accessible name for the back arrow when there's no known destination title " +
          "(disabled, or history not yet loaded). Deliberately phrased as 'Go back' " +
          "rather than the bare word 'Back' so it doesn't collide with common.back's " +
          "unrelated wizard-navigation meaning under the no-duplicate-strings guard.",
        maxLength: 14,
      },
      "nav.historyControls.forward": {
        description:
          "Accessible name for the forward arrow when there's no known destination " +
          "title. Mirrors nav.historyControls.back for the forward direction.",
        maxLength: 14,
      },
      "nav.historyControls.backTo": {
        description:
          "Accessible name for the back arrow when a destination is known: names the " +
          "action and the page title it would jump to. {target} is the page's own title " +
          "(often user content or another already-localized string) — do not translate " +
          "its value, only the surrounding phrase.",
        placeholders: { target: "Title of the page one step back in history." },
      },
      "nav.historyControls.forwardTo": {
        description:
          "Accessible name for the forward arrow when a destination is known. Mirrors " +
          "nav.historyControls.backTo for the forward direction.",
        placeholders: { target: "Title of the page one step forward in history." },
      },
      "nav.historyControls.backHoldHint": {
        description:
          "Tooltip shown on hover over the back arrow, telling the user that pressing " +
          "and holding it opens a history list.",
      },
      "nav.historyControls.forwardHoldHint": {
        description: "Tooltip shown on hover over the forward arrow. Mirrors backHoldHint.",
      },
      "nav.historyControls.noBackHistory": {
        description: "Tooltip shown when the back arrow is disabled — there is nowhere to go back to.",
      },
      "nav.historyControls.noForwardHistory": {
        description: "Tooltip shown when the forward arrow is disabled. Mirrors noBackHistory.",
      },
      "nav.historyControls.emptyList": {
        description:
          "Placeholder text inside the history popover when press-and-hold opens it but " +
          "there are no entries in that direction (edge case; the button is normally " +
          "disabled first).",
      },

      // -- AccountSwitcher --
      "nav.account.addTitle": {
        description:
          "Dialog title when opening the login form to add a second account while " +
          "already signed in to one.",
        screenshot: "confirm-dialog",
      },
      "nav.account.loginTitle": {
        description: "Dialog title for the sign-in form shown to a signed-out user.",
        screenshot: "confirm-dialog",
      },
      "nav.account.signupTitle": {
        description: "Dialog title for the account-creation form.",
        screenshot: "confirm-dialog",
      },
      "nav.account.newToFrontier": {
        description:
          "Prompt text preceding the 'Create an account' link at the bottom of the " +
          "login form. 'Frontier' is the identity provider's product name — keep it " +
          "untranslated.",
      },
      "nav.account.menuLabel": {
        description:
          "Accessible name (not visible text) for the account-switcher trigger button, " +
          "naming whose account menu it opens.",
        placeholders: { username: "The signed-in user's display name." },
      },
      "nav.account.preferences": {
        description: "Menu item in the account dropdown linking to the Preferences page.",
      },
      "nav.account.addAnotherAccount": {
        description:
          "Menu item that opens the login dialog to sign in to a second account " +
          "alongside the current one.",
      },
      "nav.account.logOut": {
        description: "Menu item that signs the current account out.",
      },
      "nav.account.signOutAllAccounts": {
        description:
          "Destructive menu item, only shown when 2+ accounts are signed in, that signs " +
          "all of them out at once. Sits below the single-account 'Log out' item.",
      },
      "nav.account.unsavedEditsTitle": {
        description:
          "Title of the confirmation dialog shown when logging out would discard " +
          "edits that haven't synced to the server yet.",
        screenshot: "confirm-dialog",
      },
      "nav.account.unsavedEditsDescription": {
        description:
          "Body text of the unsaved-edits confirmation dialog, asking the user to " +
          "confirm they want to discard pending local changes by logging out. The " +
          "whole sentence is translated per plural form, so the noun and the pronoun " +
          "referring back to it ('discard it' / 'discard them') can agree with the " +
          "number the way the target language requires.",
        screenshot: "confirm-dialog",
        placeholders: { count: "Number of unsynced local edits." },
      },
      "nav.account.logOutAnyway": {
        description:
          "Destructive confirm button in the unsaved-edits dialog that proceeds with " +
          "logout despite the warning.",
        screenshot: "confirm-dialog",
      },

      // -- HelpMenu --
      "nav.help.menuLabel": {
        description:
          "Trigger button for the help/community dropdown — both its visible label " +
          "(when not collapsed to an icon) and its accessible name. Sits in the left " +
          "rail alongside the account switcher.",
        maxLength: 20,
      },
      "nav.help.tour": {
        description: "Dropdown item that launches the guided product tour.",
      },
      "nav.help.docs": {
        description: "Dropdown item linking out to the external help/documentation site.",
      },
      "nav.help.discord": {
        description: "Dropdown item linking out to the community Discord server.",
      },
      "nav.help.contactSupport": {
        description: "Dropdown item that opens a mailto: link to the support address.",
      },
      "nav.help.report": {
        description:
          "Dropdown item that opens the 'Report a problem' dialog (nav.report.*).",
      },

      // -- LeftDock --
      "nav.dock.filesTab": {
        description:
          "Tab label for the file browser panel in the left dock's icon tab rail. Icon-" +
          "only when the rail is collapsed to 40px, so the label is used as a tooltip/" +
          "aria-label there and as a visible label only in the top-rail layout.",
        maxLength: 12,
      },
      "nav.dock.agentTab": {
        description: "Tab label for the AI translation-agent panel in the left dock's tab rail.",
        maxLength: 12,
      },
      "nav.dock.agentUnread": {
        description:
          "Accessible label for the small unread-count badge on the Agent tab (visible " +
          "text is just the number, capped at '9+').",
        placeholders: { count: "Number of unread agent messages." },
      },
      "nav.dock.expandSidebar": {
        description:
          "Tooltip and accessible name for the button on the collapsed 40px icon rail " +
          "that expands the dock back open to the Files tab.",
      },

      // -- SidebarProjectSection --
      "nav.sidebarSection.more": {
        description:
          "Visible label on the row that tucks away overflow project-nav items " +
          "(Rules, Comments, Terminology, etc. beyond the pinned set) behind a popover.",
      },
      "nav.sidebarSection.moreOptions": {
        description:
          "Accessible name for the 'More' row above. Deliberately distinct from the " +
          "visible 'More' text because another 'More' button already exists elsewhere " +
          "in the workspace header — screen-reader users need to tell them apart.",
      },
      "nav.sidebarSection.rules": {
        description:
          "Project nav row opening the project's translation rules surface. Noun " +
          "naming a destination, not an action.",
      },
      "nav.sidebarSection.terminology": {
        description:
          "Project nav row opening the project's termbase/glossary surface. Noun " +
          "naming a destination.",
      },
      "nav.sidebarSection.memory": {
        description:
          "Project nav row opening the agent's living-memory surface for this " +
          "project. Noun naming a destination.",
      },
      "nav.sidebarSection.share": {
        description:
          "Project nav row that opens the project-sharing dialog. Imperative verb.",
      },
      "nav.sidebarSection.trash": {
        description:
          "Project nav row that opens the soft-deleted-files panel (30-day " +
          "retention). Must match the heading text of that panel exactly, so keep " +
          "'Recently deleted' rather than a shorter synonym like 'Trash'.",
      },
      "nav.sidebarSection.setupChipDismissed": {
        description:
          "Sidebar-footer chip opening the onboarding setup checklist, once the " +
          "user has dismissed the checklist's progress count (de-emphasised, no " +
          "ratio shown). Bare noun.",
      },
      "nav.sidebarSection.setupChipProgress": {
        description:
          "Same sidebar-footer chip as nav.sidebarSection.setupChipDismissed, " +
          "before dismissal: shows how many onboarding steps are complete. The " +
          "Do not reword the ENGLISH here: e2e locates the chip by the 'Setup:' prefix. Translate normally — e2e runs in English, so translations cannot affect it.",
        placeholders: {
          ratio: "Already-formatted 'done/total' count (e.g. '2/4'), pre-wrapped in " +
            "Unicode bidi isolate characters by the caller — reproduce it verbatim, " +
            "do not add surrounding punctuation.",
        },
      },
      "nav.sidebarSection.setupChipTooltip": {
        description:
          "Tooltip shown on hover/focus of the sidebar-footer setup chip above.",
        maxLength: 64,
      },

      // -- workspace-actions/registry.ts --
      "nav.workspaceActions.import": {
        description:
          "Primary header action that opens the source-file import flow. Imperative " +
          "verb.",
      },
      "nav.workspaceActions.runCompletions.label": {
        description:
          "File-scoped action-menu item that runs a package of AI translation drafts " +
          "for the next several untranslated cells. Also reused verbatim as the " +
          "confirmation dialog's confirm button.",
        maxLength: 32,
      },
      "nav.workspaceActions.runCompletions.title": {
        description: "Heading of the confirmation dialog for the action above.",
        maxLength: 40,
      },
      "nav.workspaceActions.runCompletions.description": {
        description:
          "Body of the confirmation dialog above, stating how many cells the next " +
          "AI-draft package covers. `nav.workspaceActions.moreAfterThis` (if any " +
          "cells remain after this package) and `nav.workspaceActions." +
          "runCompletions.descriptionTail` are concatenated directly after this " +
          "string with no added space — end this string mid-clause, right after " +
          "the cell count, with no trailing punctuation.",
        placeholders: {
          next: "How many untranslated cells this package will draft (already clamped " +
            "to the project's batch size).",
        },
        maxLength: 400,
      },
      "nav.workspaceActions.moreAfterThis": {
        description:
          "Optional clause spliced into nav.workspaceActions.runCompletions." +
          "description (see that key's note on the concatenation order) when more " +
          "cells remain after the package being confirmed. Leading space is " +
          "intentional; do not add trailing punctuation.",
        placeholders: {
          count: "How many further untranslated cells remain after this package.",
        },
        maxLength: 60,
      },
      "nav.workspaceActions.runCompletions.descriptionTail": {
        description:
          "Fixed closing sentence of nav.workspaceActions.runCompletions." +
          "description, concatenated after it (and after nav.workspaceActions." +
          "moreAfterThis when present). Starts with its own period.",
        maxLength: 80,
      },
      "nav.workspaceActions.completeAll.label": {
        description:
          "File-scoped action-menu item that drafts AI translations for every " +
          "remaining untranslated cell in the file, packaged into batches.",
        maxLength: 40,
      },
      "nav.workspaceActions.completeAll.title": {
        description: "Heading of the confirmation dialog for the action above.",
        maxLength: 40,
      },
      "nav.workspaceActions.completeAll.description": {
        description: "Body of the confirmation dialog above.",
        placeholders: {
          untranslated: "Total count of untranslated cells the run will cover.",
          batchSize: "Package size each batch is split into (a plain number, not " +
            "itself grammatically pluralized in English).",
        },
        maxLength: 400,
      },
      "nav.workspaceActions.completeAll.confirmLabel": {
        description: "Confirm button of the dialog above.",
        maxLength: 24,
      },
      "nav.workspaceActions.batchValidate.label": {
        description:
          "File-scoped action-menu item that marks eligible human-authored/edited " +
          "cells as validated in bulk. Trailing ellipsis marks it as opening a " +
          "confirmation, per this catalog's convention.",
        maxLength: 24,
      },
      "nav.workspaceActions.batchValidate.title": {
        description: "Heading of the confirmation dialog for the action above.",
        maxLength: 24,
      },
      "nav.workspaceActions.batchValidate.description": {
        description:
          "Body of the confirmation dialog above. nav.workspaceActions." +
          "batchValidate.capNote (if the project caps per-run batch size) is " +
          "concatenated directly after this string with no added space — end this " +
          "string with its own closing parenthesis and no trailing space.",
        placeholders: {
          unvalidated: "How many cells in the file are not yet validated.",
        },
        maxLength: 500,
      },
      "nav.workspaceActions.batchValidate.capNote": {
        description:
          "Optional clause appended after nav.workspaceActions.batchValidate." +
          "description (see that key's note) when the project caps how many " +
          "cells one batch-validate run processes. Leading space is intentional.",
        placeholders: {
          cap: "The project's configured per-run validation cap.",
        },
        maxLength: 120,
      },
      "nav.workspaceActions.export": {
        description:
          "Primary file-scoped action that opens the export dialog. Imperative verb.",
      },
      "nav.workspaceActions.importIntoFile": {
        description:
          "AQU-503: secondary action-menu item, distinct from " +
          "nav.workspaceActions.import — this one is file-scoped and populates the " +
          "open file's TARGET column from an already-translated document. Must keep " +
          "a word equivalent to 'target' so it isn't confused with the primary " +
          "source import.",
        maxLength: 60,
      },
      "nav.workspaceActions.transcribeAll.label": {
        description:
          "Secondary action-menu item (Audio lens) that runs Whisper transcription " +
          "on every recorded-but-untimed cell in the file.",
        maxLength: 32,
      },
      "nav.workspaceActions.transcribeAll.title": {
        description: "Heading of the confirmation dialog for the action above.",
        maxLength: 40,
      },
      "nav.workspaceActions.transcribeAll.description": {
        description: "Body of the confirmation dialog above.",
        placeholders: {
          n: "How many cells have a recording but no karaoke timings yet.",
        },
        maxLength: 200,
      },
      "nav.workspaceActions.transcribeAll.confirmLabel": {
        description: "Confirm button of the dialog above.",
        maxLength: 24,
      },
      "nav.workspaceActions.synthAll.label": {
        description:
          "Secondary action-menu item (Audio lens) that generates AI voice for " +
          "every translated-but-unrecorded cell in the file.",
        maxLength: 40,
      },
      "nav.workspaceActions.synthAll.title": {
        description: "Heading of the confirmation dialog for the action above.",
        maxLength: 32,
      },
      "nav.workspaceActions.synthAll.description": {
        description: "Body of the confirmation dialog above.",
        placeholders: {
          n: "How many cells have translated text but no recording yet.",
        },
        maxLength: 200,
      },
      "nav.workspaceActions.synthAll.confirmLabel": {
        description: "Confirm button of the dialog above.",
        maxLength: 24,
      },
      "nav.workspaceActions.confirmAttribution": {
        description:
          "Checkbox label on the workspace-action confirmation dialog gating its " +
          "confirm button. Do not reword the ENGLISH — an e2e spec " +
          "(ai-completion-dialog.smoke.spec.ts) asserts it verbatim.",
        maxLength: 120,
      },

      // -- ProjectWorkspace: soft-delete confirmation (FRO-272) --
      "nav.workspaceActions.deleteFile.title": {
        description:
          "Heading of the file soft-delete confirmation dialog. Must keep this " +
          "the ENGLISH unchanged — e2e specs (delete-file-confirm-dialog, file-" +
          "delete) assert it verbatim.",
        maxLength: 40,
      },
      "nav.workspaceActions.deleteFile.description": {
        description:
          "Body of the file soft-delete confirmation dialog. Must keep the " +
          "'Move \"{name}\" to Recently deleted?' opening in ENGLISH exactly — e2e specs match " +
          "it by regex.",
        placeholders: {
          name: "The file's display name, already quoted by the template — do not " +
            "add another layer of quoting around {name} in translation.",
        },
        maxLength: 400,
      },
      "nav.workspaceActions.deleteFile.confirmLabel": {
        description:
          "Confirm button of the dialog above. Must keep this exact English " +
          "ENGLISH wording — e2e specs match the button by exact accessible name. Translate normally; e2e runs in English.",
        maxLength: 32,
      },

      // -- ProjectWorkspace: fileMenuItems (chapter-row 'File options' ⋯ menu) --
      "nav.fileMenu.diarizing": {
        description:
          "Transient state of the 'Diarize' action-menu item while speaker " +
          "diarization is running on the file's audio.",
        maxLength: 24,
      },
      "nav.fileMenu.applying": {
        description:
          "Transient state of the 'Diarize' action-menu item while its results are " +
          "being written back to cells, right after nav.fileMenu.diarizing.",
        maxLength: 24,
      },
      "nav.fileMenu.diarizeFailed": {
        description:
          "State of the 'Diarize' action-menu item after a diarization run errored.",
        maxLength: 24,
      },
      "nav.fileMenu.diarize": {
        description:
          "Action-menu item (Audio lens) that runs speaker diarization on the " +
          "file's audio. Default/idle state of nav.fileMenu.diarizing.",
        maxLength: 24,
      },
      "nav.fileMenu.nextUnfinished": {
        description:
          "Action-menu item that jumps the editor to the next untranslated cell. " +
          "Also the accessible name an e2e spec locates it by.",
        maxLength: 24,
      },
      "nav.fileMenu.extractingVoice": {
        description:
          "Transient state of nav.fileMenu.useFileSpeakerAsVoice while the file's " +
          "diarized speaker audio is being adopted as a reusable TTS voice.",
        maxLength: 32,
      },
      "nav.fileMenu.useFileSpeakerAsVoice": {
        description:
          "Action-menu item (Audio lens, after diarization) that adopts the file's " +
          "detected speaker as a reusable cast voice.",
        maxLength: 40,
      },
      "nav.fileMenu.showFileNameSuggestions": {
        description:
          "Action-menu item that re-surfaces previously-dismissed file-rename " +
          "suggestions (detected book/chapter names).",
        placeholders: {
          count: "How many rename suggestions are available to re-show.",
        },
        maxLength: 60,
      },

      // -- ProjectWorkspace: rename-suggestions undo toast --
      "nav.renameSuggestions.appliedToast": {
        description:
          "Toast confirming a batch of file-rename suggestions was applied. Full " +
          "sentence with a period; paired with the nav.renameSuggestions.undo " +
          "action button. e2e matches this exact text.",
        maxLength: 40,
      },
      "nav.renameSuggestions.undo": {
        description:
          "Action button on the toast above that reverts the applied renames. " +
          "e2e matches this exact text as a button's accessible name.",
        maxLength: 16,
      },

      // -- VersionBadge / VersionTag --
      "nav.version.copiedAriaLabel": {
        description:
          "Accessible name for the build-info button immediately after a successful " +
          "copy, replacing the normal 'Copy build info' name.",
      },
      "nav.version.copyAriaLabel": {
        description:
          "Accessible name for the build-info button (version/branch/commit) in its " +
          "normal, not-yet-clicked state.",
      },
      "nav.version.copiedLabel": {
        description:
          "Visible text on the build-info button for ~1.5s after a successful click, " +
          "replacing the version string.",
      },
      "nav.version.copiedTooltip": {
        description: "Tooltip shown right after a successful copy of the build info.",
      },
      "nav.version.copyTooltip": {
        description:
          "Tooltip shown before the user clicks, inviting them to copy the build info. " +
          "{buildInfo} is untranslated technical text (version number, git branch, " +
          "commit SHA) rendered on the line(s) after the invitation.",
        placeholders: { buildInfo: "Untranslated version/branch/SHA build string." },
      },

      // -- TabStrip --
      "nav.tabStrip.openFiles": {
        description:
          "Accessible label (role=tablist) for the row of open-file tabs above the " +
          "editor, read once by a screen reader when it enters the tab list.",
        screenshot: "cell-editor",
      },
      "nav.tabStrip.closeTab": {
        description:
          "Accessible name for the small × button on an open-file tab. {label} is the " +
          "tab's own display text (a file, section, or the parallel-passages surface " +
          "tab) — not translated, just composed in.",
        screenshot: "cell-editor",
        placeholders: { label: "The tab's own (already-localized or user-authored) label." },
      },
      "nav.tabStrip.untitledFile": {
        description:
          "Fallback tab label used when a file has no usable name (blank, matches its " +
          "own id, or looks like a raw UUID).",
        screenshot: "cell-editor",
      },

      // -- sidebar/FileSectionGrid --
      "nav.fileSectionGrid.progressUnavailable": {
        description:
          "Inline error text shown under an expanded file when its per-section " +
          "progress failed to load, next to a Retry button (common.retry).",
      },
      "nav.fileSectionGrid.sectionProgressTooltip": {
        description:
          "Tooltip on a section row, spelling out its translated/validated percentages " +
          "as a full sentence for anyone who can't read the two small progress bars.",
        placeholders: {
          section: "The section's own label (e.g. a chapter or scene name).",
          completed: "Percent of cells translated in this section, 0-100.",
          validated: "Percent of cells validated in this section, 0-100.",
        },
      },

      // -- BetaBadge --
      "nav.beta.badge": {
        description:
          "Small pill/chip in the app chrome, only shown when the beta flag is on. " +
          "Clicking it opens the dialog described by the other nav.beta.* keys.",
        maxLength: 10,
      },
      "nav.beta.title": {
        description: "Title of the dialog opened by clicking the Beta badge.",
        screenshot: "confirm-dialog",
      },
      "nav.beta.description": {
        description: "Body copy under the beta dialog title, setting expectations.",
        screenshot: "confirm-dialog",
      },
      "nav.beta.pointEvolving": {
        description: "First bullet in the beta dialog's short expectations list.",
        screenshot: "confirm-dialog",
      },
      "nav.beta.pointFeatures": {
        description: "Second bullet in the beta dialog's expectations list.",
        screenshot: "confirm-dialog",
      },
      "nav.beta.pointFeedback": {
        description: "Third bullet in the beta dialog's expectations list.",
        screenshot: "confirm-dialog",
      },
      "nav.beta.joinDiscord": {
        description: "Outbound link button at the foot of the beta dialog.",
        screenshot: "confirm-dialog",
      },

      // -- ReportProblemButton/ReportProblemDialog --
      "nav.report.title": { description: "Title of the 'Report a problem' modal.", screenshot: "confirm-dialog" },
      "nav.report.descriptionEnabled": {
        description:
          "Dialog subtitle shown when analytics/session-replay consent is ON, telling " +
          "the user their report is sent automatically with context.",
        screenshot: "confirm-dialog",
      },
      "nav.report.descriptionDisabled": {
        description:
          "Dialog subtitle shown when analytics consent is OFF — honest disclosure " +
          "that nothing is sent automatically, only copyable.",
        screenshot: "confirm-dialog",
      },
      "nav.report.thanks": {
        description: "Confirmation text shown after a report is successfully submitted.",
        screenshot: "confirm-dialog",
      },
      "nav.report.replayLinked": {
        description:
          "Small note shown alongside the thank-you message when a session-replay " +
          "recording was attached to the submitted report.",
        screenshot: "confirm-dialog",
      },
      "nav.report.descriptionFieldLabel": {
        description:
          "Screen-reader-only label for the free-text textarea (visually hidden; the " +
          "placeholder text carries the visible prompt).",
      },
      "nav.report.placeholder": {
        description: "Placeholder text inside the empty report textarea.",
        screenshot: "confirm-dialog",
      },
      "nav.report.descriptionRequired": {
        description: "Validation error shown under the textarea when submitted empty.",
        screenshot: "confirm-dialog",
      },
      "nav.report.capturedContext": {
        description:
          "Label prefix before the auto-captured route/project/file identifiers shown " +
          "under the textarea, e.g. 'Captured context: /project/p1 · project p1'.",
        screenshot: "confirm-dialog",
      },
      "nav.report.analyticsOffNotice": {
        description:
          "Amber notice shown only when analytics consent is off, pointing the user at " +
          "Preferences and at the 'Copy report' fallback. Contains a literal quoted " +
          "phrase matching nav.report.copyReport's wording — keep them consistent if " +
          "either is retranslated.",
        screenshot: "confirm-dialog",
      },
      "nav.report.sendReport": {
        description: "Primary submit button, shown only when analytics consent is on.",
        screenshot: "confirm-dialog",
      },
      "nav.report.copyReport": {
        description:
          "Secondary button shown instead of Send when analytics consent is off — " +
          "copies the report text to the clipboard for manual sharing.",
        screenshot: "confirm-dialog",
      },
      "nav.report.copied": {
        description:
          "Replaces nav.report.copyReport's label for a moment right after a " +
          "successful copy.",
        screenshot: "confirm-dialog",
      },

      // -- FileRow --
      "nav.fileRow.collapseSections": {
        description:
          "Tooltip on the chevron toggle of a sidebar file row that has sections, " +
          "shown when the sections are currently expanded.",
      },
      "nav.fileRow.expandSections": {
        description:
          "Tooltip on the same chevron toggle when the sections are currently collapsed.",
      },
      "nav.fileRow.collapse": {
        description: "Accessible name for the chevron toggle in its expanded state.",
      },
      "nav.fileRow.expand": {
        description: "Accessible name for the chevron toggle in its collapsed state.",
      },
      "nav.fileRow.timelineOrderedTooltip": {
        description:
          "Tooltip on the small waveform icon shown next to files whose cells are " +
          "ordered by timecode rather than sequence.",
      },
      "nav.fileRow.timelineOrderedFile": {
        description: "Accessible label for the same timeline-ordered indicator icon.",
      },
      "nav.fileRow.importedAsTooltip": {
        description:
          "Tooltip on a file's name showing both its current (possibly renamed) name " +
          "and the original name it was imported under.",
        placeholders: {
          name: "The file's current display name (user content).",
          originalName: "The file's original imported name (user content).",
        },
      },
      "nav.fileRow.progressAriaLabel": {
        description:
          "Accessible label for the reserved progress-meter slot on a file row, " +
          "spelling out the two small bars (translated/validated) as a sentence.",
        placeholders: {
          translated: "Percent of the file's cells translated, 0-100.",
          validated: "Percent of the file's cells validated, 0-100.",
        },
      },
      "nav.fileRow.fileActions": {
        description:
          "Tooltip and accessible name for the ⋯ button that opens the file's context " +
          "menu (rename, move, delete, export).",
      },
      "nav.fileRow.suggestionTooltip": {
        description:
          "Tooltip on the sparkle icon shown when an automatic cleaner-name suggestion " +
          "is available for this file. Longer than most nav tooltips — allowed to wrap " +
          "(max-w-xs on the tooltip), so it isn't length-constrained like the rest of " +
          "this namespace.",
      },
      "nav.fileRow.applyRenameSuggestion": {
        description: "Accessible name for the same sparkle 'apply suggestion' button.",
      },

      // -- ExpandableFileList --
      "nav.fileList.filterFiles": {
        description: "Accessible name for the file-filter search box above the file list.",
      },
      "nav.fileList.filterPlaceholder": {
        description: "Placeholder text inside the empty file-filter search box.",
      },
      "nav.fileList.clearFilter": {
        description: "Accessible name for the × button that clears the file filter.",
      },
      "nav.fileList.noFilesMatch": {
        description:
          "Empty-state text shown when the file filter has no matches. {filter} is the " +
          "user's own typed search text, quoted verbatim.",
        placeholders: { filter: "The user's current filter text, shown verbatim in quotes." },
      },
      "nav.fileList.noFilesImported": {
        description: "Empty-state text shown when the project has no files at all yet.",
      },
      "nav.fileList.expandGroup": {
        description:
          "Accessible name for a corpus/group header's collapse toggle when the group " +
          "is currently collapsed. {group} is the corpus name (often user-authored).",
        placeholders: { group: "The corpus/group's own label." },
      },
      "nav.fileList.collapseGroup": {
        description: "Mirrors nav.fileList.expandGroup for the currently-expanded state.",
        placeholders: { group: "The corpus/group's own label." },
      },
      "nav.fileList.renameGroup": {
        description:
          "Tooltip and accessible name for the pencil icon that starts inline renaming " +
          "of a corpus/group header.",
        placeholders: { group: "The corpus/group's own label." },
      },

      // -- OutboxInspectorPopover --
      "nav.outbox.popoverAriaLabel": {
        description: "Accessible label for the whole outbox popover panel.",
      },
      "nav.outbox.title": {
        description: "Heading at the top of the outbox popover.",
      },
      "nav.outbox.allSynced": {
        description:
          "Header status text (aria-live) shown when the outbox is completely empty.",
      },
      "nav.outbox.pendingCount": {
        description: "Header status text when there are pending-only (no failed) records.",
        placeholders: { count: "Number of records still pending sync." },
      },
      "nav.outbox.failedCount": {
        description: "Header status text when there are failed-only (no pending) records.",
        placeholders: { count: "Number of records that failed to sync." },
      },
      "nav.outbox.pendingAndFailedCount": {
        description:
          "Header status text when both pending and failed records exist at once, e.g. " +
          "'2 pending · 1 failed'.",
        placeholders: {
          pending: "Number of records still pending sync.",
          failed: "Number of records that failed to sync.",
        },
      },
      "nav.outbox.attempts": {
        description:
          "How many times the app has already tried to sync this one queued change, " +
          "shown after a bullet beside the relative timestamp on a record row. " +
          "'Try' here is a noun (an attempt), not the verb.",
        placeholders: { count: "Number of sync attempts made for this record." },
      },
      "nav.outbox.summaryEdits": {
        description:
          "One item of the outbox summary line, which lists what is queued by " +
          "category: '3 edits · 1 comment'. Refers to edits to a cell's translated " +
          "text, the same act nav.outbox.eventEdit names on a single row. Put " +
          "{count} wherever the numeral belongs in your language — it renders as a " +
          "bold, tabular-figure number, so the surrounding words are yours to order.",
        placeholders: { count: "Number of queued text edits." },
      },
      "nav.outbox.summaryValidations": {
        description:
          "The validation item of the outbox summary line: queued sign-offs and " +
          "un-sign-offs of a cell. Same shape as nav.outbox.summaryEdits — {count} " +
          "is the styled numeral and may go wherever your language puts it.",
        placeholders: { count: "Number of queued validate/unvalidate actions." },
      },
      "nav.outbox.summaryComments": {
        description:
          "The comment item of the outbox summary line: queued comment writes. Same " +
          "shape as nav.outbox.summaryEdits — {count} is the styled numeral and may " +
          "go wherever your language puts it.",
        placeholders: { count: "Number of queued comment changes." },
      },
      "nav.outbox.summaryOther": {
        description:
          "The catch-all item of the outbox summary line, covering every queued " +
          "change that is not a text edit, a validation or a comment (file " +
          "creation, audio attachment, and so on). 'Change' is deliberate: the " +
          "bucket is heterogeneous, so the noun has to be the general one. Same " +
          "shape as nav.outbox.summaryEdits.",
        placeholders: { count: "Number of queued changes in no other category." },
      },
      "nav.outbox.retryNow": {
        description:
          "Button in the outbox header that resets backoff and retries every queued " +
          "change immediately.",
      },
      "nav.outbox.sessionExpiredAlert": {
        description:
          "Inline alert shown when at least one record needs the user to sign in again " +
          "before it can retry.",
      },
      "nav.outbox.noPermissionMessage": {
        description:
          "Inline alert shown when at least one record was refused for permission " +
          "reasons — explicitly warns that re-signing in will NOT fix it, unlike the " +
          "session-expired alert.",
      },
      "nav.outbox.stuckMessage": {
        description:
          "Inline alert shown when at least one record exhausted its retry budget on " +
          "transient errors (and no permission failures are present).",
      },
      "nav.outbox.discardStuckChangesButton": {
        description:
          "Button under the no-permission/stuck alert that discards every discardable " +
          "record at once. 'Stuck' means the change exhausted its retry budget; it is " +
          "still saved locally until this button removes it.",
        placeholders: {
          count: "Number of discardable (stuck or not-allowed) records.",
        },
      },
      "nav.outbox.allCaughtUpTitle": {
        description: "Empty-state heading shown when the outbox has zero records.",
      },
      "nav.outbox.allCaughtUpDescription": {
        description: "Empty-state subtext under nav.outbox.allCaughtUpTitle.",
      },
      "nav.outbox.overflowMore": {
        description:
          "Footer note below a capped record list, showing how many more records are " +
          "queued beyond what's rendered (the true total, not just the in-memory slice).",
        placeholders: { count: "Number of additional queued records not shown in the list." },
      },
      "nav.outbox.footerPending": {
        description: "Popover footer note shown while at least one record is queued.",
      },
      "nav.outbox.footerSynced": {
        description: "Popover footer note shown when the outbox is empty.",
      },
      "nav.outbox.statusPending": { description: "Status badge text: queued, not yet attempted or retried." },
      "nav.outbox.statusRetrying": { description: "Status badge text: a transient error is being retried automatically." },
      "nav.outbox.statusNeedsSignin": { description: "Status badge text: a 401 — re-authenticating will fix it." },
      "nav.outbox.statusNoPermission": { description: "Status badge text: a 403 — re-authenticating will NOT fix it." },
      "nav.outbox.statusStuck": { description: "Status badge text: retry budget exhausted on a transient error." },
      "nav.outbox.eventEdit": { description: "Row title for a target-cell text edit." },
      "nav.outbox.eventNewCell": { description: "Row title for a newly created target cell." },
      "nav.outbox.eventDeleteCell": { description: "Row title for a deleted target cell." },
      "nav.outbox.eventReorderCell": { description: "Row title for a target cell reorder." },
      "nav.outbox.eventSourceEdit": { description: "Row title for an edit to a source (not target) cell." },
      "nav.outbox.eventNewSourceCell": { description: "Row title for a newly created source cell." },
      "nav.outbox.eventValidate": { description: "Row title for marking a cell's translation validated." },
      "nav.outbox.eventUnvalidate": { description: "Row title for removing a cell's validated mark." },
      "nav.outbox.eventNewComment": { description: "Row title for a newly posted comment." },
      "nav.outbox.eventEditComment": { description: "Row title for an edited comment." },
      "nav.outbox.eventDeleteComment": { description: "Row title for a deleted comment." },
      "nav.outbox.eventResolveComment": { description: "Row title for resolving a comment thread." },
      "nav.outbox.eventNewFile": { description: "Row title for a newly imported/created file." },
      "nav.outbox.eventAttachAudio": { description: "Row title for attaching an audio recording to a cell." },
      "nav.outbox.eventSelectAudio": { description: "Row title for choosing which attached audio take is active." },
      "nav.outbox.eventRemoveAudio": { description: "Row title for removing an attached audio recording." },
      "nav.outbox.previewEditRef": {
        description:
          "Fallback row preview for validate/unvalidate events, which have no text " +
          "body of their own — points at the edit event they act on.",
        placeholders: { id: "Shortened id of the edit event being validated/unvalidated." },
      },
      "nav.outbox.previewAudioSlot": {
        description: "Fallback row preview for an audio event that names which slot it targets.",
        placeholders: { slot: "The audio slot name (e.g. a take label)." },
      },
      "nav.outbox.previewAudio": {
        description: "Fallback row preview for an audio event with no slot information.",
      },
      "nav.outbox.timeJustNow": { description: "Relative-time label for events under 5 seconds old." },
      "nav.outbox.timeSecondsAgo": {
        description: "Relative-time label for events under a minute old.",
        placeholders: { sec: "Whole seconds elapsed." },
      },
      "nav.outbox.timeMinutesAgo": {
        description: "Relative-time label for events under an hour old.",
        placeholders: { min: "Whole minutes elapsed." },
      },
      "nav.outbox.timeHoursAgo": {
        description: "Relative-time label for events under a day old.",
        placeholders: { hr: "Whole hours elapsed." },
      },
      "nav.outbox.timeDaysAgo": {
        description: "Relative-time label for events a day or more old.",
        placeholders: { d: "Whole days elapsed." },
      },
      "nav.outbox.cellDetailLabel": {
        description: "Field label in a row's expanded detail panel, before the raw cell id.",
      },
      "nav.outbox.eventDetailLabel": {
        description: "Field label in a row's expanded detail panel, before the raw event id.",
      },
      "nav.outbox.errorDetailLabel": {
        description:
          "Field label in a row's expanded detail panel, before the server's error " +
          "status/reason (the reason text itself is server-supplied and not translated).",
      },
      "nav.outbox.discardChangeButton": {
        description: "Per-row button in a discardable record's expanded detail panel.",
      },
    },
  },
  surfaces: [
    {
      id: "workspace-nav",
      title: "Workspace navigation",
      route: "/project/:projectId",
      notes:
        "Left sidebar and top chrome of a project. Navigation labels sit in a narrow " +
        "column, so translations that are much longer than the English will wrap or clip.",
    },
  ],
})
