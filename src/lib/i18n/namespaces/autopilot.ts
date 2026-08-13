/**
 * `autopilot.*` — project-wide contextual drafting and its evidence surfaces.
 *
 * Autopilot crosses the project overview, the editor's floating run controls,
 * inline draft review, project settings, and the durable activity inspector.
 * Keeping those strings together lets one translator preserve the product's
 * trust vocabulary (run, pause, review, evidence, and recovery) end to end.
 */

import { defineNamespace, plural } from "./types"

function withPlaceholders(
  description: string,
  placeholders: Record<string, string>,
) {
  return { description, placeholders }
}

export const autopilot = defineNamespace({
  keys: {
    // — Shared names, actions, states, progress, and time ————————————
    "autopilot.name": "Autopilot",
    "autopilot.action.run": "Run Autopilot",
    "autopilot.action.resume": "Resume",
    "autopilot.action.viewActivity": "View activity",
    "autopilot.status.needsAttention": "Needs attention",
    "autopilot.status.working": "Working",
    "autopilot.status.paused": "Paused",
    "autopilot.status.queued": "Queued",
    "autopilot.status.idle": "Idle",
    "autopilot.status.readyForReview": "Ready for review",
    "autopilot.status.complete": "Complete",
    "autopilot.status.stopped": "Stopped",
    "autopilot.status.notStarted": "Not started",
    "autopilot.feedback.starting": "Starting Autopilot…",
    "autopilot.feedback.stopped": "Autopilot stopped.",
    "autopilot.feedback.pauseRequested": "Pause requested.",
    "autopilot.feedback.resumed": "Autopilot resumed.",
    "autopilot.feedback.newRunStarted": "A new Autopilot run started for this file.",
    "autopilot.error.startFailed": "Autopilot could not start.",
    "autopilot.error.authRequired": "You need to be signed in to use contextual drafting.",
    "autopilot.progress.passagesComplete": plural(
      {
        one: "{done} of {total} passage complete",
        other: "{done} of {total} passages complete",
      },
      "total",
    ),
    "autopilot.time.notRecorded": "Not recorded",
    "autopilot.time.checkedNever": "Not checked yet",
    "autopilot.time.checkedAt": "Checked {time}",
    "autopilot.lane.projectDefault": "Project default",
    "autopilot.phase.reading": "Reading context…",
    "autopilot.phase.drafting": "Drafting…",
    "autopilot.phase.checking": "Checking…",
    "autopilot.phase.staging": "Saving drafts…",

    // — Discovery setting ———————————————————————————————————————————
    "autopilot.settings.experimentalTitle": "Experimental",
    "autopilot.settings.experimentalDescription":
      "Early features still in development. These switches stay on this device — they are not shared with collaborators.",
    "autopilot.settings.controlsLabel": "Show Autopilot controls",
    "autopilot.settings.controlsDescription":
      "Shows Autopilot controls on this device. Turning this on does not start work, and hiding the controls does not stop a run. Choose Run Autopilot when you are ready; suggestions stay in review until you accept them.",

    // — Compact project overview ————————————————————————————————————
    "autopilot.overview.loadFailed":
      "Autopilot status couldn’t be loaded. Try again before starting new work.",
    "autopilot.overview.attentionIssues": plural({
      one: "{count} issue needs attention. Open activity to see what happened.",
      other: "{count} issues need attention. Open activity to see what happened.",
    }),
    "autopilot.overview.startFailedHelp":
      "Autopilot could not start. Check the message below, then try again.",
    "autopilot.overview.startingScan": "Scanning project files and starting work…",
    "autopilot.overview.workingScanningFiles": plural(
      {
        one: "Working across {fileCount} file — scanning passages and starting the next steps…",
        other: "Working across {fileCount} files — scanning passages and starting the next steps…",
      },
      "fileCount",
    ),
    "autopilot.overview.workingProgress": plural(
      {
        one: "Working across {fileCount} file — {progress}",
        other: "Working across {fileCount} files — {progress}",
      },
      "fileCount",
    ),
    "autopilot.overview.passagesProgress": plural(
      {
        one: "{done} of {total} passage complete across the project’s latest runs.",
        other: "{done} of {total} passages complete across the project’s latest runs.",
      },
      "total",
    ),
    "autopilot.overview.scanningPassages": "Scanning passages and starting the next steps…",
    "autopilot.overview.pausedProgress": plural(
      {
        one: "Autopilot is paused at {done} of {total} passage.",
        other: "Autopilot is paused at {done} of {total} passages.",
      },
      "total",
    ),
    "autopilot.overview.paused": "Autopilot is paused.",
    "autopilot.overview.queuedPassages": plural({
      one: "{count} passage is queued. Autopilot will continue in the background.",
      other: "{count} passages are queued. Autopilot will continue in the background.",
    }),
    "autopilot.overview.idle": "Current runs are idle. No more work is queued.",
    "autopilot.overview.reviewDrafts": plural({
      one: "{count} draft is ready for review.",
      other: "{count} drafts are ready for review.",
    }),
    "autopilot.overview.complete": "Autopilot completed its latest run.",
    "autopilot.overview.stopped": "The latest Autopilot run was stopped.",
    "autopilot.overview.notStarted": "Ready to run — Autopilot hasn’t run on this project yet.",
    "autopilot.overview.widget.reviewLabel": "Ready to review",
    "autopilot.overview.widget.reviewAria": plural({
      one: "View {count} ready to review",
      other: "View {count} ready to review",
    }),
    "autopilot.overview.widget.attentionAria": plural({
      one: "View {count} needs attention",
      other: "View {count} needs attention",
    }),
    "autopilot.overview.widget.contextLabel": "Context suggestions",
    "autopilot.overview.widget.contextAria": plural({
      one: "View {count} context suggestion",
      other: "View {count} context suggestions",
    }),
    "autopilot.overview.refreshFailedAt":
      "Refresh failed. Showing the snapshot checked at {time}.",
    "autopilot.overview.refreshFailedInitial": "Autopilot status could not be loaded.",
    "autopilot.overview.startResult.startedFiles": plural({
      one: "{count} file started",
      other: "{count} files started",
    }),
    "autopilot.overview.startResult.noneStarted": "No files started",
    "autopilot.overview.startResult.skippedFiles": plural({
      one: "{count} file skipped",
      other: "{count} files skipped",
    }),
    "autopilot.overview.startResult.deferredFiles": plural({
      one: "{count} file deferred to the next batch",
      other: "{count} files deferred to the next batch",
    }),
    "autopilot.overview.startResult.alreadyRunning": plural({
      one: "{count} file is already running",
      other: "{count} files are already running",
    }),
    "autopilot.overview.startResult.queuedWork": plural({
      one: "{count} file still has queued work",
      other: "{count} files still have queued work",
    }),
    "autopilot.overview.startResult.paused": plural({
      one: "{count} file is paused",
      other: "{count} files are paused",
    }),
    "autopilot.overview.startResult.pausePending": plural({
      one: "{count} file is finishing a pause",
      other: "{count} files are finishing a pause",
    }),
    "autopilot.overview.startResult.idleOwner": plural({
      one: "{count} file has an idle run; review its drafts or stop it before rerunning",
      other: "{count} files have idle runs; review their drafts or stop them before rerunning",
    }),
    "autopilot.overview.startResult.startFailed": plural({
      one: "{count} file couldn’t start; open activity for details",
      other: "{count} files couldn’t start; open activity for details",
    }),
    "autopilot.overview.startResult.unavailable": plural({
      one: "{count} file couldn’t start right now",
      other: "{count} files couldn’t start right now",
    }),
    "autopilot.overview.startResult.outcome": "{items}.",
    "autopilot.overview.startResult.deferredHelp":
      "Run Autopilot again after this batch becomes idle to start the waiting files.",
    "autopilot.overview.startResult.reviewGuarantee":
      "Draft suggestions stay in review until a person accepts them.",

    // — Editor run pill —————————————————————————————————————————————
    "autopilot.pill.suggestionsWaiting": "Suggestions waiting in your cells",
    "autopilot.pill.suggestionsReady": plural({
      one: "{count} suggestion ready to review",
      other: "{count} suggestions ready to review",
    }),
    "autopilot.pill.activePassages": plural({
      one: "{count} passage",
      other: "{count} passages",
    }),
    "autopilot.pill.starting": "Starting…",
    "autopilot.pill.finishingPassage": "Finishing this passage…",
    "autopilot.pill.resumeDrafting": "Resume drafting",
    "autopilot.pill.stopRun": "Stop this run",
    "autopilot.pill.failedPassages": plural(
      {
        one: "{failed} of {total} passage had problems",
        other: "{failed} of {total} passages had problems",
      },
      "total",
    ),
    "autopilot.pill.unexpectedStop": "Drafting stopped unexpectedly",
    "autopilot.pill.pauseAfterPassage": "Pause after this passage",
    "autopilot.pill.startFailed": "Autopilot couldn’t start. Try again or check AI setup.",
    "autopilot.pill.viewActivity": "View Autopilot activity",
    "autopilot.pill.announcement.starting": "Autopilot is starting.",
    "autopilot.pill.announcement.pausing":
      "Autopilot will pause after the current passage.",
    "autopilot.pill.announcement.paused": "Autopilot paused.",
    "autopilot.pill.announcement.queued": plural({
      one: "Autopilot has {count} passage queued and will continue in the background.",
      other: "Autopilot has {count} passages queued and will continue in the background.",
    }),
    "autopilot.pill.announcement.idle": "Autopilot is idle. No work is queued.",
    "autopilot.pill.announcement.complete": "Autopilot completed.",
    "autopilot.pill.announcement.problem": "Autopilot stopped after a problem.",
    "autopilot.pill.announcement.working": "Autopilot is working.",
    "autopilot.pill.queuedRemaining": plural({
      one: "Queued · {count} passage remaining",
      other: "Queued · {count} passages remaining",
    }),
    "autopilot.pill.idle": "Idle · no work queued",
    "autopilot.pill.completeWithAttention":
      "{done}/{total} complete · {failed} need attention",
    "autopilot.pill.announcement.completeWithAttention":
      "Autopilot finished {done} of {total} passages. {failed} still need attention.",

    // — Inline proposal review ——————————————————————————————————————
    "autopilot.draft.draftedFrom": "Drafted from {spanLabel}",
    "autopilot.draft.draftedForYou": "Drafted for you",
    "autopilot.draft.suggested": "Suggested",
    "autopilot.draft.useTranslation": "Use this translation",
    "autopilot.draft.dismissSuggestion": "Dismiss this suggestion",
    "autopilot.draft.dismissFailed": "This suggestion couldn’t be dismissed. Retry.",

    // — Steering popover ————————————————————————————————————————————
    "autopilot.steering.direct": "Direct the run",
    "autopilot.steering.appliesNext":
      "Directions apply to the next passage the agent drafts.",
    "autopilot.steering.directionLabel": "Direction for the agent",
    "autopilot.steering.placeholder": "e.g. Keep the tone formal in dialogue",
    "autopilot.steering.sendFailed": "That direction didn't reach the agent. Try again.",
    "autopilot.steering.sending": "Sending direction…",
    "autopilot.steering.send": "Send",
    "autopilot.steering.queuedDirections": plural({
      one: "{count} direction queued",
      other: "{count} directions queued",
    }),

    // — Durable activity inspector: shell and run list —————————————
    "autopilot.inspector.title": "Autopilot activity",
    "autopilot.inspector.description":
      "See what Autopilot did, what it is doing now, and the evidence behind each step.",
    "autopilot.inspector.runsRegion": "Autopilot runs",
    "autopilot.inspector.runsHeading": "Runs",
    "autopilot.inspector.projectReviewCount": plural({
      one: "{count} draft is ready across this project. Runs with review work are marked below; select one to inspect its drafts.",
      other: "{count} drafts are ready across this project. Runs with review work are marked below; select one to inspect their drafts.",
    }),
    "autopilot.inspector.noRuns": "No Autopilot runs have been recorded yet.",
    "autopilot.inspector.scanningPassages": "Scanning passages",
    "autopilot.inspector.targetLanguage": "Target: {language}",
    "autopilot.inspector.defaultLane": "Default language lane",
    "autopilot.inspector.readyCount": plural({
      one: "{count} ready to review",
      other: "{count} ready to review",
    }),
    "autopilot.inspector.loadOlderRuns": "Load older runs",
    "autopilot.inspector.recentRunsOnly":
      "Showing the most recent runs. Older run history is not included in this view.",
    "autopilot.inspector.count.visibleOfTotal": "{visible} of {total}",

    // — Inspector: selected run and controls ———————————————————————
    "autopilot.inspector.run.working": "Autopilot is working through this file.",
    "autopilot.inspector.run.pausing": "Finishing the current step before pausing.",
    "autopilot.inspector.run.paused": "Paused. No new work will start until you resume.",
    "autopilot.inspector.run.queued": plural({
      one: "{count} passage remains queued. Autopilot will continue in the background.",
      other: "{count} passages remain queued. Autopilot will continue in the background.",
    }),
    "autopilot.inspector.run.idle": "This run is idle; no more work is queued.",
    "autopilot.inspector.run.done": "This run finished.",
    "autopilot.inspector.run.stopped": "This run was stopped.",
    "autopilot.inspector.run.failed": "This run stopped before it could finish.",
    "autopilot.inspector.run.passagesComplete": "Passages complete",
    "autopilot.inspector.run.lane": "Language: {language}",
    "autopilot.inspector.run.updatedAt": "Updated {time}",
    "autopilot.inspector.run.calls": plural({
      one: "{count} call",
      other: "{count} calls",
    }),
    "autopilot.inspector.run.units": plural({
      one: "{count} unit",
      other: "{count} units",
    }),
    "autopilot.inspector.run.failedPassages": plural({
      one: "{count} failed passage",
      other: "{count} failed passages",
    }),
    "autopilot.inspector.run.noFailedPassages": "No failed passages",
    "autopilot.inspector.details.title": "Run details",
    "autopilot.inspector.details.started": "Started",
    "autopilot.inspector.details.lastUpdate": "Last update",
    "autopilot.inspector.details.modelCalls": "Model calls",
    "autopilot.inspector.details.unitsUsed": "Units used",
    "autopilot.inspector.details.startedBy": "Started by",
    "autopilot.inspector.details.targetLanguage": "Target language",
    "autopilot.inspector.details.copyRunId": "Copy run ID",
    "autopilot.inspector.details.runIdCopied": "Run ID copied.",

    // — Inspector: errors, recovery, and live announcements —————————
    "autopilot.inspector.error.unsupportedLane":
      "This run targeted a language lane Autopilot couldn’t draft at the time. Retry it on that lane.",
    "autopilot.inspector.error.requestAborted":
      "The model request ended before it completed. Retry when you’re ready.",
    "autopilot.inspector.error.transport":
      "Autopilot couldn’t reach the model service. Check the connection, then try again.",
    "autopilot.inspector.error.invalidResponse":
      "The model service returned a response Autopilot couldn’t use. Try again, or inspect Technical & evidence for diagnostics.",
    "autopilot.inspector.error.http":
      "The model service couldn’t complete this run. Try again later, or open Technical & evidence for diagnostic details.",
    "autopilot.inspector.error.generic":
      "Autopilot reported a problem. Open Technical & evidence for diagnostic details.",
    "autopilot.inspector.error.partialCells":
      "Some cells could not be drafted. Any completed suggestions were preserved for review; inspect the activity evidence before retrying.",
    "autopilot.inspector.error.allCells":
      "Autopilot could not produce a reviewable draft for this passage. Inspect the activity evidence before retrying.",
    "autopilot.inspector.warning.runsRefresh":
      "Could not refresh run history. Showing the last available details.",
    "autopilot.inspector.warning.olderRuns":
      "Could not load older run history. The runs already shown are still current.",
    "autopilot.inspector.warning.activityRefresh":
      "Could not refresh detailed activity. Showing the last available run summary.",
    "autopilot.inspector.warning.olderDrafts":
      "Could not load older draft evidence. The draft records already shown are still current.",
    "autopilot.inspector.action.stopping": "Stopping Autopilot…",
    "autopilot.inspector.action.pausing": "Pausing Autopilot…",
    "autopilot.inspector.action.resuming": "Resuming Autopilot…",
    "autopilot.inspector.action.updateFailed": "The run could not be updated.",

    // — Inspector: activity timeline and stable event vocabulary —————
    "autopilot.inspector.activity.title": "Activity",
    "autopilot.inspector.activity.logAria": "Autopilot step history",
    "autopilot.inspector.activity.empty":
      "Detailed step history wasn’t recorded for this run. Its durable status and totals are still shown above.",
    "autopilot.inspector.activity.loading": "Loading steps…",
    "autopilot.inspector.activity.recentOnly":
      "Only the most recent activity steps are shown for this run.",
    "autopilot.inspector.activity.updateAnnouncement": "Autopilot update: {summary}",
    "autopilot.inspector.event.kind.runCreated": "Run created",
    "autopilot.inspector.event.kind.runState": "Run state",
    "autopilot.inspector.event.kind.spanStarted": "Passage started",
    "autopilot.inspector.event.kind.phase": "Run phase",
    "autopilot.inspector.event.kind.sceneReady": "Scene ready",
    "autopilot.inspector.event.kind.draftsStaged": "Drafts staged",
    "autopilot.inspector.event.kind.spanOutcome": "Passage outcome",
    "autopilot.inspector.event.kind.steeringQueued": "Steering queued",
    "autopilot.inspector.event.kind.draftReviewed": "Draft reviewed",
    "autopilot.inspector.event.kind.unknown": "Activity event",
    "autopilot.inspector.event.status.started": "Work started",
    "autopilot.inspector.event.status.partial": "Partially completed",
    "autopilot.inspector.event.status.queued": "Work queued",
    "autopilot.inspector.event.runStarted": "Autopilot run started",
    "autopilot.inspector.event.workQueued": "Autopilot has work queued",
    "autopilot.inspector.event.running": "Autopilot is running",
    "autopilot.inspector.event.pauseRequested": "Pause requested",
    "autopilot.inspector.event.paused": "Autopilot paused",
    "autopilot.inspector.event.idle": "Autopilot is idle",
    "autopilot.inspector.event.completed": "Autopilot completed",
    "autopilot.inspector.event.error": "Autopilot stopped after an error",
    "autopilot.inspector.event.terminated": "Autopilot terminated",
    "autopilot.inspector.event.statusChanged": "Autopilot status changed",
    "autopilot.inspector.event.spanStarted": "Started {spanLabel}",
    "autopilot.inspector.event.spanStartedGeneric": "Started a passage",
    "autopilot.inspector.event.phaseChanged": "Passage phase changed",
    "autopilot.inspector.event.sceneReady": "Scene analysis ready",
    "autopilot.inspector.event.draftsStaged": plural({
      one: "{count} reviewable draft staged",
      other: "{count} reviewable drafts staged",
    }),
    "autopilot.inspector.event.spanFailed": "Passage failed",
    "autopilot.inspector.event.spanPartial": "Passage partially completed",
    "autopilot.inspector.event.spanComplete": "Passage completed",
    "autopilot.inspector.event.directionQueued": "Direction queued",
    "autopilot.inspector.event.draftApplied": "Draft applied",
    "autopilot.inspector.event.draftSuperseded": "Draft superseded",
    "autopilot.inspector.event.draftRejected": "Draft rejected",

    // — Inspector: draft and scene evidence —————————————————————————
    "autopilot.inspector.review.draftTitle": "Draft",
    "autopilot.inspector.review.noProvenance": "No provenance metadata recorded",
    "autopilot.inspector.review.inEditor": "Review in editor",
    "autopilot.inspector.review.inEditorCell": "Review in editor: cell {cellId}",
    "autopilot.inspector.review.noneLoaded": plural({
      one: "No ready-to-review drafts are loaded from this bounded page yet. {count} remains recorded for this run.",
      other: "No ready-to-review drafts are loaded from this bounded page yet. {count} remain recorded for this run.",
    }),
    "autopilot.inspector.review.noneWaiting":
      "No drafts from this run are waiting for review. Choose a run marked “ready to review” above.",
    "autopilot.inspector.review.showingRecords": plural(
      {
        one: "Showing {visible} of {total} ready-to-review draft record for this run.",
        other: "Showing {visible} of {total} ready-to-review draft records for this run.",
      },
      "total",
    ),
    "autopilot.inspector.review.loadMore": "Load more ready-to-review drafts",
    "autopilot.inspector.review.loadMoreRecords": "Load more draft records",
    "autopilot.inspector.history.title": "Draft history",
    "autopilot.inspector.history.description":
      "Previously applied, rejected, or superseded drafts from this run.",
    "autopilot.inspector.history.showingRecords": plural(
      {
        one: "Showing {visible} of {total} historical draft record for this run.",
        other: "Showing {visible} of {total} historical draft records for this run.",
      },
      "total",
    ),
    "autopilot.inspector.history.recorded": plural({
      one: "{count} historical draft is recorded for this run. Open Activity to inspect non-proposed draft history.",
      other: "{count} historical drafts are recorded for this run. Open Activity to inspect non-proposed draft history.",
    }),
    "autopilot.inspector.context.title": "Context",
    "autopilot.inspector.context.sceneBrief": "Scene brief",
    "autopilot.inspector.context.noSceneSummary":
      "No condensed scene summary was recorded.",
    "autopilot.inspector.context.construal": "Construal",
    "autopilot.inspector.context.ambiguities": plural({
      one: "Ambiguity ({count})",
      other: "Ambiguities ({count})",
    }),
    "autopilot.inspector.context.unlabelledAmbiguity": "Unlabelled ambiguity",
    "autopilot.inspector.context.noneRecorded": "None recorded.",
    "autopilot.inspector.context.missingEssentials": plural({
      one: "{count} missing essential",
      other: "{count} missing essentials",
    }),
    "autopilot.inspector.context.setup": "Set up",
    "autopilot.inspector.context.setupNamed": "Set up {label}",
    "autopilot.inspector.context.noEvidence":
      "No context evidence was recorded for this run.",
    "autopilot.inspector.context.recentBriefsOnly":
      "Only the most recent scene briefs are shown for this run.",
    "autopilot.inspector.technical.title": "Technical & evidence",
    "autopilot.inspector.technical.copyActivityLog": "Copy activity log",
    "autopilot.inspector.technical.activityLogCopied": "Activity log copied.",
    "autopilot.inspector.technical.copyDescription":
      "The copied JSON contains run metadata and sanitized event evidence. Prompts, credentials, and tokens are redacted.",
    "autopilot.inspector.technical.copySpanId": "Copy span ID",
    "autopilot.inspector.technical.spanIdCopied": "Span ID copied.",

    // — Stable evidence/readiness enums (raw unknown values remain evidence) —
    "autopilot.evidence.status.proposed": "Proposed",
    "autopilot.evidence.status.applied": "Applied",
    "autopilot.evidence.status.rejected": "Rejected",
    "autopilot.evidence.status.superseded": "Superseded",
    "autopilot.evidence.status.approved": "Approved",
    "autopilot.evidence.status.archived": "Archived",
    "autopilot.evidence.status.unknown": "Unknown",
    "autopilot.readiness.level.ready": "Ready",
    "autopilot.readiness.level.partial": "Partly set up",
    "autopilot.readiness.level.missing": "Missing",
    "autopilot.readiness.terminology.label": "Key terms",
    "autopilot.readiness.terminology.none":
      "No key terms have an approved rendering yet. Autopilot will translate them ad hoc, and each passage may word them differently.",
    "autopilot.readiness.terminology.some": plural({
      one: "{count} key term has an approved rendering. Autopilot is told the ones that appear in each passage and must use them.",
      other: "{count} key terms have an approved rendering. Autopilot is told the ones that appear in each passage and must use them.",
    }),
    "autopilot.readiness.brief.label": "Translation brief",
    "autopilot.readiness.brief.none":
      "No brief. Autopilot has to guess your audience, register, and how literal to be — the decisions that shape every sentence.",
    "autopilot.readiness.brief.some":
      "{count} of the brief’s questions answered. Audience, register, and literalness ride in each draft prompt.",
    "autopilot.readiness.brief.someWithSummary":
      "{count} of the brief’s questions answered, summarised for every passage. Audience, register, and literalness ride in each draft prompt.",
    "autopilot.readiness.examples.label": "Approved examples",
    "autopilot.readiness.examples.none":
      "No validated translations yet. Autopilot has no sample of your team’s voice to imitate — validate a few translations first and the drafts will sound far more like you.",
    "autopilot.readiness.examples.some": plural({
      one: "{count} validated translation to imitate. This is where the drafts learn your team’s voice.",
      other: "{count} validated translations to imitate. This is where the drafts learn your team’s voice.",
    }),
    "autopilot.readiness.rules.label": "Project checks",
    "autopilot.readiness.rules.none":
      "No hand-written checks. Key-term checks still run; add rules for punctuation, spelling, or formatting conventions you care about.",
    "autopilot.readiness.rules.some": plural({
      one: "{count} check runs on every draft before it reaches you.",
      other: "{count} checks run on every draft before they reach you.",
    }),
    "autopilot.readiness.languages.label": "Project languages",
    "autopilot.readiness.languages.set": "Translating {sourceLanguage} → {targetLanguage}.",
    "autopilot.readiness.languages.unset":
      "Source or target language isn’t set, so Autopilot has to infer it from your existing translations.",
  },
  context: {
    _context: {
      description:
        "Autopilot automation controls, progress, human-review boundaries, recovery messages, and durable evidence across the project overview and translation editor.",
    },
    keys: {
      "autopilot.settings.controlsLabel": {
        description:
          "Device-local switch label that shows or hides Autopilot controls without starting or stopping server work.",
        screenshot: "project-settings",
      },
      "autopilot.settings.controlsDescription": {
        description:
          "Safety explanation below the device-local Autopilot discovery switch in project settings.",
        screenshot: "project-settings",
      },
      "autopilot.draft.suggested": {
        description:
          "Small status label beside an Autopilot proposal inside a target cell.",
        screenshot: "editor-table",
      },
      "autopilot.steering.direct": {
        description:
          "Accessible name of the icon button that opens the run-direction popover.",
        screenshot: "editor-table",
      },
      "autopilot.inspector.title": {
        description:
          "Heading and accessible name of the sheet containing Autopilot runs, controls, history, and evidence.",
        screenshot: "editor-table",
      },
      "autopilot.progress.passagesComplete": withPlaceholders(
        "Progressbar accessible name reporting completed passages out of the run total.",
        { done: "Number of completed passages.", total: "Total number of passages in the run." },
      ),
      "autopilot.time.checkedAt": withPlaceholders(
        "Timestamp below the overview card saying when its latest successful snapshot was checked.",
        { time: "Locale-formatted time of the latest successful overview refresh." },
      ),
      "autopilot.overview.attentionIssues": withPlaceholders(
        "Overview sentence reporting how many run failures or failed passages need attention.",
        { count: "Number of attention items across the project." },
      ),
      "autopilot.overview.workingScanningFiles": withPlaceholders(
        "Overview status while active files are still being segmented and their total work is unknown.",
        { fileCount: "Number of files currently doing Autopilot work." },
      ),
      "autopilot.overview.workingProgress": withPlaceholders(
        "Overview status combining active-file count with a separately localized aggregate-progress phrase.",
        {
          fileCount: "Number of files currently doing Autopilot work.",
          progress: "Localized passage-progress phrase, whose own plural form is governed by its total.",
        },
      ),
      "autopilot.overview.passagesProgress": withPlaceholders(
        "Standalone aggregate passage-progress phrase nested into the file-count status so both nouns pluralize independently.",
        {
          done: "Number of completed passages across the latest runs.",
          total: "Total passages across the latest runs.",
        },
      ),
      "autopilot.overview.pausedProgress": withPlaceholders(
        "Overview sentence giving the passage where paused work currently stands.",
        { done: "Number of completed passages.", total: "Total passages in paused runs." },
      ),
      "autopilot.overview.queuedPassages": withPlaceholders(
        "Overview sentence reporting work queued for background continuation.",
        { count: "Number of queued passages." },
      ),
      "autopilot.overview.reviewDrafts": withPlaceholders(
        "Overview sentence reporting draft suggestions awaiting human review.",
        { count: "Number of proposed drafts awaiting review." },
      ),
      "autopilot.overview.widget.reviewAria": withPlaceholders(
        "Accessible name of the overview widget opening ready-to-review evidence.",
        { count: "Number shown in the ready-to-review widget." },
      ),
      "autopilot.overview.widget.attentionAria": withPlaceholders(
        "Accessible name of the overview widget opening failures and recovery details.",
        { count: "Number shown in the needs-attention widget." },
      ),
      "autopilot.overview.widget.contextAria": withPlaceholders(
        "Accessible name of the overview widget opening context-readiness suggestions.",
        { count: "Number shown in the context-suggestions widget." },
      ),
      "autopilot.overview.refreshFailedAt": withPlaceholders(
        "Stale-snapshot warning that retains the last trustworthy overview refresh time.",
        { time: "Locale-formatted time of the retained successful snapshot." },
      ),
      "autopilot.overview.startResult.startedFiles": withPlaceholders(
        "One item in the project-start result naming files whose runs started.",
        { count: "Number of files whose Autopilot runs started." },
      ),
      "autopilot.overview.startResult.skippedFiles": withPlaceholders(
        "One item in the project-start result naming files that were skipped.",
        { count: "Number of files skipped during the start attempt." },
      ),
      "autopilot.overview.startResult.deferredFiles": withPlaceholders(
        "One item in the project-start result naming files deferred by the batch limit.",
        { count: "Number of files deferred to a later batch." },
      ),
      "autopilot.overview.startResult.alreadyRunning": withPlaceholders(
        "Reason in a project-start result: files already have active runs.",
        { count: "Number of files already running." },
      ),
      "autopilot.overview.startResult.queuedWork": withPlaceholders(
        "Reason in a project-start result: files still own queued work.",
        { count: "Number of files with queued work." },
      ),
      "autopilot.overview.startResult.paused": withPlaceholders(
        "Reason in a project-start result: files have paused runs.",
        { count: "Number of files with paused runs." },
      ),
      "autopilot.overview.startResult.pausePending": withPlaceholders(
        "Reason in a project-start result: files are completing a pause request.",
        { count: "Number of files finishing a pause." },
      ),
      "autopilot.overview.startResult.idleOwner": withPlaceholders(
        "Reason in a project-start result: an idle run still owns each file.",
        { count: "Number of files owned by idle runs." },
      ),
      "autopilot.overview.startResult.startFailed": withPlaceholders(
        "Reason in a project-start result: file-level starts failed and have evidence.",
        { count: "Number of file starts that failed." },
      ),
      "autopilot.overview.startResult.unavailable": withPlaceholders(
        "Fallback reason for an unknown stable skip category from the server.",
        { count: "Number of files in the unknown skip category." },
      ),
      "autopilot.overview.startResult.outcome": withPlaceholders(
        "Sentence wrapping a locale-formatted list of project-start outcome counts or skip reasons.",
        { items: "Locale-formatted list of outcome counts or reasons from the project-start response." },
      ),
      "autopilot.pill.suggestionsReady": withPlaceholders(
        "Screen-reader text beside the numeric proposal badge in the editor pill.",
        { count: "Number of suggestions ready for review in the open file." },
      ),
      "autopilot.pill.activePassages": withPlaceholders(
        "Compact editor-pill label for passages processed concurrently.",
        { count: "Number of passages currently active." },
      ),
      "autopilot.pill.failedPassages": withPlaceholders(
        "Editor-pill failure summary reporting failed passages out of the run total.",
        { failed: "Number of failed passages.", total: "Total number of passages." },
      ),
      "autopilot.pill.announcement.queued": withPlaceholders(
        "Polite live-region announcement that queued work will continue in the background.",
        { count: "Number of queued passages." },
      ),
      "autopilot.pill.queuedRemaining": withPlaceholders(
        "Compact visible editor-pill label for queued passages remaining.",
        { count: "Number of queued passages remaining." },
      ),
      "autopilot.pill.completeWithAttention": withPlaceholders(
        "Editor-pill summary when a run finished some passages and left others needing a person.",
        {
          done: "Number of passages that produced reviewable drafts.",
          total: "Total number of passages in the run.",
          failed: "Number of passages that still need attention.",
        },
      ),
      "autopilot.pill.announcement.completeWithAttention": withPlaceholders(
        "Polite live-region announcement that Autopilot finished with some passages still needing attention.",
        {
          done: "Number of passages that produced reviewable drafts.",
          total: "Total number of passages in the run.",
          failed: "Number of passages that still need attention.",
        },
      ),
      "autopilot.inspector.run.lane": withPlaceholders(
        "Selected-run label identifying the target-language lane Autopilot is drafting into.",
        { language: "Target-language code stored on the run; do not translate the substituted value." },
      ),
      "autopilot.draft.draftedFrom": withPlaceholders(
        "Tooltip identifying the passage from which an inline suggestion was drafted.",
        { spanLabel: "Human-readable passage reference; do not translate its substituted value." },
      ),
      "autopilot.steering.queuedDirections": withPlaceholders(
        "Screen-reader description of directions waiting for the next drafted passage.",
        { count: "Number of queued human directions." },
      ),
      "autopilot.inspector.projectReviewCount": withPlaceholders(
        "Inspector introduction reporting project-wide proposals awaiting review.",
        { count: "Number of proposed drafts across the project." },
      ),
      "autopilot.inspector.targetLanguage": withPlaceholders(
        "Run-list label identifying a historic multilingual target lane.",
        { language: "Target-language code stored on the run; do not translate the substituted value." },
      ),
      "autopilot.inspector.readyCount": withPlaceholders(
        "Run-list badge counting proposals ready for human review.",
        { count: "Number of proposed drafts." },
      ),
      "autopilot.inspector.count.visibleOfTotal": withPlaceholders(
        "Compact disclosure badge showing loaded records against an authoritative total.",
        { visible: "Number of records currently loaded.", total: "Authoritative record total." },
      ),
      "autopilot.inspector.run.queued": withPlaceholders(
        "Selected-run summary reporting passages queued for background continuation.",
        { count: "Number of queued passages remaining in this run." },
      ),
      "autopilot.inspector.run.updatedAt": withPlaceholders(
        "Selected-run footer timestamp for its most recent durable update.",
        { time: "Locale-formatted update date and time." },
      ),
      "autopilot.inspector.run.calls": withPlaceholders(
        "Selected-run metric counting model calls.",
        { count: "Number of model calls spent by the run." },
      ),
      "autopilot.inspector.run.units": withPlaceholders(
        "Selected-run metric counting billed model units.",
        { count: "Number of model units spent by the run." },
      ),
      "autopilot.inspector.run.failedPassages": withPlaceholders(
        "Selected-run footer metric counting failed passages.",
        { count: "Number of failed passages." },
      ),
      "autopilot.inspector.activity.updateAnnouncement": withPlaceholders(
        "Polite live-region announcement for the newest durable activity step.",
        { summary: "Localized summary of the newest stable activity event." },
      ),
      "autopilot.inspector.event.spanStarted": withPlaceholders(
        "Activity-timeline summary for a passage whose human-readable span is known.",
        { spanLabel: "Human-readable passage reference; do not translate its substituted value." },
      ),
      "autopilot.inspector.event.draftsStaged": withPlaceholders(
        "Activity-timeline summary counting reviewable drafts staged by one passage.",
        { count: "Number of reviewable drafts staged." },
      ),
      "autopilot.inspector.review.inEditorCell": withPlaceholders(
        "Accessible name of an editor review link that identifies its target cell.",
        { cellId: "Stable target-cell identifier; do not translate its substituted value." },
      ),
      "autopilot.inspector.review.noneLoaded": withPlaceholders(
        "Bounded-page message when authoritative proposals exist but none are loaded yet.",
        { count: "Authoritative number of proposed drafts remaining on the run." },
      ),
      "autopilot.inspector.review.showingRecords": withPlaceholders(
        "Bounded-page note reporting loaded ready-to-review records against the total.",
        { visible: "Number of ready-to-review records loaded.", total: "Authoritative proposed-draft total." },
      ),
      "autopilot.inspector.history.showingRecords": withPlaceholders(
        "Bounded-page note reporting loaded historical draft records against the total.",
        { visible: "Number of historical records loaded.", total: "Authoritative historical-record total." },
      ),
      "autopilot.inspector.history.recorded": withPlaceholders(
        "Review-focused note reporting non-proposed history available in the Activity view.",
        { count: "Number of historical draft records." },
      ),
      "autopilot.inspector.context.ambiguities": withPlaceholders(
        "Scene-evidence heading showing the ambiguity-register count.",
        { count: "Number of ambiguity questions in the scene brief." },
      ),
      "autopilot.inspector.context.missingEssentials": withPlaceholders(
        "Context-readiness summary counting essential inputs that are missing.",
        { count: "Number of missing essential context inputs." },
      ),
      "autopilot.inspector.context.setupNamed": withPlaceholders(
        "Accessible name of a link that opens setup for one context-readiness item.",
        { label: "Localized name of the readiness item being configured." },
      ),
      "autopilot.readiness.terminology.some": withPlaceholders(
        "Readiness detail counting approved key-term renderings available to Autopilot.",
        { count: "Number of key terms with an approved rendering." },
      ),
      "autopilot.readiness.brief.some": withPlaceholders(
        "Readiness detail counting answered translation-brief questions.",
        { count: "Number of answered brief questions." },
      ),
      "autopilot.readiness.brief.someWithSummary": withPlaceholders(
        "Readiness detail counting brief answers and noting a per-passage summary.",
        { count: "Number of answered brief questions." },
      ),
      "autopilot.readiness.examples.some": withPlaceholders(
        "Readiness detail counting validated translations available as voice examples.",
        { count: "Number of validated translation examples." },
      ),
      "autopilot.readiness.rules.some": withPlaceholders(
        "Readiness detail counting project checks applied to every proposal.",
        { count: "Number of authored project checks." },
      ),
      "autopilot.readiness.languages.set": withPlaceholders(
        "Readiness detail naming the configured source-to-target language direction.",
        {
          sourceLanguage: "Configured source-language name; do not translate the substituted value.",
          targetLanguage: "Configured target-language name; do not translate the substituted value.",
        },
      ),
    },
  },
  surfaces: [],
})
