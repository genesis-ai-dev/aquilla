import { defineNamespace, plural } from "./types"

/**
 * Project workspace chrome that belongs to no single feature namespace: the
 * project shell and cards, creation dialog, member typeahead, timeline lanes,
 * post-edit metrics, status/offline/update banners and small shared dialogs.
 *
 * Registered ahead of its strings so the six parallel keying agents never
 * contend on `messages/en.ts` / `namespaces/index.ts` — see
 * `docs/swarm/I18N-COVERAGE-ORCHESTRATION.md`. A registered-but-empty namespace
 * is invisible to `CATALOG_CONTEXT` (its name is derived from its first key's
 * prefix), so this compiles and lints clean while empty.
 *
 * Declares no screenshot surface of its own: these strings render around the
 * `workspace-nav` and `editor-table` surfaces that `nav` and `editor` declare.
 */
export const workspace = defineNamespace({
  keys: {
    // -- ProjectWorkspace: session/access/loading states before the editor mounts --
    "workspace.status.notOnDevice": "This project isn't on this device. {signIn} to open it from the cloud.",
    // AQU-646, keyed 2026-08-20. Trails the "Deleted" badge on a project card,
    // so it starts with a space and reads as a continuation, not a sentence.
    "workspace.projectCard.deletedBy": " by {name}",
    "workspace.diarize.discardWarning": plural({
      one: "Diarizing re-segments this file and will DISCARD the transcription/translation on {count} section. Diarize first, then transcribe and translate. Continue anyway?",
      other: "Diarizing re-segments this file and will DISCARD the transcription/translation on {count} sections. Diarize first, then transcribe and translate. Continue anyway?",
    }),
    "workspace.idml.historyRestoreBlocked": "This IDML history entry cannot be restored safely.",
    "workspace.idml.replacementBlocked": "Protected IDML replacement was blocked.",
    "workspace.outbox.staleRejected": plural({
      one: "{count} change was rejected because it conflicted with a newer edit from another session.",
      other: "{count} changes were rejected because they conflicted with newer edits from another session.",
    }),
    // Tauri offline mode (Phase 3): a locally queued write lost the AD-2 head
    // CAS on reconnect (someone else committed to the same cell while this
    // device was offline). See src/lib/offline/conflicts.ts.
    "workspace.offline.conflictToast": plural({
      one: "{count} translation couldn't sync — it was changed elsewhere while you were offline.",
      other: "{count} translations couldn't sync — they were changed elsewhere while you were offline.",
    }),
    "workspace.offline.conflictDismiss": "Dismiss",
    "workspace.offline.conflictIndicatorTooltip": "This translation couldn't sync — it was changed elsewhere while you were offline. Review and re-apply your edit.",
    // Tauri offline mode (Phase 5): connectivity status chip in AppShell,
    // reading the Rust-side connectivity loop (src-tauri/src/connectivity.rs).
    "workspace.offline.connectivityOnline": "Online",
    "workspace.offline.connectivityOffline": "Offline",
    "workspace.offline.connectivityTooltipOnline": "Connected to the server.",
    "workspace.offline.connectivityTooltipOffline": "No connection — working offline. Changes sync once you're back online.",
    "workspace.status.unreachable": "Can't reach the server — your project may still be available.",
    "workspace.status.forbidden":
      "You no longer have access to this project. Ask a project maintainer to re-invite you if this is unexpected. {backLink}.",
    "workspace.status.notFound": "Project not found, or you don't have access. {backLink}.",
    "workspace.backToDashboard": "Back to dashboard",

    // -- hooks/useProjectSettings: patch() error fallback when called with no
    // signed-in session or no resolved project id (guards a race at mount,
    // not a normal user-reachable path) --
    "workspace.projectSettingsHook.noSessionError": "No session or project — sign in and try again.",

    // -- lib/forms/schemas (requiredString): shared cross-app form-field
    // validation, used from org, auth, onboarding, rules and settings forms
    // alike — there's no single feature namespace this belongs to more than
    // another, so it lives here as generic shared chrome. --
    "workspace.forms.requiredField": "{label} is required",

    // -- ProjectWorkspace: AppShell chrome --
    "workspace.sidebar.collapse": "Collapse sidebar",
    "workspace.readOnlyGitBanner": "Read-only — imported from git. Push is coming in Phase 2.",
    "workspace.staleSibling.viewInHistory": "View in history",
    // AQU-1340: a failed concepts read compiles to an EMPTY terminology rule
    // set, which silently switches off every term check in the editor. Say so
    // rather than letting the editor look like a project with no terminology.
    "workspace.terminologyUnavailableBanner":
      "Terminology checks are unavailable — the termbase could not be loaded, so term rules are not being applied.",
    "workspace.staleSource.message":
      "Source text changed since your last edit — your translation was saved, but please re-confirm it reflects the latest source.",
    "workspace.focusLock.editingNotice":
      "{user} is now editing this cell — your editor is read-only. Copy any unsaved text before moving away.",
    "workspace.loadingComments": "Loading comments",
    "workspace.loadingMemory": "Loading Living Memory",
    // "Loading terminology" → terminology.loadingLabel (same panel, same surface)

    // -- ProjectWorkspace: "Recently deleted" trash dialog --
    "workspace.trash.empty": "No recently deleted files.",
    "workspace.trash.restoreTooltip": "Cells and audio come back intact",
    "workspace.trash.purgeTooltip": "Permanently wipes R2 media",
    "workspace.trash.deleteForever": "Delete forever",
    "workspace.trash.retentionNote": "Files are kept for 30 days. \"Delete forever\" permanently wipes media.",

    // -- ProjectWorkspace: MoveToCorpusDialog --
    "workspace.moveToCorpus.dialogTitle": "Move to corpus",
    "workspace.moveToCorpus.createOption": "Create a corpus",
    "workspace.moveToCorpus.corpusNameField": "Corpus name",

    // -- ProjectWorkspace: TrashedProjectScreen --
    "workspace.trashedProject.title": "This project is in Trash",
    "workspace.trashedProject.movedMessage": "\"{name}\" was moved to Trash. Restore it to continue editing.",
    "workspace.trashedProject.movedByMessage":
      "\"{name}\" was moved to Trash by {deletedBy}. Restore it to continue editing.",

    // -- ProjectCreateDialog: the only two strings here without an exact-text
    // twin already sitting unused in projectSettings.create.* (everything else
    // in this dialog reuses that namespace directly at the call site — see
    // ProjectCreateDialog.tsx) --
    // "Project title" → projectSettings.info.titleLabel. Post-merge these are the
    // same sentence-case label for the same underlying value; the create dialog
    // already reuses projectSettings.create.* for the rest of its fields.
    "workspace.createDialog.targetChipsHint":
      "The first language is the project's primary target; each one you add below becomes its own lane.",

    // -- UsernameTypeahead --
    "workspace.typeahead.usernameModeTooltip": "Invite an existing Aquilla user",
    "workspace.typeahead.usernameModeLabel": "@user",
    "workspace.typeahead.emailModeTooltip": "Invite by email; they'll be prompted to sign up if needed",
    "workspace.typeahead.usernamePlaceholder": "Aquilla username",
    "workspace.typeahead.verifiedTooltip": "Verified Aquilla user",
    "workspace.typeahead.verifiedBadge": "verified",
    "workspace.typeahead.needsMorePrefix": "Type at least 2 characters to search.",
    "workspace.typeahead.allMatchesAlreadyMembers": "Matching users are already members.",
    "workspace.typeahead.checkingExactMatch": "Checking for an exact match…",
    "workspace.typeahead.exactMatchFound":
      "Not among people who share an org or project with you, but {username} is an Aquilla user.",
    "workspace.typeahead.addUser": "Add {username}",
    "workspace.typeahead.alreadyMember": "{username} is already a member.",
    "workspace.typeahead.noUserNamed": "No Aquilla user named \"{query}\".",
    "workspace.typeahead.inviteByEmailInstead": "Invite by email instead",
    "workspace.typeahead.noScopedMatch": "No match among people who share an org or project with you.",
    "workspace.typeahead.addByExactUsername": "Add \"{query}\" by exact username",
    "workspace.typeahead.searchUnavailable":
      "Couldn't search right now — we'll verify the username when you submit.",

    // -- PostEditMetricsSection --
    "workspace.metrics.nedLabel.minimal": "minimal",
    "workspace.metrics.nedLabel.light": "slight",
    "workspace.metrics.nedLabel.moderate": "moderate",
    "workspace.metrics.nedLabel.heavy": "heavy",
    "workspace.metrics.nedLabel.completeRewrite": "complete rewrite",
    "workspace.metrics.weekBarLabel": "{pct} avg NED",
    "workspace.metrics.approvalsColumn": "Approvals",
    "workspace.metrics.avgEditDistanceColumn": "Avg edit distance",
    "workspace.metrics.emptyNoData.title": "No post-edit pairs yet",
    "workspace.metrics.emptyNoData.description":
      "Pairs are recorded only after a human approves an AI draft or an edited descendant. " +
      "Generate a draft, review it, then approve it to add effort data here.",
    "workspace.metrics.emptyError.title": "Failed to load metrics",
    "workspace.metrics.emptyError.description": "Check your connection and try refreshing.",
    "workspace.metrics.emptyNoCloud.title": "Cloud sync required",
    "workspace.metrics.emptyNoCloud.description":
      "Metrics require a cloud-synced project. Sync this project to see AI post-edit statistics.",
    "workspace.metrics.cardTitle": "Approved AI Review Effort",
    "workspace.metrics.cardSubtitle":
      "Edit distance and elapsed time between machine drafts and final approved text.",
    "workspace.metrics.nedScale": "0% = accepted as-is · 100% = completely replaced.",
    "workspace.metrics.overallAvgNedLabel": "overall avg NED",
    "workspace.metrics.approvedPairsLabel": "approved draft pairs",
    "workspace.metrics.acceptedAsIsLabel": "accepted as-is",
    "workspace.metrics.avgReviewTimeLabel": "avg draft→approval",
    "workspace.metrics.effortLevelLabel": "effort level",
    "workspace.metrics.weeklyTrendHeading": "Weekly trend",
    "workspace.metrics.filteredTo": "— filtered to {user}",
    "workspace.metrics.noUserData": "No data for this user yet.",
    "workspace.metrics.byReviewerHeading": "By reviewer",
    "workspace.metrics.byReviewerHint": "(click a row to filter the trend above)",
    "workspace.metrics.disclosure":
      "Metric: character-level normalized Levenshtein distance (NED). Pairs require AQU-292 AI " +
      "provenance (ai_suggestion=true on the commit event). Only human-approved pairs are " +
      "included. Character insertions, deletions, substitutions, acceptance, model, prompt " +
      "version, and retrieved example IDs come from this project's private event history. " +
      "Elapsed time runs from draft commit to first approval and may include time away from " +
      "the editor. Historical commits before AQU-292 are excluded.",

    // -- App.tsx: SyncFreezeOverlay --
    "workspace.syncFreezeOverlay": "Merging incoming changes…",

    // -- AgentDockPanel: "Summarize book/chapter" quick-action buttons above
    // the dock's agent chat, shown only for scripture files --
    "workspace.agentDockPanel.summarizeBookTitle":
      "Summarize {book} using vetted Bible resources, in your profile language",

    // -- AiModelConsentDialog --
    "workspace.aiConsent.downloadTitle": "Download {model}?",
    "workspace.aiConsent.downloadProgressNote":
      "While the model downloads, you'll see a progress percentage on the cell. The page won't reload.",
    "workspace.aiConsent.oncePerBrowser": "You'll only see this prompt once per browser.",
    "workspace.aiConsent.enableAllTooltip": "Also pre-download the local AI models so they're ready next time",
    "workspace.aiConsent.enableAllButton": "Enable all local models",

    // -- AiModelDownloadChip --
    "workspace.aiDownloadChip.readyToUse": "ready to use",
    "workspace.aiDownloadChip.runsInBackground": "Runs in the background — keep working as normal.",

    // -- AiSetupDialog --
    "workspace.aiSetup.title": "Set up AI",
    "workspace.aiSetup.description":
      "Choose once how this project drafts. You can change it later in settings.",
    "workspace.aiSetup.fullSettingsLink": "Full settings →",
    "workspace.aiSetup.frontierDescriptionSignedIn":
      "Aquilla's hosted model with your {username} login. Billed as Aquilla usage.",
    "workspace.aiSetup.projectKeyLabel": "This project's API key",
    "workspace.aiSetup.projectKeyDescription":
      "Your OpenRouter or compatible key for this project on this device. Not shared with teammates, and not used on other projects.",
    "workspace.aiSetup.overrideDescription":
      "Use the endpoint already saved in Preferences ({endpoint}). Default for this browser; this project's API key beats it.",
    "workspace.aiSetup.overrideMissingError": "No personal override is saved in Preferences.",
    "workspace.aiSetup.overrideNeedsKey":
      "That override still needs an API key. Add it in Preferences, or choose this project's API key.",

    // -- ApiKeyField --
    "workspace.apiKeyField.saveAcrossProjects": "Save across my projects (this browser)",
    "workspace.apiKeyField.usingSavedKey": "Using your saved key. Type to override for this project only.",
    "workspace.apiKeyField.forgetSavedKey": "Forget saved key",

    // -- AssignModal --
    "workspace.assignModal.canModalVerb": "can",

    // -- AudioRecorder/DurationBar --
    "workspace.durationBar.targetLabel": "target {time}",
    // AQU-646: how far past the window a take has run.
    "workspace.durationBar.overBy": "+{seconds}s",

    // -- CellAiStatusPopover --
    "workspace.aiStatusPopover.technicalDetail": "Technical detail",

    // -- InlineAiError --
    "workspace.inlineAiError.showDetailsAriaLabel": "Show error details: {line}",

    // -- CellTranscribeBadge --
    "workspace.transcribeBadge.loadShort": "load",
    "workspace.transcribeBadge.transcribingTooltip": "Transcribing audio…",
    "workspace.transcribeBadge.transcribingPill": "transcribing",
    "workspace.transcribeBadge.failed": "Transcription failed",
    // {words} is a pre-pluralized fragment (reuses the identical
    // terminology.candidates.ngramLength "{count} word(s)" plural form) —
    // not re-pluralized here.
    "workspace.transcribeBadge.doneTooltip": "Transcribed {words} in {secs}s",
    "workspace.transcribeBadge.doneTooltipClickable": "Transcribed {words} in {secs}s; click to view",

    // -- CellTranscriptPreview --
    "workspace.transcriptPreview.retranscribeTooltip":
      "Listen to the recording again and refresh the transcript",
    "workspace.transcriptPreview.transcribeAgain": "Transcribe again",
    "workspace.transcriptPreview.replaceTextTooltip": "Replace your text with what the recording says",
    "workspace.transcriptPreview.fillTextTooltip": "Fill in your text from the recording",
    "workspace.transcriptPreview.useWhatWasHeard": "Use what was heard",
    "workspace.transcriptPreview.useAsText": "Use as the text",

    // -- ErrorBoundary --
    "workspace.errorBoundary.reload": "Reload",

    // -- GenerateOverwriteDialog --
    "workspace.generateOverwrite.dontAskAgain": "Don't ask again when replacing a translation",

    // -- HelpMenu --
    "workspace.helpMenu.homepage": "Homepage",

    // -- InactiveProjectBanner --
    "workspace.inactiveBanner.ariaLabel": "This project is inactive",
    "workspace.inactiveBanner.message": "{name} is inactive — it cannot be edited until reactivated.",

    // -- InterlinearAlignmentPanel (heading reuses editor.bt.alignment) --
    "workspace.alignment.confirmedBadge": "✓ confirmed",
    "workspace.alignment.rejectedBadge": "✗ rejected",
    "workspace.alignment.helpTooltipShort":
      "Word-level alignment links source and target tokens using a statistical model built from " +
      "your translated cells. Confirm correct alignments to improve future back-translations; " +
      "reject incorrect ones to penalize bad suggestions.",
    "workspace.alignment.insufficientData":
      "Keep translating — word-level alignments become meaningful once more sentences are validated.",
    "workspace.alignment.helpTooltipFull":
      "Word-level alignment: the statistical model links source and target tokens based on your " +
      "translated cells. Confirm correct pairs to teach the glosser; reject wrong ones to penalize " +
      "them. Both actions improve future back-translations. Only high-confidence suggestions are shown.",
    "workspace.alignment.needsConfirmation": "Needs confirmation ({count})",
    "workspace.alignment.confirmTooltip":
      "Confirm: mark \"{srcToken} -> {tgtToken}\" as a correct word-level alignment. Confirmed " +
      "pairs teach the statistical glosser and improve future back-translations.",
    "workspace.alignment.confirmAriaLabel":
      "Confirm alignment: {srcToken} translates as {tgtToken}. This teaches the glosser.",
    "workspace.alignment.rejectTooltip":
      "Reject: mark \"{srcToken} -> {tgtToken}\" as an incorrect alignment. Rejected pairs are " +
      "penalized so this suggestion won't appear again.",
    "workspace.alignment.rejectAriaLabel":
      "Reject alignment: {srcToken} does not translate as {tgtToken}. This penalizes the glosser " +
      "suggestion.",
    "workspace.alignment.contributorRequired":
      "Contributor+ required to confirm or reject alignments",

    // -- Original-language (Macula Greek/Hebrew) interlinear, AQU-462 --
    "workspace.alignment.originalHeading": "Original language",
    "workspace.alignment.originalSub": "— the Greek/Hebrew words behind this verse",
    "workspace.alignment.originalHelpTooltip":
      "Every word of the original-language source, with its dictionary form, Strong's number and " +
      "morphology. Where the model can place a word, its rendering in your translation is shown " +
      "beside it. Words matched through the dictionary form are marked — treat those as a hint.",
    "workspace.alignment.originalNoMatch": "no confident match",
    "workspace.alignment.originalViaLemma": "via lemma",
    "workspace.alignment.originalViaLemmaTooltip":
      "Matched through the dictionary form {lemma} rather than the form used in this verse, so it " +
      "is a weaker guess than a direct match.",

    // -- OfflineBanner --
    "workspace.offlineBanner.message": "You're offline — changes are queued and will sync when you reconnect.",

    // -- PeerPresence: live-collaborator avatar stack --
    "workspace.peerPresence.onlineCount": plural({ one: "{count} online", other: "{count} online" }),
    "workspace.peerPresence.collaboratorsOnlineTooltip": plural({
      one: "{count} collaborator online",
      other: "{count} collaborators online",
    }),

    // -- ProjectAssignedToMe --
    "workspace.assignedToMe.heading": "My assignments",
    "workspace.assignedToMe.jumpToTooltip": "Jump to {scope}",
    "workspace.assignedToMe.jumpToWithNoteTooltip": "Jump to {scope}: {note}",
    "workspace.assignedToMe.cellsProgress": plural(
      { one: "{done}/{total} cell", other: "{done}/{total} cells" },
      "total",
    ),

    // -- ProjectCard (badge/aria-label reuses org.projectOverview.inactiveBadge,
    // org.orgProjectsDataTable.actionsColumnSrOnly, comments.file.deletedBadge,
    // common.restore, search.expanded.fileCount) --
    "workspace.projectCard.inactiveTooltip": "This project is inactive and cannot be edited until reactivated",
    "workspace.projectCard.yourRoleTooltip": "Your role on this project",
    "workspace.projectCard.moveToTrash": "Move to Trash",
    "workspace.projectCard.awaitingSetup": "Awaiting setup",
    "workspace.projectCard.awaitingSetupBy": "Awaiting setup by {maintainer}",
    "workspace.projectCard.languagesNotSet": "Languages not set",

    // -- SourceSelectionToolbar --
    "workspace.sourceSelection.viewTerm": "View term",
    "workspace.sourceSelection.askAi": "Ask AI",
    "workspace.sourceSelection.addToTermbase": "Add to terminology",

    // -- StatusBar --
    "workspace.statusBar.summary": "{total} cells · {translated} translated {pct}",
    "workspace.statusBar.unvalidatedBadge": "{count} unvalidated",

    // -- UpdateBanner --
    "workspace.updateBanner.updateAvailable": "Update available",

    // -- ProjectWorkspace: legacy-measure batch toast (pre-merge takes with
    // no captured duration; "Measure all" runs a fix-it batch) --
    "workspace.legacyMeasure.partialSuccessToast": plural(
      {
        one: "Measured {measured} recording; {failed} could not be measured — re-record to fix those.",
        other: "Measured {measured} recordings; {failed} could not be measured — re-record to fix those.",
      },
      "measured",
    ),
    "workspace.legacyMeasure.successToast": plural(
      { one: "Measured {measured} recording.", other: "Measured {measured} recordings." },
      "measured",
    ),

    // -- WorkspaceSkeleton --
    "workspace.skeleton.loadingProject": "Loading project",

    // -- audio/DenoiseButton --
    "workspace.denoise.removedTooltip": "Background noise removed from this take",
    "workspace.denoise.removedBadge": "Noise removed",
    "workspace.denoise.revertTooltip": "Switch back to the original recording",
    "workspace.denoise.revertButton": "Revert",

    // -- chat/ChatComposer (Send reuses autopilot.steering.send, Stop reuses common.stop) --
    "workspace.chatComposer.queueTooltip": "Queue — sends when the current run finishes",
    "workspace.chatComposer.queueMessage": "Queue message",

    // -- chat/ChatMarkdown --
    "workspace.chatMarkdown.copyCode": "Copy code",

    // -- onboarding/steps/OrgStep --
    "workspace.orgStep.emailsPlaceholder": "alex@example.com, sam@example.com",

    // -- timeline/LinkVideoTimingDialog --
    "workspace.linkVideoTiming.title": "This file uses Free timing — the video won't be shown",
    "workspace.linkVideoTiming.description":
      "A linked video plays on the original recording's timing. This file is set to Free timing, " +
      "where the timeline re-flows to the translations' own lengths, so the video will stay " +
      "hidden until the file switches back to Original's timing — a maintainer can change that " +
      "any time with the timing control in the Media timeline, and switching is lossless.",
    "workspace.linkVideoTiming.linkAnyway": "Link anyway",

    // -- timeline/TimingModeChangedDialog --
    "workspace.timingModeChanged.title": "Timing mode changed",
    "workspace.timingModeChanged.description":
      "Someone with settings access switched this file from {from} to {to}. The Media timeline " +
      "now lays out on the new mode — recordings and timing data are untouched.",

    // -- timeline/TimingVideoWarningDialog --
    "workspace.timingVideoWarning.title": "Switch to Free timing and hide the video?",
    "workspace.timingVideoWarning.description":
      "This file has a linked video, which plays on the original recording's timing. Free " +
      "timing re-flows the timeline to the translations' own lengths, so the video will stay " +
      "hidden until the file switches back to Original's timing. Switching is lossless — no " +
      "timing data is changed either way.",
    "workspace.timingVideoWarning.confirmButton": "Switch to Free timing",

    // -- timeline/TimelineCard --
    "workspace.timelineCard.camLabel": "cam {state}",

    // -- timeline/TimelineChipStrip --
    "workspace.chipStrip.selectClipPrompt": "Select a clip to see its timing.",
    "workspace.chipStrip.sourceLabel": "Source:",
    "workspace.chipStrip.targetLabel": "Target:",
    "workspace.chipStrip.diffLabel": "Diff:",
    "workspace.chipStrip.startOverlapTooltip": "This target audio starts over the PREVIOUS verse's target audio",
    "workspace.chipStrip.startOverlapValue": "Start overlap: −{sec}s",
    "workspace.chipStrip.endOverlapTooltip": "This target audio runs over the NEXT verse's target audio",
    "workspace.chipStrip.endOverlapValue": "End overlap: −{sec}s",
    "workspace.chipStrip.eitherOverlapTooltip": "This target audio sounds over a neighbouring verse's target audio",
    "workspace.chipStrip.overlapValue": "Overlap: −{sec}s",
    "workspace.chipStrip.speakerLabel": "Speaker",
    "workspace.chipStrip.durationDiffTooltip": "Source duration − target duration",
    "workspace.chipStrip.durationDiffTooltipWithDetail": "Source duration − target duration · {detail}",
    "workspace.chipStrip.diffStartDetail": "Start: {value}",
    "workspace.chipStrip.diffEndDetail": "End: {value}",

    // -- timeline/TargetAudioLane --
    "workspace.targetAudioLane.previewTooLong":
      "This take is too long to preview here — play the timeline instead.",
    "workspace.targetAudioLane.previewTooLarge": "This take is too big to preview yet.",
    "workspace.targetAudioLane.previewTooLargeDetail":
      "Its length has never been measured, so it cannot be prepared for preview. Run Measure all from the file menu and try again.",
    "workspace.targetAudioLane.previewUnavailable": "This take cannot be previewed.",
    "workspace.targetAudioLane.overlapsNext": "Overlaps the next dub",
    "workspace.targetAudioLane.overlapsPrevious": "Overlaps the previous dub",
    "workspace.targetAudioLane.recordAudio": "Record audio for this line",
    // AQU-646 stage 5: the other corner of the same chip.
    "workspace.targetAudioLane.playClip": "Play this clip",
    "workspace.targetAudioLane.takeValidated": "This take is validated",
    "workspace.targetAudioLane.takeValidatedByYou": "You have validated this take",
    "workspace.targetAudioLane.runsPastSectionTooltip": "Runs {sec}s past the section",
    "workspace.targetAudioLane.drawnShortNeighboringDubsStay":
      "Drawn short at rest so the neighbouring dubs stay reachable",
    "workspace.targetAudioLane.drawnShortPreviousDubStays":
      "Drawn short at rest so the previous dub stays reachable",
    "workspace.targetAudioLane.drawnShortNextDubStays":
      "Drawn short at rest so the next dub stays reachable",

    // -- ui/data-table --
    "workspace.dataTable.noResults": "No results.",

    // -- voice/CastGutterVoice --
    "workspace.castGutterVoice.applyToAllLines": "Apply to all «{name}» lines",

    // -- hooks/useOpenWorkspace --
    "workspace.openWorkspace.openingProject": "Opening project",

    // -- lib/progress/file-sort (per-file breakdown sort-mode picker on
    // ProjectOverview) --
    "workspace.fileSort.lastUpdated": "Last updated",
    "workspace.fileSort.canonical": "Canonical order",
    "workspace.fileSort.alphabetical": "Alphabetical",
  },
  context: {
    _context: {
      description:
        "Project workspace chrome outside any one feature: the project shell, project " +
        "cards and creation dialog, member typeahead, audio/video timeline lanes, " +
        "post-edit metrics, and the connectivity/update banners. Seen constantly by " +
        "every translator using the product, usually out of the corner of the eye — " +
        "favour short, concrete wording over explanatory sentences.",
      screenshot: "workspace-nav",
    },
    keys: {
      "workspace.diarize.discardWarning": {
        description:
          "Body of the browser confirm() shown before diarizing a file that already " +
          "has work on it. Ends in a question because the dialog's buttons answer " +
          "it. DISCARD is capitalised deliberately — it is the word that stops " +
          "someone clicking through — and the recommended order is stated before " +
          "the question.",
        placeholders: {
          count: "How many sections would lose their transcription or translation.",
        },
      },
      "workspace.outbox.staleRejected": {
        description:
          "Amber banner above the editor after the server refused queued edits " +
          "that a newer edit from another session had overtaken. Full sentence " +
          "with a period. States the cause, not blame.",
        placeholders: {
          count: "How many queued changes were rejected.",
        },
      },
      "workspace.offline.conflictToast": {
        description:
          "Title of the toast shown in the Tauri desktop app when one or more " +
          "translations queued while offline lost to a newer edit from someone " +
          "else on reconnect (AD-2 head CAS). Paired with a 'Dismiss' action " +
          "(workspace.offline.conflictDismiss) that clears the whole batch at " +
          "once. Full sentence with a period. States the cause, not blame.",
        placeholders: {
          count: "How many translations couldn't sync.",
        },
      },
      "workspace.projectCard.deletedBy": {
        description:
          "Trailing fragment appended to the 'Deleted' badge on a project card, " +
          "naming who deleted it. NOT a sentence — it continues the badge and is " +
          "followed by a middle dot and a date, so it keeps its leading space and " +
          "takes no capital and no period.",
        placeholders: {
          name: "Username of the person who deleted the project.",
        },
      },
      "workspace.status.notOnDevice": {
        description:
          "Shown instead of the editor when the project exists only server-side and " +
          "the current browser has no local session for it. {signIn} is a translated " +
          "'Sign in' link (reusing auth.login.submitDefault) rendered inline mid-" +
          "sentence — keep the whole thing as one flowing sentence, not two fragments.",
        placeholders: { signIn: "The 'Sign in' link/button, already translated and rendered as a link." },
      },
      "workspace.status.unreachable": {
        description:
          "Shown instead of the editor when a request for the project failed with a " +
          "server/network error (as opposed to a genuine 404) — the project may still " +
          "exist. Paired with a 'Retry' button (common.retry).",
      },
      "workspace.status.forbidden": {
        description:
          "Shown instead of the editor when the signed-in user's access to this " +
          "project was revoked or never granted. {backLink} is a translated 'Back to " +
          "dashboard' link (workspace.backToDashboard) rendered inline right before " +
          "the final period — keep it part of the same sentence.",
        placeholders: { backLink: "The 'Back to dashboard' link, already translated and rendered as a link." },
      },
      "workspace.status.notFound": {
        description:
          "Shown instead of the editor when no project with this id exists at all. " +
          "{backLink} is the same translated 'Back to dashboard' link as " +
          "workspace.status.forbidden, rendered inline right before the final period.",
        placeholders: { backLink: "The 'Back to dashboard' link, already translated and rendered as a link." },
      },
      "workspace.backToDashboard": {
        description:
          "Link/button text that navigates away from a project error/access screen " +
          "back to the project list. Reused by the not-on-device, forbidden, not-" +
          "found and trashed-project screens so every 'return to safety' exit reads " +
          "identically.",
      },
      "workspace.projectSettingsHook.noSessionError": {
        description:
          "Error result surfaced in place of a save-confirmation when useProjectSettings' " +
          "patch() is called with no signed-in session or no resolved project id — a " +
          "mount-order race, not a normal user action. Rare in practice; callers that " +
          "show it should also offer a retry.",
      },
      "workspace.forms.requiredField": {
        description:
          "Generic required-field validation error shown under a text input across many " +
          "different forms (team name, source term, username/email, rule name, …). " +
          "{label} names the specific field, as a short noun phrase — do not translate it " +
          "here; it is passed in as data by each call site.",
        placeholders: {
          label: "The field's short name (e.g. 'Team name') — not translated as part of this key.",
        },
      },
      "workspace.agentDockPanel.summarizeBookTitle": {
        description:
          "Tooltip/title on the 'Summarize book' quick-action button above the agent " +
          "dock's chat, shown only when a scripture file is open. Queues an agent prompt " +
          "that summarizes the book using vetted resources, replying in the reader's own " +
          "profile language (not necessarily the UI language).",
        placeholders: { book: "The open book's display name (e.g. 'Genesis') — not translated." },
      },
      "workspace.sidebar.collapse": {
        description:
          "Tooltip and accessible name for the icon button in the top-left app " +
          "chrome that collapses the expanded left dock back to its narrow icon " +
          "rail. Mirrors nav.dock.expandSidebar for the opposite direction.",
        screenshot: "workspace-nav",
      },
      "workspace.readOnlyGitBanner": {
        description:
          "Banner shown across the top of the editor when the open project was " +
          "imported from a Git repository and cannot be edited from Aquilla yet. " +
          "'git' and 'Phase 2' are technical/roadmap terms — keep 'git' " +
          "untranslated as the tool's name.",
        maxLength: 90,
      },
      "workspace.staleSibling.viewInHistory": {
        description:
          "Button on the stale-edit-conflict banner that opens the affected cell's " +
          "history drawer, where the rejected edit is preserved and can be reviewed.",
        maxLength: 24,
      },
      "workspace.staleSource.message": {
        description:
          "Banner shown when the source text of a cell the user just translated " +
          "changed after they saved their translation — asks them to re-check it " +
          "still matches. Paired with a Dismiss button (common.dismiss).",
      },
      "workspace.focusLock.editingNotice": {
        description:
          "Banner shown when another user claims editing focus on the cell the " +
          "current user is looking at, making the editor read-only for them. " +
          "{user} is that other person's raw user id/handle — not translated, " +
          "just interpolated at the front of the sentence.",
        placeholders: { user: "The other user's id/handle who now holds the edit lock." },
      },
      "workspace.loadingComments": {
        description:
          "Loading-panel label shown while the full-page Comments surface inside " +
          "the workspace shell is being fetched.",
      },
      "workspace.loadingMemory": {
        description:
          "Loading-panel label shown while the full-page Living Memory surface " +
          "inside the workspace shell is being fetched. 'Living Memory' is the " +
          "product name of that surface — keep it aligned with " +
          "terminology.livingMemory.title.",
      },
      "workspace.trash.empty": {
        description:
          "Empty-state text inside the 'Recently deleted' dialog (nav." +
          "sidebarSection.trash) when the project has no soft-deleted files.",
      },
      "workspace.trash.restoreTooltip": {
        description:
          "Tooltip on the Restore button (common.restore) for one soft-deleted " +
          "file row, reassuring that its cells and audio return intact.",
        maxLength: 48,
      },
      "workspace.trash.purgeTooltip": {
        description:
          "Tooltip on the 'Delete forever' button for one soft-deleted file row, " +
          "warning that its stored media is permanently wiped.",
        maxLength: 48,
      },
      "workspace.trash.deleteForever": {
        description:
          "Destructive per-row button in the 'Recently deleted' dialog that " +
          "permanently purges a soft-deleted file's data (as opposed to " +
          "common.delete, the everyday delete action elsewhere).",
        maxLength: 24,
      },
      "workspace.trash.retentionNote": {
        description:
          "Footer note in the 'Recently deleted' dialog explaining the 30-day " +
          "retention window. Quotes 'Delete forever' (workspace.trash." +
          "deleteForever) verbatim — keep the two consistent if either changes.",
      },
      "workspace.moveToCorpus.dialogTitle": {
        description:
          "Heading of the dialog that assigns a file to a corpus (a named " +
          "grouping of files). Distinct from nav.workspaceActions (WS elsewhere) " +
          "— this is the modal's own title, not a menu item with an ellipsis.",
        screenshot: "confirm-dialog",
      },
      "workspace.moveToCorpus.createOption": {
        description:
          "Select option (and its footer menu item) that switches the move-to-" +
          "corpus dialog into 'type a new corpus name' mode.",
      },
      "workspace.moveToCorpus.corpusNameField": {
        description:
          "Placeholder and accessible name for the free-text input that appears " +
          "when creating a brand-new corpus from the move-to-corpus dialog.",
      },
      "workspace.trashedProject.title": {
        description:
          "Full-screen heading shown instead of the editor when the whole open " +
          "project itself has been soft-deleted (moved to Trash), not just a file " +
          "inside it.",
        screenshot: "confirm-dialog",
      },
      "workspace.trashedProject.movedMessage": {
        description:
          "Body text on the trashed-project screen when no record exists of who " +
          "deleted the project. {name} is the project's own name, already quoted " +
          "by the template.",
        placeholders: { name: "The trashed project's display name, already quoted by the template." },
      },
      "workspace.trashedProject.movedByMessage": {
        description:
          "Body text on the trashed-project screen when the deleting user is " +
          "known — same sentence as workspace.trashedProject.movedMessage plus " +
          "who did it. {name} is already quoted by the template.",
        placeholders: {
          name: "The trashed project's display name, already quoted by the template.",
          deletedBy: "The username of whoever moved the project to Trash.",
        },
      },
      "workspace.createDialog.targetChipsHint": {
        description:
          "Field description under the multi-language target-language chip " +
          "input (self-contained shape only), explaining how to add languages " +
          "and that the first one is primary.",
        screenshot: "confirm-dialog",
      },

      "workspace.typeahead.usernameModeTooltip": {
        description:
          "Tooltip on the '@user' mode-toggle chip in UsernameTypeahead " +
          "(member-invite inputs across the app), explaining what username mode does.",
        screenshot: "assign-modal",
      },
      "workspace.typeahead.usernameModeLabel": {
        description:
          "Visible label of the username-mode toggle chip, an '@' sigil plus " +
          "'user' — kept compact (10px text) to sit beside its email sibling.",
        maxLength: 10,
        screenshot: "assign-modal",
      },
      "workspace.typeahead.emailModeTooltip": {
        description:
          "Tooltip on the email-mode toggle chip, explaining that picking it " +
          "invites someone by email who may not have an account yet.",
        screenshot: "assign-modal",
      },
      "workspace.typeahead.usernamePlaceholder": {
        description:
          "Placeholder text inside the empty username-search input, when no " +
          "caller-supplied placeholder override is given.",
        screenshot: "assign-modal",
      },
      "workspace.typeahead.verifiedTooltip": {
        description:
          "Tooltip on the small 'verified' badge shown once a typed username " +
          "has been resolved to a real, confirmed account.",
      },
      "workspace.typeahead.verifiedBadge": {
        description:
          "Compact badge text (10px, beside a checkmark icon) confirming the " +
          "typed username resolved to a real account. Lower-case to match its " +
          "small pill styling; distinct from a sentence-case status word.",
        maxLength: 12,
      },
      "workspace.typeahead.needsMorePrefix": {
        description:
          "Hint shown in the empty results dropdown while fewer than 2 " +
          "characters have been typed — search hasn't fired yet.",
        screenshot: "assign-modal",
      },
      "workspace.typeahead.allMatchesAlreadyMembers": {
        description:
          "Empty-state text shown when every server search result for the " +
          "typed text is already excluded (already a member/assignee).",
        screenshot: "assign-modal",
      },
      "workspace.typeahead.checkingExactMatch": {
        description:
          "Transient status shown while re-checking an unscoped exact-username " +
          "lookup after the scoped search came back with no matches.",
      },
      "workspace.typeahead.exactMatchFound": {
        description:
          "Shown when the scoped search found nothing but an unscoped exact-" +
          "username lookup found a real account outside the caller's org/" +
          "project. {username} is that account's username, rendered in bold.",
        placeholders: { username: "The matched username, rendered as bold markup." },
        screenshot: "assign-modal",
      },
      "workspace.typeahead.addUser": {
        description:
          "Button that adds the exact-match user found by workspace.typeahead." +
          "exactMatchFound. {username} is that user's username.",
        placeholders: { username: "The username to add." },
      },
      "workspace.typeahead.alreadyMember": {
        description:
          "Shown instead of an Add button when the exact-match user found is " +
          "already excluded (already a member/assignee). {username} is that " +
          "user's username.",
        placeholders: { username: "The username that is already a member." },
      },
      "workspace.typeahead.noUserNamed": {
        description:
          "Shown when the unscoped exact lookup confirms no account exists " +
          "with the typed name at all. {query} is the user's own typed text, " +
          "already quoted by the template.",
        placeholders: { query: "The typed username, already quoted by the template." },
        screenshot: "assign-modal",
      },
      "workspace.typeahead.inviteByEmailInstead": {
        description:
          "Fallback link offered after a username search dead-ends, switching " +
          "the input to email-invite mode. Shown in two different dead-end " +
          "states (confirmed no such user; lookup inconclusive) with identical " +
          "wording both times.",
        screenshot: "assign-modal",
      },
      "workspace.typeahead.noScopedMatch": {
        description:
          "Shown when the exact-username lookup itself failed (network/" +
          "endpoint error) so existence could not be confirmed either way — " +
          "distinct from workspace.typeahead.noUserNamed, which is a definite miss.",
        screenshot: "assign-modal",
      },
      "workspace.typeahead.addByExactUsername": {
        description:
          "Button offered when the exact-lookup result is inconclusive " +
          "(unscoped search failed or errored), letting the caller stage the " +
          "typed text as-is and verify it server-side on submit. {query} is " +
          "the typed username, already quoted by the template.",
        placeholders: { query: "The typed username, already quoted by the template." },
        screenshot: "assign-modal",
      },
      "workspace.typeahead.searchUnavailable": {
        description:
          "Shown when the whole search request failed (not just the exact-" +
          "match fallback) — reassures that the username will still be " +
          "checked when the form is submitted.",
        screenshot: "assign-modal",
      },

      "workspace.metrics.nedLabel.minimal": {
        description:
          "Lowest effort-level bucket for post-edit magnitude (NED < 10%): the " +
          "AI draft was accepted nearly unchanged. Shown as a badge and as a " +
          "parenthetical beside a reviewer's average percentage.",
      },
      "workspace.metrics.nedLabel.light": {
        description: "Effort-level bucket for NED 10-30%: light editing of the AI draft.",
      },
      "workspace.metrics.nedLabel.moderate": {
        description: "Effort-level bucket for NED 30-60%: moderate editing of the AI draft.",
      },
      "workspace.metrics.nedLabel.heavy": {
        description: "Effort-level bucket for NED 60-85%: heavy editing of the AI draft.",
      },
      "workspace.metrics.nedLabel.completeRewrite": {
        description:
          "Highest effort-level bucket for post-edit magnitude (NED ≥ 85%): the " +
          "AI draft was effectively discarded and rewritten by hand.",
      },
      "workspace.metrics.weekBarLabel": {
        description:
          "Label inside one week's bar in the post-edit-metrics weekly trend " +
          "chart, stating that week's average edit magnitude. {pct} is an " +
          "already-formatted percentage (e.g. '42%'). 'NED' (normalized edit " +
          "distance) is this feature's fixed technical term — keep it " +
          "untranslated, as in workspace.metrics.disclosure.",
        placeholders: { pct: "Already-formatted percentage, e.g. '42%'." },
      },
      "workspace.metrics.approvalsColumn": {
        description:
          "Column heading in the by-reviewer table: how many drafts this " +
          "person approved. Plural noun, sibling of the Reviewer and Avg-edit-" +
          "distance columns.",
      },
      "workspace.metrics.avgEditDistanceColumn": {
        description:
          "Column heading in the by-reviewer table for a reviewer's average " +
          "post-edit magnitude (NED), shown as a percentage plus effort-level word.",
      },
      "workspace.metrics.emptyNoData.title": {
        description:
          "Empty-state heading when the project has zero recorded post-edit " +
          "pairs yet (as opposed to a load error or a non-cloud project).",
      },
      "workspace.metrics.emptyNoData.description": {
        description: "Empty-state body explaining how post-edit pairs get recorded, under workspace.metrics.emptyNoData.title.",
      },
      "workspace.metrics.emptyError.title": {
        description: "Empty-state heading when fetching the post-edit metrics failed.",
      },
      "workspace.metrics.emptyError.description": {
        description: "Empty-state body under workspace.metrics.emptyError.title, suggesting a retry.",
      },
      "workspace.metrics.emptyNoCloud.title": {
        description:
          "Empty-state heading shown when the open project isn't cloud-synced, " +
          "so no post-edit history exists to measure.",
      },
      "workspace.metrics.emptyNoCloud.description": {
        description: "Empty-state body under workspace.metrics.emptyNoCloud.title.",
      },
      "workspace.metrics.cardTitle": {
        description:
          "Heading of the post-edit AI metrics card in Project Settings, " +
          "reachable via the 'AI Metrics' nav entry.",
        screenshot: "project-settings",
      },
      "workspace.metrics.cardSubtitle": {
        description:
          "One-line explanation under the card title, of what the metric " +
          "measures. Followed immediately by workspace.metrics.nedScale in the " +
          "same paragraph (italicized).",
        screenshot: "project-settings",
      },
      "workspace.metrics.nedScale": {
        description:
          "Italicized clause completing workspace.metrics.cardSubtitle's " +
          "sentence, anchoring the 0-100% edit-magnitude scale with its two " +
          "endpoints.",
        screenshot: "project-settings",
      },
      "workspace.metrics.overallAvgNedLabel": {
        description:
          "Caption under the first summary stat tile (a percentage): the " +
          "project-wide average post-edit magnitude. Lower-case, small caption " +
          "under a large number — sibling of the other stat-tile captions.",
      },
      "workspace.metrics.approvedPairsLabel": {
        description:
          "Caption under the second summary stat tile (a count): how many " +
          "approved draft→final pairs the metrics are computed from.",
      },
      "workspace.metrics.acceptedAsIsLabel": {
        description:
          "Caption under the third summary stat tile (a percentage): the share " +
          "of drafts accepted with no edits at all.",
      },
      "workspace.metrics.avgReviewTimeLabel": {
        description:
          "Caption under the fourth summary stat tile (a formatted duration): " +
          "the average elapsed time from AI draft to human approval.",
      },
      "workspace.metrics.effortLevelLabel": {
        description:
          "Caption under the fifth summary stat tile (a colored badge showing " +
          "one of the workspace.metrics.nedLabel.* words): the project's " +
          "overall effort-level bucket.",
      },
      "workspace.metrics.weeklyTrendHeading": {
        description:
          "Heading over the weekly bar chart of post-edit magnitude. When a " +
          "reviewer is selected in the table below, workspace.metrics." +
          "filteredTo is appended after it on the same line.",
      },
      "workspace.metrics.filteredTo": {
        description:
          "Appended after workspace.metrics.weeklyTrendHeading when the chart " +
          "is filtered to one reviewer's pairs. {user} is that reviewer's " +
          "username, rendered in monospace. Followed by a 'Clear' button " +
          "(common.clear) that removes the filter.",
        placeholders: { user: "The selected reviewer's username, rendered as monospace markup." },
      },
      "workspace.metrics.noUserData": {
        description:
          "Shown instead of the weekly chart when the selected reviewer has no " +
          "weeks with data (edge case after filtering).",
      },
      "workspace.metrics.byReviewerHeading": {
        description: "Heading over the by-reviewer breakdown table.",
      },
      "workspace.metrics.byReviewerHint": {
        description:
          "Small parenthetical note appended after workspace.metrics." +
          "byReviewerHeading, explaining that clicking a row filters the chart above.",
      },
      "workspace.metrics.disclosure": {
        description:
          "Small-print methodology footnote at the bottom of the AI metrics " +
          "card, explaining what NED measures, its data source, and its " +
          "limitations. 'NED', 'AQU-292' and 'ai_suggestion' are fixed " +
          "technical/internal terms — keep them untranslated.",
      },

      "workspace.syncFreezeOverlay": {
        description:
          "Thin banner pinned to the top of the whole app while an incoming " +
          "sync frame is being merged into local state — a brief, blocking " +
          "moment. Present participle, no punctuation.",
      },

      "workspace.aiConsent.downloadTitle": {
        description:
          "Heading of the one-time consent dialog shown before Aquilla " +
          "downloads a local AI model (speech-to-text or text-to-speech) to " +
          "the browser. {model} is the model's own display name, or a generic " +
          "fallback ('AI model') when unknown.",
        placeholders: { model: "The AI model's display name, or a generic fallback." },
        screenshot: "confirm-dialog",
      },
      "workspace.aiConsent.downloadProgressNote": {
        description:
          "Body copy under a small spinner icon, explaining what the user " +
          "will see while the model downloads (a progress percentage on the " +
          "cell) and reassuring the page won't reload.",
        screenshot: "confirm-dialog",
      },
      "workspace.aiConsent.oncePerBrowser": {
        description: "Second line of body copy noting this consent prompt only appears once per browser.",
        screenshot: "confirm-dialog",
      },
      "workspace.aiConsent.enableAllTooltip": {
        description:
          "Tooltip on the 'Enable all local models' button, explaining it " +
          "pre-downloads every local model instead of just the one currently needed.",
        screenshot: "confirm-dialog",
      },
      "workspace.aiConsent.enableAllButton": {
        description:
          "Button that consents to and starts downloading every local AI " +
          "model at once, instead of just the one the current feature needs.",
        screenshot: "confirm-dialog",
      },

      "workspace.aiDownloadChip.readyToUse": {
        description:
          "Small trailing note beside a just-finished model's name in the " +
          "floating download-status chip's success list, confirming it's " +
          "ready. Lower-case, sits after the model name like a status word.",
      },
      "workspace.aiDownloadChip.runsInBackground": {
        description:
          "Small reassurance footer at the bottom of the floating AI-model-" +
          "download status chip while downloads are in progress, noting the " +
          "user doesn't need to wait around.",
      },

      "workspace.aiSetup.title": {
        description:
          "Heading of the compact dialog that offers to configure an AI " +
          "provider (for translation suggestions), opened from an inline " +
          "nudge. Short, alongside a sparkle icon.",
        screenshot: "confirm-dialog",
      },
      "workspace.aiSetup.description": {
        description:
          "Subtitle of the one-time Set up AI chooser. They pick Frontier, a " +
          "project API key, or a personal override; the dialog does not return " +
          "after that choice.",
        screenshot: "confirm-dialog",
      },
      "workspace.aiSetup.fullSettingsLink": {
        description:
          "Link at the bottom of the compact AI-setup dialog that closes it " +
          "and navigates to the full Project Settings AI section instead. " +
          "Keep the trailing arrow glyph (→) or your language's equivalent " +
          "'go to' convention.",
        screenshot: "confirm-dialog",
      },
      "workspace.aiSetup.frontierDescriptionSignedIn": {
        description:
          "Body of the Frontier option when the user is signed in. Names the " +
          "account and that hosted drafts bill as Aquilla usage, not a BYOK key.",
        placeholders: {
          username: "Signed-in account username.",
        },
        screenshot: "confirm-dialog",
      },
      "workspace.aiSetup.projectKeyLabel": {
        description:
          "Title of the per-project bring-your-own-key option. Contrast with " +
          "the personal override (Preferences, all projects) and Frontier " +
          "(hosted). Short, no period.",
        screenshot: "confirm-dialog",
      },
      "workspace.aiSetup.projectKeyDescription": {
        description:
          "Body of the project API-key option. The key is the user's, but it " +
          "is stored on this project on this device — not a teammate-synced " +
          "setting and not the device-wide personal override.",
        screenshot: "confirm-dialog",
      },
      "workspace.aiSetup.overrideDescription": {
        description:
          "Body of the personal-override option, naming the saved endpoint " +
          "and that it is the browser default until this project has its own key.",
        placeholders: {
          endpoint: "The OpenAI-compatible base URL already saved in Preferences.",
        },
        screenshot: "confirm-dialog",
      },
      "workspace.aiSetup.overrideMissingError": {
        description: "Error if Continue is pressed on override but none is stored.",
      },
      "workspace.aiSetup.overrideNeedsKey": {
        description:
          "Error when the saved personal override is a hosted endpoint with no key.",
      },

      "workspace.apiKeyField.saveAcrossProjects": {
        description:
          "Checkbox label on the reusable API-key input, offering to also " +
          "save the key to this browser's local storage so it's reused by " +
          "other projects, not just the current one.",
      },
      "workspace.apiKeyField.usingSavedKey": {
        description:
          "Confirmation note shown when the field is displaying a key that " +
          "came from browser-local storage rather than this project's own " +
          "settings, and that typing will override it for this project only.",
      },
      "workspace.apiKeyField.forgetSavedKey": {
        description:
          "Link that deletes the browser-saved API key and turns off the " +
          "save-across-projects checkbox, shown only when a saved key exists.",
      },

      "workspace.assignModal.canModalVerb": {
        description:
          "The modal verb 'can' as an isolated, italicized emphasis word " +
          "inside dialog.assign.laneDescription's {can} placeholder — the " +
          "emphasis is the whole point of that sentence (assigning work vs " +
          "gating who is allowed to edit), so this exact word must be " +
          "translatable and not hardcoded.",
      },

      "workspace.durationBar.overBy": {
        description:
          "Shown beside the running time in the recorder when a take has passed " +
          "the length of the line it is for, so the performer does not have to " +
          "subtract two timecodes while recording. The plus sign is meaningful " +
          "— it always reads as an overrun and never as a countdown — and the " +
          "unit is seconds to one decimal place. Keep it very short; it sits " +
          "between two other numbers on one narrow row.",
        placeholders: {
          seconds: "How far past the target the take has run, in seconds to one decimal place, without a sign.",
        },
      },
      "workspace.durationBar.targetLabel": {
        description:
          "Small caption beside the elapsed-time readout on a recording's " +
          "duration bar, naming the target duration. {time} is an already-" +
          "formatted mm:ss.t duration.",
        placeholders: { time: "Already-formatted target duration (mm:ss.t)." },
      },

      "workspace.aiStatusPopover.technicalDetail": {
        description:
          "Collapsed <details> summary inside the per-cell AI error popover, " +
          "revealing the raw provider error message below it.",
      },

      "workspace.inlineAiError.showDetailsAriaLabel": {
        description:
          "Accessible name for the info-icon button beside an inline AI-failure line " +
          "(draft, batch completion, back-translation, agent apply, …), which opens the " +
          "full error in a popover. {line} is the same short line already shown inline — " +
          "already localized/composed upstream (an optional operation label plus a " +
          "categorized, human-readable summary) — do not translate it again.",
        placeholders: { line: "The inline error summary already visible next to this button — not translated here." },
      },

      "workspace.transcribeBadge.loadShort": {
        description:
          "Ultra-compact gutter-pill text shown while the Whisper model is " +
          "still starting up, before a download percentage is known. " +
          "Deliberately terse — the pill is a few characters wide.",
        maxLength: 8,
      },
      "workspace.transcribeBadge.transcribingTooltip": {
        description: "Tooltip on the gutter pill shown while Whisper transcription is actively running on a cell.",
      },
      "workspace.transcribeBadge.transcribingPill": {
        description:
          "Compact lower-case gutter-pill text for the same actively-" +
          "transcribing state as workspace.transcribeBadge.transcribingTooltip.",
        maxLength: 14,
      },
      "workspace.transcribeBadge.failed": {
        description: "Gutter-pill button text when transcription errored; clicking it opens the error popover.",
        maxLength: 24,
      },
      "workspace.transcribeBadge.doneTooltip": {
        description:
          "Tooltip on the gutter pill's brief post-transcription success flash, when the " +
          "pill isn't clickable (no jump-to-transcript handler wired). {words} is already " +
          "a fully-formed, pre-pluralized phrase — do not translate it again or wrap it.",
        placeholders: {
          words: "Pre-pluralized '{count} word'/'{count} words' phrase — already localized upstream.",
          secs: "Transcription duration in seconds, one decimal place, as a plain number.",
        },
      },
      "workspace.transcribeBadge.doneTooltipClickable": {
        description:
          "Same as workspace.transcribeBadge.doneTooltip, with a trailing clause added " +
          "when the pill IS clickable (jumps to the transcript). Keep both variants in " +
          "sync but do not merge them — the trailing clause must not appear when the pill " +
          "isn't interactive.",
        placeholders: {
          words: "Pre-pluralized '{count} word'/'{count} words' phrase — already localized upstream.",
          secs: "Transcription duration in seconds, one decimal place, as a plain number.",
        },
      },

      "workspace.transcriptPreview.retranscribeTooltip": {
        description:
          "Tooltip on the 'Transcribe again' button in the per-cell " +
          "transcript-preview panel, shown for both the stale-timing and " +
          "differs-from-text states.",
      },
      "workspace.transcriptPreview.transcribeAgain": {
        description:
          "Button that re-runs transcription on the cell's existing " +
          "recording. Appears in two visual variants (outline for stale, " +
          "ghost for differs) but identical text both times.",
      },
      "workspace.transcriptPreview.replaceTextTooltip": {
        description:
          "Tooltip on the adopt-transcript button when the cell already has " +
          "text that would be overwritten by what the recording says.",
      },
      "workspace.transcriptPreview.fillTextTooltip": {
        description:
          "Tooltip on the adopt-transcript button when the cell has no text " +
          "yet, so adopting the transcript fills it in rather than replacing anything.",
      },
      "workspace.transcriptPreview.useWhatWasHeard": {
        description:
          "Button label that adopts the recording's transcript as the cell's " +
          "text, shown when the cell already has different text.",
      },
      "workspace.transcriptPreview.useAsText": {
        description:
          "Button label that adopts the recording's transcript as the cell's " +
          "text, shown when the cell has no text yet.",
      },

      "workspace.errorBoundary.reload": {
        description:
          "Button on the React error-boundary fallback screen (both the " +
          "generic-crash and the app-updated/chunk-load-failure variants) " +
          "that reloads the page.",
      },

      "workspace.generateOverwrite.dontAskAgain": {
        description:
          "Checkbox label in the confirm dialog shown before an AI draft " +
          "overwrites existing human-authored cell text, offered only for " +
          "non-validated cells (replacing a validated cell always confirms).",
      },

      "workspace.helpMenu.homepage": {
        description:
          "Menu item in the Help dropdown linking out to the public marketing " +
          "homepage in a new tab.",
      },

      "workspace.inactiveBanner.ariaLabel": {
        description:
          "Accessible label (role=status) for the full-width banner shown " +
          "atop a frozen/inactive project, announced once by a screen reader " +
          "when it appears.",
      },
      "workspace.inactiveBanner.message": {
        description:
          "Body sentence of the inactive-project banner. {name} is the " +
          "project's own name, rendered in bold ahead of this text.",
        placeholders: { name: "The inactive project's display name, rendered as bold markup." },
      },

      "workspace.alignment.confirmedBadge": {
        description:
          "Small badge replacing the confirm/reject buttons on one word-" +
          "alignment row once it has been confirmed correct. Keep the " +
          "leading checkmark glyph (✓).",
        maxLength: 16,
      },
      "workspace.alignment.rejectedBadge": {
        description:
          "Small badge replacing the confirm/reject buttons on one word-" +
          "alignment row once it has been rejected as incorrect. Keep the " +
          "leading cross glyph (✗).",
        maxLength: 16,
      },
      "workspace.alignment.helpTooltipShort": {
        description:
          "Tooltip on the help icon beside the Alignment section heading " +
          "(editor.bt.alignment) in its 'insufficient data' empty state, " +
          "explaining what the feature does once enough data exists.",
      },
      "workspace.alignment.insufficientData": {
        description:
          "Empty-state body text shown instead of word-alignment links when " +
          "the project hasn't translated enough sentences yet for meaningful " +
          "alignment.",
      },
      "workspace.alignment.helpTooltipFull": {
        description:
          "Tooltip on the help icon beside the Alignment section heading " +
          "(editor.bt.alignment) once real links are showing, explaining the " +
          "confirm/reject controls and the confidence threshold.",
      },
      "workspace.alignment.needsConfirmation": {
        description:
          "Collapsed-disclosure summary revealing lower-confidence ('amber "  +
          "band') alignment links that need manual confirmation before they " +
          "count toward training. {count} is how many such links exist; the " +
          "count sits in parentheses and does not change the surrounding words.",
        placeholders: { count: "How many amber-band links are waiting for confirmation." },
      },
      "workspace.alignment.confirmTooltip": {
        description:
          "Tooltip on the checkmark button beside one word-alignment link, explaining " +
          "what confirming it does before the click.",
        placeholders: {
          srcToken: "The source-language word/token — not translated.",
          tgtToken: "The target-language word/token (the translator's own text) — not translated.",
        },
      },
      "workspace.alignment.confirmAriaLabel": {
        description:
          "Accessible name for the same checkmark confirm button as " +
          "workspace.alignment.confirmTooltip — read by a screen reader in place of the " +
          "icon-only button.",
        placeholders: {
          srcToken: "The source-language word/token — not translated.",
          tgtToken: "The target-language word/token (the translator's own text) — not translated.",
        },
      },
      "workspace.alignment.rejectTooltip": {
        description:
          "Tooltip on the X button beside one word-alignment link, explaining what " +
          "rejecting it does before the click.",
        placeholders: {
          srcToken: "The source-language word/token — not translated.",
          tgtToken: "The target-language word/token (the translator's own text) — not translated.",
        },
      },
      "workspace.alignment.rejectAriaLabel": {
        description:
          "Accessible name for the same X reject button as workspace.alignment." +
          "rejectTooltip — read by a screen reader in place of the icon-only button.",
        placeholders: {
          srcToken: "The source-language word/token — not translated.",
          tgtToken: "The target-language word/token (the translator's own text) — not translated.",
        },
      },
      "workspace.alignment.contributorRequired": {
        description:
          "AQU-1408. Tooltip and accessible name on the disabled confirm/reject " +
          "buttons for a member below the contributor rung, who may read the " +
          "alignment but not teach it. Mirror editor.bt.contributorRequired; keep " +
          "the 'or above' sense of the trailing plus.",
      },
      "workspace.alignment.originalHeading": {
        description:
          "Heading of the section listing the original-language (biblical Hebrew or " +
          "Greek) words of the verse being translated, above the statistical " +
          "alignment links. 'Original language' means the language the scripture " +
          "was written in, not the project's source text.",
        maxLength: 24,
      },
      "workspace.alignment.originalSub": {
        description:
          "Muted continuation of workspace.alignment.originalHeading, on the same " +
          "line. The leading dash joins it to the heading; do not start with a " +
          "capital. 'Greek/Hebrew' names the two biblical languages.",
      },
      "workspace.alignment.originalHelpTooltip": {
        description:
          "Tooltip on the help icon beside that heading. 'Dictionary form' is the " +
          "lemma — the headword an inflected form is listed under; \"Strong's " +
          "number\" is a standard scripture-word index and stays as-is.",
      },
      "workspace.alignment.originalNoMatch": {
        description:
          "Shown in place of a target word when the model cannot say which part of " +
          "the translation renders this original-language word. Lowercase, muted; " +
          "it is a status, not a heading.",
        maxLength: 24,
      },
      "workspace.alignment.originalViaLemma": {
        description:
          "Small badge on a row whose target word was found through the word's " +
          "dictionary form (lemma) rather than the exact form in this verse — a " +
          "weaker match. Lowercase, very short.",
        maxLength: 14,
      },
      "workspace.alignment.originalViaLemmaTooltip": {
        description:
          "Tooltip on that badge, explaining why the match is weaker.",
        placeholders: {
          lemma: "The dictionary form of the original-language word — not translated.",
        },
      },

      "workspace.offlineBanner.message": {
        description:
          "Full-width banner shown whenever the browser reports no network " +
          "connectivity, reassuring the user their edits are queued and will " +
          "sync automatically once they reconnect. Clears itself; no dismiss control.",
      },

      "workspace.assignedToMe.heading": {
        description:
          "Collapsible section heading in the workspace sidebar listing the " +
          "signed-in user's own open work assignments within this project.",
        screenshot: "workspace-nav",
      },
      "workspace.assignedToMe.jumpToTooltip": {
        description:
          "Tooltip on one assignment row in the 'My assignments' sidebar list, when the " +
          "assignment carries no note. Clicking the row jumps the editor to that scope.",
        placeholders: { scope: "The assignment's scope label (e.g. a book/chapter range) — not translated." },
      },
      "workspace.assignedToMe.jumpToWithNoteTooltip": {
        description:
          "Same as workspace.assignedToMe.jumpToTooltip, with the assignment's note " +
          "appended after a colon when one was left for this assignment.",
        placeholders: {
          scope: "The assignment's scope label (e.g. a book/chapter range) — not translated.",
          note: "Free-text note left on the assignment — not translated.",
        },
      },
      "workspace.peerPresence.onlineCount": {
        description:
          "Accessible name for the live-collaborators popover, stating how many peers are " +
          "currently viewing/editing this project. English text is invariant across " +
          "count, but the plural form still lets other locales inflect it correctly.",
        placeholders: { count: "How many peers are currently online on this project." },
      },
      "workspace.peerPresence.collaboratorsOnlineTooltip": {
        description:
          "Tooltip on the collapsed avatar-stack trigger button, before the popover " +
          "opens, stating how many collaborators are currently online.",
        placeholders: { count: "How many peers are currently online on this project." },
      },
      "workspace.assignedToMe.cellsProgress": {
        description:
          "Progress fraction under one assignment row, stating how many of " +
          "its cells are done. {done} and {total} are the raw numerator/" +
          "denominator, already placed either side of the slash by the " +
          "template — do not add your own slash.",
        placeholders: {
          done: "Number of cells completed in this assignment.",
          total: "Total number of cells in this assignment; governs the plural form.",
        },
        screenshot: "workspace-nav",
      },

      "workspace.projectCard.inactiveTooltip": {
        description:
          "Tooltip on a project card's 'Inactive' badge (org.projectOverview." +
          "inactiveBadge), explaining that a frozen project can't be edited " +
          "until it's reactivated.",
      },
      "workspace.projectCard.yourRoleTooltip": {
        description:
          "Tooltip on a project card's role badge, naming what the badge " +
          "shows: the signed-in user's own role on that project.",
      },
      "workspace.projectCard.moveToTrash": {
        description:
          "Destructive overflow-menu item on a project card that soft-" +
          "deletes the whole project (distinct from moving a single FILE to " +
          "trash inside a project).",
      },
      "workspace.projectCard.awaitingSetup": {
        description:
          "Italic status line on a project card whose source/target " +
          "languages aren't set yet, but the project exists server-side with " +
          "no known maintainer to attribute it to.",
      },
      "workspace.projectCard.awaitingSetupBy": {
        description:
          "Same status line as workspace.projectCard.awaitingSetup, when a " +
          "maintainer IS known. {maintainer} is that person's display name.",
        placeholders: { maintainer: "Display name of the project's maintainer." },
      },
      "workspace.projectCard.languagesNotSet": {
        description:
          "Italic status line on a project card whose source/target " +
          "languages aren't set and which has no server-side existence at " +
          "all yet (purely local).",
      },

      "workspace.sourceSelection.viewTerm": {
        description:
          "Button in the floating toolbar above a selected span of SOURCE " +
          "text, shown only when the selection matches a known glossary " +
          "concept — opens a lookup popover.",
        maxLength: 16,
      },
      "workspace.sourceSelection.askAi": {
        description:
          "Button in the same floating source-selection toolbar that pushes " +
          "the selection into the AI agent chat as a reference chip.",
        maxLength: 16,
      },
      "workspace.sourceSelection.addToTermbase": {
        description:
          "Button in the same floating source-selection toolbar that starts " +
          "adding the selected text as a new terminology entry.",
        maxLength: 24,
      },

      "workspace.statusBar.summary": {
        description:
          "Main status line in the bottom footer bar, reporting overall " +
          "translation progress for the open file. All three values arrive " +
          "already formatted and bidi-isolated by the caller — place them " +
          "wherever your language's word order needs them, but do not " +
          "reformat the numbers or percent sign yourself.",
        placeholders: {
          total: "Already-formatted total cell count.",
          translated: "Already-formatted translated cell count.",
          pct: "Already-formatted percentage in parentheses, e.g. '(42%)'.",
        },
        screenshot: "workspace-nav",
      },
      "workspace.statusBar.unvalidatedBadge": {
        description:
          "Small badge in the status footer counting cells not yet " +
          "validated. {count} is a plain number, not itself bidi-isolated.",
        placeholders: { count: "How many cells are unvalidated." },
        screenshot: "workspace-nav",
      },

      "workspace.updateBanner.updateAvailable": {
        description:
          "Floating pill shown when a new build of the app has been " +
          "deployed; clicking it reloads the page to pick it up.",
        maxLength: 24,
      },
      "workspace.legacyMeasure.partialSuccessToast": {
        description:
          "Warning toast after the 'Measure all' legacy-takes fix-it batch finishes with " +
          "at least one failure. Plural agrees with {measured}, the count that " +
          "successfully got a captured duration; {failed} is reported as a plain number " +
          "regardless of its own count.",
        placeholders: {
          measured: "How many recordings were successfully measured; also selects the plural form.",
          failed: "How many recordings could not be measured.",
        },
      },
      "workspace.legacyMeasure.successToast": {
        description:
          "Success toast after the 'Measure all' legacy-takes fix-it batch finishes with " +
          "zero failures.",
        placeholders: { measured: "How many recordings were successfully measured; also selects the plural form." },
      },
      "workspace.skeleton.loadingProject": {
        description:
          "Accessible label for the full-page loading skeleton shown while a " +
          "project's workspace is being fetched, before any real content " +
          "exists. Also rendered as visible text with an appended ellipsis " +
          "by the LoadingOverlay component — supply just the words here.",
      },

      "workspace.denoise.removedTooltip": {
        description:
          "Tooltip on the 'Noise removed' badge shown once on-device noise " +
          "reduction has produced a cleaned recording take.",
      },
      "workspace.denoise.removedBadge": {
        description: "Badge confirming a cleaned take is currently selected, next to a checkmark icon.",
      },
      "workspace.denoise.revertTooltip": {
        description:
          "Tooltip on the Revert button beside the 'Noise removed' badge, " +
          "explaining it switches back to the original, un-cleaned recording.",
      },
      "workspace.denoise.revertButton": {
        description: "Button that re-selects the original recording take instead of the denoised one.",
      },

      "workspace.chatComposer.queueTooltip": {
        description:
          "Tooltip on the queue button shown while a run is streaming (only " +
          "when queuing is supported), explaining it holds the message for " +
          "after the current run finishes.",
      },
      "workspace.chatComposer.queueMessage": {
        description:
          "Accessible name for the queue button in the chat composer, shown " +
          "instead of Send while a run is streaming.",
      },

      "workspace.chatMarkdown.copyCode": {
        description:
          "Tooltip and accessible name for the small copy button that " +
          "appears on hover over a fenced code block in an assistant chat message.",
      },

      "workspace.orgStep.emailsPlaceholder": {
        description:
          "Placeholder inside the empty multi-email invite field on the " +
          "organization-creation onboarding step, illustrating comma-" +
          "separated input with two example addresses. Adapt the example " +
          "names if useful, but keep it two comma-separated email-shaped examples.",
      },

      "workspace.linkVideoTiming.title": {
        description:
          "Heading of the warning dialog shown when linking a video to a " +
          "file that's currently in Free timing (the video won't display " +
          "until the mode changes).",
        screenshot: "confirm-dialog",
      },
      "workspace.linkVideoTiming.description": {
        description: "Body copy of the same dialog, explaining why the video would stay hidden and how to fix it.",
        screenshot: "confirm-dialog",
      },
      "workspace.linkVideoTiming.linkAnyway": {
        description: "Confirm button that links the video despite the Free-timing warning.",
      },

      "workspace.timingModeChanged.title": {
        description:
          "Heading of the purely-informational heads-up dialog shown when " +
          "another user's settings change already re-flowed this file's " +
          "timeline — the change is already applied, this just explains it.",
        screenshot: "confirm-dialog",
      },
      "workspace.timingModeChanged.description": {
        description:
          "Body of the timing-mode-changed heads-up dialog. {from} and {to} " +
          "are the old and new timing mode names, both rendered in bold.",
        placeholders: {
          from: "The file's previous timing mode name, rendered as bold markup.",
          to: "The file's new timing mode name, rendered as bold markup.",
        },
        screenshot: "confirm-dialog",
      },

      "workspace.timingVideoWarning.title": {
        description: "Heading of the confirm dialog shown before switching a file with a linked video to Free timing.",
        screenshot: "confirm-dialog",
      },
      "workspace.timingVideoWarning.description": {
        description: "Body copy of the same dialog, explaining the consequence and that switching is lossless.",
        screenshot: "confirm-dialog",
      },
      "workspace.timingVideoWarning.confirmButton": {
        description:
          "Confirm button proceeding with the switch to Free timing. Keep " +
          "the English wording an e2e/browser-pass guard matches this exact " +
          "button name verbatim in the default locale; translate normally " +
          "for other locales.",
        screenshot: "confirm-dialog",
      },

      "workspace.timelineCard.camLabel": {
        description:
          "Tiny inline badge on a dialogue timeline card showing whether the " +
          "camera is on this character (on/off). {state} is the raw enum " +
          "value ('on'/'off'), not itself translated — 'cam' is the fixed " +
          "abbreviation label.",
        placeholders: { state: "The raw camera-state value ('on' or 'off')." },
        maxLength: 12,
      },

      "workspace.chipStrip.selectClipPrompt": {
        description:
          "Empty-state prompt in the per-chip stats strip under the " +
          "timeline lanes, shown when no clip is selected/playing/touched.",
      },
      "workspace.chipStrip.sourceLabel": {
        description:
          "Short label prefix before a source-side duration or time-range " +
          "reading in the chip stats strip. Trailing colon is part of the label.",
        maxLength: 10,
      },
      "workspace.chipStrip.targetLabel": {
        description:
          "Short label prefix before a target-side duration or time-range " +
          "reading in the chip stats strip, sibling of workspace.chipStrip.sourceLabel.",
        maxLength: 10,
      },
      "workspace.chipStrip.diffLabel": {
        description:
          "Short label prefix before the source-minus-target duration " +
          "difference pill in the chip stats strip.",
        maxLength: 10,
      },
      "workspace.chipStrip.startOverlapTooltip": {
        description:
          "Native title tooltip on the 'Start overlap' pill, explaining this " +
          "clip's target audio overlaps the PREVIOUS verse's target audio.",
      },
      "workspace.chipStrip.startOverlapValue": {
        description:
          "Value text of the 'Start overlap' pill — always a negative " +
          "duration, so the minus sign is fixed in the template, not part of " +
          "{sec}. {sec} is an already-formatted one-decimal number.",
        placeholders: { sec: "Already-formatted one-decimal overlap magnitude, e.g. '0.7'." },
      },
      "workspace.chipStrip.endOverlapTooltip": {
        description:
          "Native title tooltip on the 'End overlap' pill, explaining this " +
          "clip's target audio overlaps the NEXT verse's target audio.",
      },
      "workspace.chipStrip.endOverlapValue": {
        description:
          "Value text of the 'End overlap' pill, sibling of workspace." +
          "chipStrip.startOverlapValue for the trailing (next-verse) side.",
        placeholders: { sec: "Already-formatted one-decimal overlap magnitude, e.g. '1.1'." },
      },
      "workspace.chipStrip.eitherOverlapTooltip": {
        description:
          "Native title tooltip on the single combined 'Overlap' pill, shown " +
          "when only one side (start OR end, not both) overlaps a neighbour.",
      },
      "workspace.chipStrip.overlapValue": {
        description:
          "Value text of the single combined 'Overlap' pill. {sec} is an " +
          "already-formatted one-decimal magnitude; the minus sign is fixed " +
          "in the template.",
        placeholders: { sec: "Already-formatted one-decimal overlap magnitude, e.g. '1.8'." },
      },
      "workspace.chipStrip.speakerLabel": {
        description:
          "Short label prefix before the speaking cast member's name in the " +
          "chip stats strip (sibling pill to importExport.labels." +
          "previewCameraHeader's 'Camera' pill, which reuses that key).",
        maxLength: 10,
      },
      "workspace.chipStrip.durationDiffTooltip": {
        description:
          "Tooltip on the 'Diff:' pill (workspace.chipStrip.diffLabel) in the chip stats " +
          "strip, naming what the diff figure measures, for a dub with no per-edge detail " +
          "to add. 'Source duration' and 'target duration' here are generic nouns, not the " +
          "same as workspace.chipStrip.sourceLabel/targetLabel's colon-suffixed pill labels.",
      },
      "workspace.chipStrip.durationDiffTooltipWithDetail": {
        description:
          "Same as workspace.chipStrip.durationDiffTooltip, with a start/end breakdown " +
          "appended after the header. {detail} is one or both of workspace.chipStrip." +
          "diffStartDetail/diffEndDetail, already translated and joined with ' · ' — do " +
          "not translate it again.",
        placeholders: {
          detail: "One or both already-translated 'Start: …'/'End: …' fragments, joined with ' · '.",
        },
      },
      "workspace.chipStrip.diffStartDetail": {
        description:
          "One fragment inside workspace.chipStrip.durationDiffTooltipWithDetail's " +
          "{detail}, naming the duration difference at the clip's start edge specifically.",
        placeholders: { value: "Already-formatted signed seconds (e.g. '+0.3s') — not translated." },
      },
      "workspace.chipStrip.diffEndDetail": {
        description:
          "Same as workspace.chipStrip.diffStartDetail, for the clip's end edge.",
        placeholders: { value: "Already-formatted signed seconds (e.g. '+0.3s') — not translated." },
      },

      "workspace.targetAudioLane.previewTooLong": {
        description:
          "Toast when the chip's play button is pressed on a take too long to " +
          "decode for preview. It points at the timeline, which streams and can " +
          "play it.",
      },
      "workspace.targetAudioLane.previewTooLarge": {
        description:
          "Toast when the play button is pressed on a take whose LENGTH was " +
          "never recorded and whose file is over the preview size ceiling. " +
          "Distinct from 'too long' because it has a cure: measuring the take. " +
          "Before this the button simply made no sound and said nothing.",
      },
      "workspace.targetAudioLane.previewTooLargeDetail": {
        description:
          "Body for the above, naming the fix. 'Measure all' is the file-menu " +
          "action that backfills missing durations.",
      },
      "workspace.targetAudioLane.previewUnavailable": {
        description:
          "Toast when the play button cannot reach a take's audio at all — a " +
          "legacy attachment whose bytes are gone, or no audio device.",
      },
      "workspace.targetAudioLane.overlapsNext": {
        description:
          "Tooltip line on a target-audio (dub) chip whose tail overlaps the " +
          "NEXT verse's dub — both will sound at once. Preceded on the same " +
          "line by an already-formatted negative-seconds value.",
      },
      "workspace.targetAudioLane.overlapsPrevious": {
        description:
          "Tooltip line on a target-audio (dub) chip whose head overlaps the " +
          "PREVIOUS verse's dub, mirroring workspace.targetAudioLane.overlapsNext.",
      },
      "workspace.targetAudioLane.playClip": {
        description:
          "Hover and screen-reader name of the small play button in the top-" +
          "left corner of an audio clip in the timeline, opposite the record " +
          "button. It plays only that one clip, trimmed exactly as the " +
          "timeline draws it, without moving the playhead or starting the " +
          "rest of the timeline.",
      },
      "workspace.targetAudioLane.takeValidated": {
        description:
          "Tooltip on the small tick in the corner of a timeline clip whose "
          + "recording has reached the number of validators the project asks "
          + "for. Read-only — the vote itself is cast in the editor, the "
          + "recorder or the Recording tab, which have room for it.",
        maxLength: 30,
      },
      "workspace.targetAudioLane.takeValidatedByYou": {
        description:
          "Tooltip on the small tick in the corner of a timeline clip that YOU "
          + "have validated, on a project that asks for more validators than "
          + "just you. A single tick rather than a double one, matching the "
          + "editor's margin: your part is done, the line is not.",
        maxLength: 30,
      },
      "workspace.targetAudioLane.recordAudio": {
        description:
          "Tooltip/accessible name for the small record-button affordance on " +
          "the target-audio timeline lane — both the corner mic button on an " +
          "existing chip and the button that fills an empty (undubbed) slot.",
      },
      "workspace.targetAudioLane.runsPastSectionTooltip": {
        description:
          "Tooltip line on a dub chip that runs slightly past its section's boundary — " +
          "a soft overflow, not a hard overlap with a neighbor.",
        placeholders: { sec: "Overflow duration in seconds, one decimal place, as a plain number." },
      },
      "workspace.targetAudioLane.drawnShortNeighboringDubsStay": {
        description:
          "Tooltip line on a dub chip drawn shorter than its actual recording so both " +
          "the previous AND next neighboring dubs stay reachable at rest (both edges cut). " +
          "One of three near-identical variants (see the sibling " +
          "drawnShortPreviousDubStays/drawnShortNextDubStays keys) picked by which edge(s) " +
          "were cut — keep the three grammatically parallel if you change the wording.",
      },
      "workspace.targetAudioLane.drawnShortPreviousDubStays": {
        description:
          "Same shape as workspace.targetAudioLane.drawnShortNeighboringDubsStay, for the " +
          "case where only the chip's head (start) was cut, so the previous dub stays " +
          "reachable.",
      },
      "workspace.targetAudioLane.drawnShortNextDubStays": {
        description:
          "Same shape as workspace.targetAudioLane.drawnShortNeighboringDubsStay, for the " +
          "case where only the chip's tail (end) was cut, so the next dub stays reachable.",
      },

      "workspace.dataTable.noResults": {
        description:
          "Generic empty-state row shown by the shared DataTable primitive " +
          "when its current filter/search matches no rows. Used across many " +
          "admin and settings tables app-wide.",
      },

      "workspace.castGutterVoice.applyToAllLines": {
        description:
          "Checkbox label in the footer of the per-line character-voice " +
          "picker popover, offering to apply the pick to every line spoken " +
          "by the same character. {name} is the character/speaker name, " +
          "wrapped in guillemets by the template — keep some form of visual " +
          "quoting around it.",
        placeholders: { name: "The diarized/VTT speaker (character) name." },
      },

      "workspace.openWorkspace.openingProject": {
        description:
          "Accessible label on the full-viewport blocking overlay shown " +
          "while navigating into a project workspace (a lazy-loaded route), " +
          "so the click doesn't read as unresponsive.",
      },

      "workspace.fileSort.lastUpdated": {
        description:
          "One option in the per-file breakdown's sort-mode dropdown (ProjectOverview) " +
          "— sorts most-recently-progressed files first. Default mode.",
      },
      "workspace.fileSort.canonical": {
        description:
          "Sort-mode dropdown option: orders files by Bible reading order " +
          "(Genesis → Revelation) rather than recency or name.",
      },
      "workspace.fileSort.alphabetical": {
        description: "Sort-mode dropdown option: plain A-Z name order.",
      },
    },
  },
  surfaces: [],
})
