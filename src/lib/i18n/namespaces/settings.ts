import { defineNamespace, plural } from "./types"

/**
 * Preferences, personal/org/team settings surfaces.
 *
 * Registered ahead of its strings so the six parallel keying agents never
 * contend on `messages/en.ts` / `namespaces/index.ts` — see
 * `docs/swarm/I18N-COVERAGE-ORCHESTRATION.md`. A registered-but-empty namespace
 * is invisible to `CATALOG_CONTEXT` (its name is derived from its first key's
 * prefix), so this compiles and lints clean while empty.
 *
 * Declares no screenshot surface of its own: these controls live inside the
 * `project-settings` surface that `common` declares.
 *
 * A LOT of the English this namespace would otherwise mint already exists
 * elsewhere in the catalog — `onboarding.preferences.*` mirrors the real
 * `Preferences.tsx` copy almost verbatim (its own comments say so), `org.ts`
 * already carries `org.teamDetail.*` for the team-delete flow and
 * `org.createDialog.nameLabel` for "Organization name", and `editor.navTitle.*`
 * already names "Organization settings" / "Members" / "Teams" / "Archived
 * projects" as nav destinations. Every one of those is reused below by exact
 * string match rather than re-minted — see each key's comment for the reused
 * key when this namespace has no key of its own for that string.
 */
export const settings = defineNamespace({
  keys: {
    // ── AQU-2265: the temporary note left where a setting used to live ──
    "settings.moved.note": "This setting moved to {where}.",
    "settings.moved.goThere": "Go to it",
    // ── AQU-2259: the author name for edits made while signed out ──
    "settings.preferences.authorName.label": "Name when signed out",
    "settings.preferences.authorName.description": "Used as the author of your edits when you work without signing in.",
    // ── AQU-2264: Preferences → Recording (RecordingPreferencesSection) ──
    // Title "Recording" → editor.expansion.recording; "Timeline" →
    // editor.timeline.title; the recorder rows' names and the countdown speeds →
    // audio.recordingModal.*; "Follow playhead" → editor.timeline.followPlayhead;
    // "Snap to neighboring edges" → editor.timeline.snapToggleAria (identical text).
    "settings.preferences.recording.description": "How the recorder and the timeline work for you.",
    "settings.preferences.recording.followsYou":
      "They follow you: change one here, in the recorder or on the timeline, and it changes on " +
      "every device where you're signed in.",
    "settings.preferences.recording.thisDeviceOnly":
      "You're not signed in, so they're kept on this device only.",
    "settings.preferences.recording.hint.followsYou": "Follows you",
    "settings.preferences.recording.hint.thisDevice": "This device only",
    "settings.preferences.recording.recorderGroup": "Recorder",
    "settings.preferences.recording.countdownInfo":
      "Before each take the recorder counts 3, 2, 1, so you can get ready. Fast, Normal and Slow " +
      "give each number half a second, one second or a second and a half. Off starts recording " +
      "as soon as you press Record.",
    "settings.preferences.recording.beepInfo":
      "A short beep on each number of the countdown, so you can keep your eyes on the line. With " +
      "the countdown off there is nothing to beep, so it waits until the countdown is back.",
    "settings.preferences.recording.moveOnInfo":
      "When on, saving a recording takes you to the next line, and on the last line closes the " +
      "recorder. A file you upload stays on its line either way.",
    "settings.preferences.recording.takesDrawerInfo":
      "When on, the line's takes are listed under the recorder, as many as fit, and the arrow " +
      "beside Takes brings up the rest. When off, only the Takes bar shows.",
    "settings.preferences.recording.formatTitle": "Recording format",
    "settings.preferences.recording.formatWav": "WAV",
    "settings.preferences.recording.formatCompressed": "Compressed",
    "settings.preferences.recording.formatInfo":
      "WAV keeps full quality, at about three times the file size, and a take can run to 15 " +
      "minutes. Compressed files are much smaller and can run to 30 minutes. A take keeps the " +
      "format it was recorded in. It is also the WAV / COMPRESSED button in the recorder.",
    "settings.preferences.recording.showFilmTitle": "Show the film beside the recorder",
    "settings.preferences.recording.showFilmInfo":
      "When a line has a film, the recorder shows it on the left. Turn this off to open the narrow " +
      "recorder instead; its Film button brings the film back.",
    "settings.preferences.recording.filmSoundTitle": "Play the film's sound while recording",
    "settings.preferences.recording.filmSoundInfo":
      "Off unless you turn it on. Use it only with headphones: the microphone records without " +
      "echo cancellation, so on speakers the film's sound goes into your take.",
    "settings.preferences.recording.followInfo":
      "While playing, the timeline scrolls to keep the playhead in view. If you scroll away by " +
      "hand, it lets go until you press play again.",
    "settings.preferences.recording.snapInfo":
      "When you drag a take or a line, or one of its edges, it snaps to the edges next to it.",
    // ── CommentNotificationsSection (preferences → notifications) ── AQU-1193
    "settings.notifications.groupLabel": "Comment email",
    "settings.notifications.commentEmailLabel": "Email me about comments",
    "settings.notifications.commentEmailDescription":
      "How much comment email Aquilla sends you. Replies on one thread always " +
      "arrive as a single email conversation, however you set this.",
    "settings.notifications.option.all": "Every mention and reply",
    "settings.notifications.option.mentions": "Only when someone @-mentions me",
    "settings.notifications.option.off": "Never",
    "settings.notifications.loadFailed": "Could not load your notification setting",
    "settings.notifications.saveFailed": "Could not save that setting",
    "settings.notifications.section.title": "Notifications",
    "settings.notifications.section.description":
      "Choose when Aquilla emails you about comments.",
    "settings.transcription.title": "Transcription",
    "settings.transcription.scope":
      "This choice applies to your account in this browser.",
    "settings.transcription.hosted": "Aquilla hosted (recommended)",
    "settings.transcription.hostedDescription":
      "Ready immediately. Uses your workspace's AI capacity. No key or download needed.",
    "settings.transcription.local": "Local Whisper in this browser",
    "settings.transcription.localDescription":
      "Download Whisper below. Runs on your device without using hosted AI capacity. Speed depends on your device.",
    "settings.transcription.capacityExceeded":
      "Your workspace has reached its AI capacity. Try after the reset, update your plan, or choose " +
      "Whisper on this device in Preferences → On-device AI models.",
    // ── Omnilingual ASR: hosted model choice, zero-shot warm-up and batches ──
    "settings.transcription.model.legend": "Hosted model",
    "settings.transcription.model.auto": "Automatic",
    "settings.transcription.model.autoDescription":
      "Picks the model that knows the project's language: Qwen3-ASR for Chinese, Whisper, then Omnilingual.",
    "settings.transcription.model.whisper": "Whisper",
    "settings.transcription.model.whisperDescription": "OpenAI's model. Strong in widely spoken languages.",
    "settings.transcription.model.qwen": "Qwen3-ASR",
    "settings.transcription.model.qwenDescription":
      "Strong in Chinese and its dialects, and lower cost than Whisper.",
    "settings.transcription.model.omni": "Omnilingual",
    "settings.transcription.model.omniDescription":
      "Meta's model for more than 1,600 languages, including many that no other model knows.",
    "settings.transcription.model.zeroShot": "Omnilingual Zero-Shot",
    "settings.transcription.model.zeroShotDescription":
      "Any language — learns from your project's recorded takes. Slower, and uses more credits.",
    "settings.transcription.model.supports": "Supports {language}",
    "settings.transcription.model.doesNotSupport": "Does not support {language}",
    "settings.transcription.model.seeAll": "See all {count} languages",
    "settings.transcription.model.search": "Search languages",
    "settings.transcription.model.dialects": "Chinese dialects",
    "settings.transcription.model.examples": plural({
      one: "{count} usable example in this project",
      other: "{count} usable examples in this project",
    }, "count"),
    "settings.transcription.zeroShot.warmupTitle": "Starting the zero-shot model — about 1–3 minutes",
    "settings.transcription.zeroShot.warmupTimeout": "The zero-shot model did not start in time.",
    "settings.transcription.zeroShot.warmupFailed":
      "The zero-shot model did not start. Try again, or choose Automatic in Preferences.",
    "settings.transcription.zeroShot.useAutomatic": "Use automatic",
    "settings.transcription.zeroShot.noExamples":
      "Zero-shot needs at least one recorded and transcribed line in this language.",
    "settings.transcription.zeroShot.useOmniStandard": "Use Omnilingual standard instead",
    "settings.transcription.zeroShot.disabledByOrg":
      "Your organization has turned off zero-shot transcription. Aquilla used the automatic model instead.",
    "settings.transcription.zeroShot.examplesFailed":
      "Could not load this project's zero-shot examples ({status}). Try again.",
    "settings.transcription.zeroShot.batchTitle": plural({
      one: "Transcribe {count} recording with zero-shot?",
      other: "Transcribe {count} recordings with zero-shot?",
    }, "count"),
    "settings.transcription.zeroShot.batchShare": "≈ {percent}% of this week's remaining credits",
    "settings.transcription.zeroShot.batchCredits": "≈ {credits} for this batch",
    "settings.transcription.zeroShot.batchConfirm": "Transcribe",
    "settings.transcription.zeroShot.orgLabel": "Allow zero-shot transcription",
    "settings.transcription.zeroShot.orgDescription":
      "Members can choose the Omnilingual Zero-Shot model in their Preferences. It learns a " +
      "language from the project's own recordings, and uses more credits than the automatic model.",
    "settings.transcription.zeroShot.orgSaveFailed": "Could not save that setting",
    "settings.transcription.zeroShot.orgBlocked": "Only organization admins can change this.",

    // ── StructuralCellsSection (org settings → security) ── AQU-1083
    "settings.structuralCells.label": "Count headings as translatable content",
    "settings.structuralCells.description":
      "When on, chapter headings, section titles and book names count toward " +
      "translation and validation percentages, the same as any other line. " +
      "When off, they are left out of both the completed count and the total, " +
      "so a book reads 100% once every verse is done. Individual projects can " +
      "override this.",
    "settings.structuralCells.saveFailed": "Save failed",
    "settings.structuralCells.blocked":
      "Only org maintainers and owners can change how progress is counted.",
    "settings.structuralCells.resetFailed": "Could not update those projects",
    "settings.structuralCells.resetTitle": plural({
      one: "{count} project has its own setting",
      other: "{count} projects have their own setting",
    }, "count"),
    "settings.structuralCells.resetDescription": plural({
      one: "It will keep counting headings its own way and ignore this default. Reset it to follow the organization instead?",
      other: "They will keep counting headings their own way and ignore this default. Reset them to follow the organization instead?",
    }, "count"),
    // Number-neutral: the title beside it is singular at a count of one, and
    // "Leave them as they are" under "1 project has its own setting" reads
    // like a bug.
    "settings.structuralCells.resetKeep": "Leave unchanged",
    "settings.structuralCells.resetConfirm": "Reset to the default",
    // ── ValidationDefaultsSection ── AQU-1771
    "settings.validationDefaults.textDescription":
      "How many people must validate a translation before it counts as validated. " +
      "Projects use this unless they set their own number.",
    "settings.validationDefaults.audioDescription":
      "How many people must validate a recording before it counts as validated. " +
      "Projects use this unless they set their own number.",
    "settings.validationDefaults.resetTitle": plural({
      one: "{count} project has its own number",
      other: "{count} projects have their own number",
    }, "count"),
    "settings.validationDefaults.resetDescription": plural({
      one: "It will keep its own number and ignore this default. Reset it to follow the organization instead?",
      other: "They will keep their own number and ignore this default. Reset them to follow the organization instead?",
    }, "count"),
    // ── OverrideStatus ── AQU-1771
    "settings.overrideStatus.allFollow": "All projects follow this default.",
    "settings.overrideStatus.someOwnNumber": plural({
      one: "{count} project sets its own number",
      other: "{count} projects set their own number",
    }, "count"),
    "settings.overrideStatus.someOwnSetting": plural({
      one: "{count} project sets its own setting",
      other: "{count} projects set their own setting",
    }, "count"),
    "settings.overrideStatus.reset": "Reset to default",
    // AQU-1771: under "Who can see the member list" / "Who can see member
    // progress" — projects may only make these stricter.
    "settings.overrideStatus.someStricter": plural({
      one: "{count} project is stricter than this",
      other: "{count} projects are stricter than this",
    }, "count"),
    // AQU-1938: the last line of the project list those counts open.
    "settings.overrideStatus.andMore": plural({
      one: "and {count} more",
      other: "and {count} more",
    }, "count"),

    // ── MediaDefaultsSection ── AQU-1768
    "settings.mediaDefaults.groupLabel": "Timeline and recordings",
    "settings.mediaDefaults.timingLockedDescription":
      "Whether imported timings are locked against dragging. Projects use this unless they set their own.",
    "settings.mediaDefaults.allowTrackEditingDescription":
      "Whether maintainers may add, group and recolour timeline tracks. On unless you turn it off. Projects use this unless they set their own.",
    "settings.mediaDefaults.cellEditingFloorDescription":
      "Who may add and remove lines. Projects use this unless they set their own.",
    "settings.mediaDefaults.allowSelfValidationAudioDescription":
      "Whether people may validate their own recordings. Projects use this unless they set their own.",
    "settings.mediaDefaults.validationRoleFloorAudioDescription":
      "The lowest role that may validate recordings. Projects use this unless they set their own.",
    "settings.mediaDefaults.resetDescription": plural({
      one: "It will keep its own setting and ignore this default. Reset it to follow the organization instead?",
      other: "They will keep their own setting and ignore this default. Reset them to follow the organization instead?",
    }, "count"),

    // ── RepetitionPropagationSection (AQU-1391) ──
    "settings.autoPropagateRepetitions.label": "Auto-propagate repetitions",
    "settings.autoPropagateRepetitions.description":
      "When on, validating a cell copies its translation into every other cell " +
      "in the same file whose source text is identical. The filled-in cells are " +
      "left unvalidated so someone still checks them in context. Individual " +
      "projects can override this.",
    "settings.autoPropagateRepetitions.saveFailed": "Save failed",
    "settings.autoPropagateRepetitions.blocked":
      "Only org maintainers and owners can change this default.",

    // ── AssignmentAuthoritySection (org settings → security) ──
    "settings.assignmentAuthority.floorLabel": "Who can assign work",
    "settings.assignmentAuthority.floorDescription":
      "Minimum project role required to assign, reassign, or unassign file, chapter, language lane, " +
      "and AI review tasks. Defaults to Project lead.",
    "settings.assignmentAuthority.label": "Allow self-assignment",
    "settings.assignmentAuthority.description":
      "When on, a member (contributor and above) can claim a book/chapter/take " +
      "for themselves from the assign-work picker — they still can't assign " +
      "work to anyone else. Leads and maintainers can always assign, to " +
      "anyone, regardless of this setting.",
    "settings.laneAssignmentAuthority.label": "Allow language lane coordinators to assign work",
    "settings.laneAssignmentAuthority.description":
      "When on, a member (contributor and above) who has been restricted to specific language lanes " +
      "can assign work to other people — but only within those language lanes. Give a mentor or " +
      "coordinator the language lanes they look after under Members, and they can hand out chapters " +
      "there without any other admin rights. Members with no language lane restriction are " +
      "unaffected by this setting.",

    // ── OrgProviderSection (org settings → AI provider keys) ──
    "settings.providerKeys.groupLabel": "Provider keys",
    "settings.providerKeys.geminiTtsLabel": "Gemini TTS API key",
    "settings.providerKeys.restrictedNotice":
      "Only org maintainers and owners can set org-level keys. You can still " +
      "save a personal key in your project or personal settings.",
    // AQU-2263: it said voices use this key; none do yet (see key-in-use.ts),
    // so it says what the key is for and the line under it says what is used.
    "settings.providerKeys.geminiTtsDescription":
      "A Gemini key for the whole organization, for voices when a project and the person have no key of their own.",
    // ── AQU-2263: the one description of "Share usage data", in Preferences
    // and onboarding alike (ShareUsageDataSetting) ──
    "settings.shareUsageData.description":
      "Usage events, like creating a project or exporting, and session recordings that help us diagnose problems. " +
      "Never the contents of your translations or files.",
    // ── AQU-2263: which AI key is in use right now (KeyInUseLine) ──
    // {name} is the platform provider's name, "Frontier".
    "settings.keyInUse.platform": "Using {name}. No key needed.",
    "settings.keyInUse.projectKey": "Using this project's key (this device only).",
    "settings.keyInUse.personalKey": "Using your own key (saved in this browser).",
    "settings.keyInUse.preferences": "Using your own key (Preferences).",
    "settings.keyInUse.preferencesNoKey": "Using your own provider (Preferences), which needs no key.",
    "settings.keyInUse.noKeyNeeded": "Using this project's provider, which needs no key.",
    "settings.keyInUse.missing": "No key is in use, and this provider needs one.",
    "settings.keyInUse.geminiMissing": "No Gemini key yet.",
    "settings.keyInUse.geminiOrgUnused":
      "No key is in use. Your organization has a Gemini key, but voices don't use it yet.",
    "settings.keyInUse.orgGeminiSaved":
      "Saved, but voices don't use the organization's key yet: each project or person still needs their own.",
    "settings.keyInUse.orgGeminiNone": "No organization key.",
    "settings.keyInUse.prefsActive": "In use in every project that doesn't have its own provider.",
    // {name} is the platform provider's name, "Frontier".
    "settings.keyInUse.prefsNone": "Not set. Projects use {name} unless they have their own provider.",
    // "Clear" button → common.clear (identical text)

    // ── PersonalProviderSection (Preferences → AI provider keys) ──
    "settings.personalProvider.groupLabel": "Personal override",
    "settings.personalProvider.advancedToggleLabel": "AI provider (advanced)",
    "settings.personalProvider.description":
      "Use your own OpenAI-compatible endpoint instead of Frontier for AI " +
      "translations. Stored only in this browser, never synced. Default for " +
      "projects that don't have their own API key; a project key beats this.",
    // Rendered via <RichMessage> so the two path fragments keep their
    // monospace <code> styling instead of being flattened into plain text.
    "settings.personalProvider.trailingPathHint": "Trailing {v1Path} or {chatCompletionsPath} is fine.",
    "settings.personalProvider.apiKeyPlaceholder": "sk-…",
    // Also <RichMessage> — {authHeader} keeps its <code> styling.
    "settings.personalProvider.authHeaderHint":
      "Sent as {authHeader}. Leave blank for unauthenticated local endpoints.",
    "settings.personalProvider.removeOverride": "Remove override",
    // "Endpoint URL" → projectSettings.advancedLlm.endpointLabel (identical text)
    // "Model" → projectSettings.advancedLlm.modelLabel (identical text)
    // "API key" → projectSettings.field.apiKey (identical text)

    // ── LocalLlmSection (Preferences → Offline AI provider, Tauri desktop app only) ──
    // Deliberately NOT named "Local LLM" in the UI — sits right next to "Local models"
    // (Whisper/MMS voice models, an unrelated on-device speech feature) in the same
    // nav group, and the two names read as siblings when they aren't. This is a text-
    // generation endpoint used only when offline; that's a voice/transcription cache used
    // always. The description below repeats the distinction since a user landing straight on
    // this page (deep link, search) won't have seen the nav row's "Offline only" hint.
    "settings.localLlm.groupLabel": "Offline AI provider",
    "settings.localLlm.description":
      "Used for AI translations only when this device has no connection — unrelated to the on-device " +
      "voice models under \"On-device AI models.\" Requests are proxied through a small local server " +
      "on this device, never sent over the network. Defaults match Ollama running locally.",
    "settings.localLlm.testConnection": "Test connection",
    // "Save" button → common.save (identical text)
    "settings.localLlm.detectModels": "Detect models",
    "settings.localLlm.detectedOne": "Detected and filled in: {model}",
    "settings.localLlm.detectedMany": "Found multiple models — pick one:",
    "settings.localLlm.detectedNone": "No models found at that endpoint.",

    // ── RosterProgressSection (org settings → security) ──
    "settings.rosterProgress.groupLabel": "Visibility",
    "settings.rosterProgress.groupDescription":
      "Who can see the member list and per-member progress. Both default to Maintainer.",
    "settings.rosterProgress.rosterLabel": "Who can see the member list",
    "settings.rosterProgress.rosterDescription":
      "Minimum role required to see the member list and member count, on both the org Members page " +
      "and each project's Members tab. Below this role, the member list and count are hidden " +
      "entirely — not shown empty, just absent.",
    "settings.rosterProgress.progressLabel": "Who can see member progress",
    "settings.rosterProgress.progressDescription":
      "Minimum role required to see per-member progress/productivity. Independent of who can see the " +
      "member list — a role can see who's on the team without seeing their progress, or vice versa.",
    // Open-dropdown option text for the roster/progress floor selects. FLOOR_LABEL
    // (src/pages/settings/constants.ts) supplies the short closed-trigger text; these
    // are the fuller sentences shown once the dropdown is open. The role name +
    // numeric level are fixed per option (not a runtime placeholder) — same
    // treatment as settings.termbase.option* below.
    "settings.rosterProgress.optionViewer": "Viewer — anyone with access",
    "settings.rosterProgress.optionContributor": "Contributor",
    "settings.rosterProgress.optionProjectLead": "Project lead",
    "settings.rosterProgress.optionMaintainer": "Maintainer — default",
    "settings.rosterProgress.optionOwner": "Owner — most restrictive",

    // ── TermbaseEditSection (org settings → security) ──
    "settings.termbase.label": "Who can manage terminology",
    "settings.termbase.description":
      "Minimum role required to add, edit, delete, and archive terms in a " +
      "project's term base. Below this role the term base is read-only. This " +
      "setting covers terminology only — every other project setting still " +
      "requires Maintainer.",
    // Open-dropdown option text for the termbase-edit floor select; see the
    // roster/progress options above for why the level number is baked in.
    "settings.termbase.optionContributor": "Contributor — translators manage terms",
    "settings.termbase.optionProjectLead": "Project lead — default",
    "settings.termbase.optionMaintainer": "Maintainer — most restrictive",

    // ── LanguageEditSection (org settings → security) — AQU-1086 ──
    "settings.languageEdit.label": "Who can change project languages",
    "settings.languageEdit.description":
      "Minimum role required to change a project's source and target language and to add or archive " +
      "extra language lanes. This setting covers languages only — every other project setting still " +
      "requires Maintainer.",
    // Open-dropdown option text for the language-edit floor select; see the
    // roster/progress options above for why the level number is baked in.
    "settings.languageEdit.optionProjectLead":
      "Project lead — default. Project managers fix their own languages",
    "settings.languageEdit.optionMaintainer": "Maintainer — only maintainers change languages",
    "settings.languageEdit.ownerOnlyError":
      "Only org owners can change the language permission policy.",

    // ── CommentPermissionsSection (org settings → security) ──
    "settings.commentPermissions.groupLabel": "Comments",
    "settings.commentPermissions.groupDescription":
      "Who can take part in comment threads on this org's projects. Only org " +
      "owners can change these.",
    "settings.commentPermissions.createLabel": "Who can comment",
    "settings.commentPermissions.createDescription":
      "Minimum role required to open a comment thread or post a reply. Below " +
      "this role, threads are read-only.",
    "settings.commentPermissions.resolveLabel": "Who can resolve others' threads",
    "settings.commentPermissions.resolveDescription":
      "Minimum role required to resolve or reopen a thread someone else " +
      "opened. Whoever opened a thread can always resolve their own, whatever " +
      "this is set to.",
    // Open-dropdown option text for both comment floors; see the
    // roster/progress options above for why the level number is baked in.
    "settings.commentPermissions.createOptionCommenter": "Commenter — default",
    "settings.commentPermissions.createOptionReviewer": "Reviewer — reviewers and above",
    "settings.commentPermissions.createOptionContributor": "Contributor — translators and above",
    "settings.commentPermissions.createOptionProjectLead": "Project lead — leads and above",
    "settings.commentPermissions.createOptionMaintainer": "Maintainer — most restrictive",
    "settings.commentPermissions.resolveOptionCommenter": "Commenter — anyone who can comment",
    "settings.commentPermissions.resolveOptionReviewer": "Reviewer — reviewers and above",
    "settings.commentPermissions.resolveOptionContributor": "Contributor — default",
    "settings.commentPermissions.resolveOptionProjectLead": "Project lead — leads and above",
    "settings.commentPermissions.resolveOptionMaintainer": "Maintainer — most restrictive",

    // ── UsageSection (Preferences → Usage) ──
    "settings.usage.historyLabel": "7-day audio history",
    "settings.usage.historyChartAriaLabel": "7-day audio history bar chart",
    "settings.usage.noData": "No usage recorded yet.",
    "settings.usage.audioGeneratedToday": "Audio generated today",
    "settings.usage.aiRequestsToday": "AI requests today",
    // "This week" group label → onboarding.timeWindow.thisWeek (identical text)
    // "Activity" row label → autopilot.inspector.activity.title (identical text)

    // ── Preferences.tsx — almost everything here already exists as
    // `onboarding.preferences.*` (that namespace's own comments say it mirrors
    // this exact page) or `common`/`language`/`nav`; only these two are new —
    "settings.preferences.workspace.sidebarLayoutLabel": "Editor sidebar tab layout",
    "settings.preferences.profile.otherInfoDescription":
      "Anything else that should shape the summaries you get. All fields are " +
      "optional and stored on this device.",

    // ── MondayOAuthCallback (/oauth/callback landing page) ──
    "settings.monday.callback.failedTitle": "Couldn't finish connecting to Monday.com",
    "settings.monday.callback.backToApp": "Back to Aquilla",
    "settings.monday.callback.connecting": "Connecting to Monday.com…",

    // ── OrgSettingsIdentity ──
    "settings.orgIdentity.nameDescription": "Shown across the organization.",
    "settings.orgIdentity.deleteOrganization": "Delete organization",
    "settings.orgIdentity.deleteRowDescription":
      "Permanently delete this organization and everything that belongs only to it. Projects must be removed first.",
    "settings.orgIdentity.deleteConfirmBody":
      "This permanently deletes {name}, including its members, invites, and connections. This cannot be undone.",
    "settings.orgIdentity.deleteBlockedProjects":
      "This organization still has projects. Remove them before deleting the organization.",
    "settings.orgIdentity.deleteFailed": "Couldn't delete this organization.",
    // "Organization name" (label, sr-only FieldLabel, placeholder) →
    // org.createDialog.nameLabel (identical text)
    // "Danger zone" → settings.teamSettings.dangerZoneLabel (identical text)
    // "Delete '{name}'?" → org.teamDetail.deleteConfirmTitle (identical text)
    // "Deleting…" → org.teamDetail.deletingButton (identical text)
    // "Confirm" → common.confirm, "Cancel" → common.cancel

    // ── OrgSettingsIndex ──
    // Rendered via <RichMessage> so the embedded <Link to="/preferences"> stays
    // a real, routable link rather than being flattened into plain text; {link}
    // renders `t("nav.account.preferences")` inside the anchor.
    "settings.orgSettingsIndex.description": "Manage this organization. Personal preferences moved to {link}.",
    "settings.orgSettingsIndex.navIdentity": "Identity",
    "settings.orgSettingsIndex.navSecurity": "Security",
    "settings.orgSettingsIndex.navGroupPeopleProjects": "People & projects",
    // "Organization settings" page title → editor.navTitle.organizationSettings (identical text)
    // "Organization" nav-group label → onboarding.apiTokens.orgLabel (identical text;
    //   org.breadcrumb.organizationFallback already holds the documented exception
    //   against that key, so reusing it here — rather than minting a third key
    //   for the same word — keeps the collision group at its existing size)
    // "AI provider keys" nav row → onboarding.preferences.section.providerKeys.title (identical text)
    // "Members" nav row → editor.navTitle.members (identical text)
    // "Teams" nav row → editor.navTitle.teams (identical text)
    // "Archived projects" nav row → editor.navTitle.archivedProjects (identical text)

    // ── OrgSettingsMonday (org settings → Monday.com) ──
    "settings.monday.connectedNotice": "Monday.com connected.",
    "settings.monday.dismissNoticeAriaLabel": "Dismiss notice",
    "settings.monday.connectFailed": "Connecting to Monday.com failed. Try again.",
    // Plain-language reasons a Monday.com connection failed, shown on the
    // /oauth/callback page and in the org settings notice (lib/monday/oauth-return.ts).
    "settings.monday.failure.cancelled": "Connecting was cancelled in Monday.com, so nothing was connected.",
    "settings.monday.failure.expired":
      "This connection request expired. It has to be approved in Monday.com within 10 minutes. Start again from Aquilla.",
    "settings.monday.failure.rejected": "Monday.com didn't accept the approval. Try connecting again.",
    "settings.monday.failure.timeout":
      "No word from the Monday.com tab. If you approved there, reload this page; otherwise connect again.",
    "settings.monday.connectionCardTitle": "Connection",
    "settings.monday.loadingStatus": "Loading connection status…",
    "settings.monday.reauthExpiredNotice":
      "The Monday.com authorization has expired (Monday limits it to 6 months). " +
      "Reconnect to resume syncing — board links and mappings are kept.",
    "settings.monday.reconnectButton": "Reconnect",
    "settings.monday.connectedAsRow": "Connected as {username}",
    "settings.monday.connectedOnRow": "Connected {date}",
    "settings.monday.connectedAsOnRow": "Connected as {username} on {date}",
    "settings.monday.disconnectButton": "Disconnect",
    "settings.monday.openMondayButton": "Open Monday.com",
    "settings.monday.connectPrompt":
      "Connect a Monday.com account to let projects in this organization link " +
      "boards and push translation progress automatically.",
    // "Connect Monday.com" button → projectSettings.monday.connectButton. Both
    // this page and the project setup wizard start the SAME org-level OAuth
    // connection (the wizard passes the same orgId), so this is one action with
    // one label, not two that happen to share wording.
    "settings.monday.connectRestrictedNotice": "Ask an org maintainer or owner to connect Monday.com.",
    "settings.monday.awaitingOAuthNotice":
      "Waiting for the Monday.com tab… this page updates automatically once the connection completes.",
    "settings.monday.adminStepDialogTitle": "Connect to Monday.com",
    "settings.monday.adminStepDialogDescription":
      "Installing the Aquilla app requires admin permissions in your Monday.com workspace. " +
      "Are you an admin there?",
    "settings.monday.isAdminOptionLabel": "Yes, I'm a Monday admin",
    "settings.monday.isAdminOptionDescription":
      "Continue to Monday.com in a new tab to install and authorize Aquilla.",
    "settings.monday.notAdminOptionLabel": "No — my admin needs to install it",
    "settings.monday.notAdminOptionDescription":
      "Copy the install link and send it to your Monday admin. Once they've " +
      "installed the Aquilla app, come back here and connect.",
    "settings.monday.addToMondayAlt": "Add to monday.com",
    "settings.monday.disconnectConfirmTitle": "Disconnect Monday.com?",
    "settings.monday.disconnectConfirmBody":
      "This removes the connection for the whole organization. Every " +
      "project's board link and sync configuration will be deleted. This cannot be undone.",
    // ── Org settings → Airtable (AQU-804) ──
    "settings.airtable.navHint": "Table sync",
    "settings.airtable.connectedBadge": "Connected",
    "settings.airtable.notConnectedBadge": "Not connected",
    "settings.airtable.connectPrompt":
      "Paste a personal access token from Airtable to connect. Projects can then link a table and push their progress into it.",
    "settings.airtable.connectRestrictedNotice": "Ask an org maintainer or owner to connect Airtable.",
    "settings.airtable.tokenLabel": "Personal access token",
    "settings.airtable.tokenHelp":
      "Create one in Airtable with the scopes {scopes}, and give it access to the base you track progress in. Aquilla keeps it encrypted and never shows it again.",
    "settings.airtable.createTokenLink": "Create a token in Airtable",
    "settings.airtable.connectButton": "Connect Airtable",
    "settings.airtable.saveTokenButton": "Save new token",
    "settings.airtable.replaceTokenButton": "Replace token",
    "settings.airtable.openAirtableButton": "Open Airtable",
    "settings.airtable.connectedNotice": plural({
      one: "Airtable connected. The token can see {count} base.",
      other: "Airtable connected. The token can see {count} bases.",
    }, "count"),
    "settings.airtable.tokenRejectedNotice":
      "Airtable no longer accepts the saved token, so progress isn't being pushed. Paste a new token to keep syncing.",
    "settings.airtable.otherDeploymentNotice":
      "This connection was made on another Aquilla deployment and can't be used here. Paste a token to connect this one.",
    "settings.airtable.disconnectConfirmTitle": "Disconnect Airtable?",
    "settings.airtable.disconnectConfirmBody":
      "This removes the connection for the whole organization. Every project's table link and sync configuration will be deleted; the tables and their records stay in Airtable.",
    // "Account:" prefix → auth.resetPassword.accountPrefix (identical text, same
    //   "label: value" call-site pattern already used in ResetPassword.tsx)
    // "Cancel" → common.cancel (identical text)

    // ── OrgSettingsShell / TeamSettingsShell (no-org empty states) ──
    "settings.orgSettingsShell.description":
      "Organization settings are managed within a single organization. Choose one from the switcher to continue.",
    "settings.teamSettingsShell.description":
      "Team settings are managed within a single organization. Choose one from the switcher to continue.",
    // "Select an organization" title (both shells) → org.teamsList.selectOrgTitle (identical text)

    // ── TeamSettingsIndex ──
    "settings.teamSettings.title": "Team settings",
    "settings.teamSettings.description": "Manage this team's name, description, and membership grants.",
    "settings.teamSettings.nameRowDescription": "Shown on the team page and in organization lists.",
    "settings.teamSettings.descriptionSummary": "A short summary shown on the team page.",
    "settings.teamSettings.descriptionPlaceholder": "Add a description…",
    "settings.teamSettings.dangerZoneLabel": "Danger zone",
    "settings.teamSettings.deleteTeamRowDescription":
      "Permanently remove this team and all of its project grants. Members keep their org roles.",
    // "Team name" (label, sr-only FieldLabel, placeholder) → org.teamForm.nameLabel (identical text)
    // "Description" (heading, sr-only FieldLabel) → nav.report.descriptionFieldLabel (identical text)
    // "Team not found." → org.teamDetail.notFoundTitle (identical text)
    // its description → org.teamDetail.notFoundDescription (identical text)
    // "Delete team" (row label + button) → org.teamDetail.deleteTeamButton (identical text)
    // "Delete '{name}'?" confirm-dialog title → org.teamDetail.deleteConfirmTitle (identical text)
    // "This removes the team and all its grants." → org.teamDetail.deleteConfirmBody (identical text)
    // "Cancel" → common.cancel (identical text)

    // AQU-2260: why a setting is locked, said once where you will see it.
    "settings.locked.section": "Only {role} can change these settings.",
    "settings.locked.control": "Only {role} can change this.",
    "settings.locked.page": "Only {role} can change {section}.",
    "settings.locked.viewOnly": "View only",
  },
  context: {
    _context: {
      description:
        "Account, organization and team settings surfaces: the Preferences screens, " +
        "organization settings (including the Monday.com integration), team settings, " +
        "and personal AI-provider configuration. Read by an administrator or an " +
        "individual user configuring how the product behaves for them — not while " +
        "translating. Prefer settled, formal register over conversational phrasing.",
      screenshot: "project-settings",
    },
    keys: {
      "settings.preferences.recording.followsYou": {
        description:
          "Second sentence of the Preferences → Recording page's description, shown when signed " +
          "in. 'They' are the recorder's and the timeline's settings on that page. 'Device' is a " +
          "computer, tablet or phone.",
      },
      "settings.preferences.recording.thisDeviceOnly": {
        description:
          "Second sentence of the Preferences → Recording page's description, shown when not " +
          "signed in. 'They' are the recorder's and the timeline's settings on that page.",
      },
      "settings.preferences.recording.hint.followsYou": {
        description:
          "Short grey hint at the right of the Recording row in Preferences, when signed in: " +
          "these settings go with the person to every device.",
        maxLength: 24,
      },
      "settings.preferences.recording.hint.thisDevice": {
        description:
          "Short grey hint at the right of the Recording row in Preferences, when not signed in: " +
          "these settings are kept on this computer only.",
        maxLength: 24,
      },
      "settings.preferences.recording.recorderGroup": {
        description:
          "Heading over the recorder's settings in Preferences → Recording. 'Recorder' is the " +
          "window that records a line with the microphone. A noun.",
      },
      "settings.preferences.recording.formatWav": {
        description: "A choice of recording format: WAV audio files. Usually kept as 'WAV'.",
        maxLength: 12,
      },
      "settings.preferences.recording.formatCompressed": {
        description: "A choice of recording format: smaller, compressed audio files. An adjective.",
        maxLength: 16,
      },
      "settings.preferences.recording.formatInfo": {
        description:
          "Opens under 'Recording format' when its (i) is clicked. 'WAV / COMPRESSED' names the " +
          "button in the recorder that shows the same setting; keep it as it is shown there.",
      },
      "settings.moved.note": {
        description:
          "A quiet line left for a few weeks where a setting used to be, saying where it lives now. " +
          "Followed by a 'Go to it' link (settings.moved.goThere).",
        placeholders: {
          where: "The setting's new home as a path of already-translated page names joined by ' → ', e.g. 'Preferences → General'.",
        },
      },
      "settings.locked.section": {
        description:
          "One line at the top of a settings card the reader cannot change, saying who can. " +
          "Shown once for the whole card, instead of a note on every greyed-out control in it. " +
          "A sentence, with its period.",
        placeholders: {
          role: "Plural role name, already translated, e.g. 'Maintainers' or 'Project leads'.",
        },
      },
      "settings.locked.control": {
        description:
          "One short line beneath a single greyed-out setting the reader cannot change, saying " +
          "who can. 'this' is that one setting. A sentence, with its period.",
        placeholders: {
          role: "Plural role name, already translated, e.g. 'Maintainers' or 'Project leads'.",
        },
      },
      "settings.locked.page": {
        description:
          "One line at the top of an organization settings page the reader can open but not " +
          "change, e.g. 'Only Owners can change Security.' The page stays readable, so people " +
          "can see how things are set and ask for a change. A sentence, with its period.",
        placeholders: {
          role: "Plural role name, already translated, e.g. 'Owners' or 'Maintainers'.",
          section: "The settings page's own title, already translated, e.g. 'Security'.",
        },
      },
      "settings.locked.viewOnly": {
        description:
          "Short note beside a page's name in the organization settings list, for a page the " +
          "reader can open and read but not change. Two words if possible.",
        maxLength: 16,
      },
      "settings.transcription.model.supports": {
        description: "Tick line on a transcription model's row: the model knows the project's language.",
        placeholders: { language: "The project's language name, e.g. 'Tok Pisin'." },
      },
      "settings.transcription.model.doesNotSupport": {
        description: "Cross line on a transcription model's row: the model does not know the project's language.",
        placeholders: { language: "The project's language name, e.g. 'Tok Pisin'." },
      },
      "settings.transcription.model.seeAll": {
        description: "Disclosure that opens a searchable list of every language a transcription model knows.",
        placeholders: { count: "How many languages, a plain number, e.g. '99'." },
      },
      "settings.transcription.model.examples": {
        description:
          "Under the zero-shot model: how many recorded and transcribed takes in this project it can learn from (at most 10).",
        placeholders: { count: "A plain number from 0 to 10." },
      },
      "settings.transcription.zeroShot.warmupTitle": {
        description:
          "Persistent toast title while the zero-shot speech-recognition model starts on the " +
          "server, shown above a progress bar. The time is an estimate.",
      },
      "settings.transcription.zeroShot.examplesFailed": {
        description: "Error when the project's example recordings for zero-shot transcription fail to load.",
        placeholders: { status: "The HTTP status code, a plain number (data), e.g. '503'." },
      },
      "settings.transcription.zeroShot.batchTitle": {
        description: "Confirmation toast title before transcribing several recordings with the zero-shot model.",
        placeholders: { count: "How many recordings the batch will transcribe, a plain number." },
      },
      "settings.transcription.zeroShot.batchShare": {
        description:
          "Estimated cost of a zero-shot transcription batch, as a share of the organization's " +
          "credits left this week. '≈' means approximately.",
        placeholders: { percent: "A whole-number percentage without the % sign, e.g. '12'." },
      },
      "settings.transcription.zeroShot.batchCredits": {
        description:
          "Estimated cost of a zero-shot transcription batch when the remaining balance is not visible. " +
          "'≈' means approximately.",
        placeholders: { credits: "An already-formatted credit amount, e.g. '40 cr'. Not translated." },
      },
      "settings.localLlm.detectedOne": {
        description:
          "Confirmation shown under the Model field after \"Detect models\" finds exactly " +
          "one model at the local endpoint and auto-fills it into the field.",
        placeholders: {
          model: "The detected model id, e.g. 'qwen/qwen2.5-coder-14b' or 'llama3'. Not translated.",
        },
      },
      "settings.structuralCells.resetTitle": {
        description:
          "Title of the dialog shown after an org maintainer changes the " +
          "heading-counting default, when some projects have set their own " +
          "value and will therefore ignore it. {count} is how many. Asked " +
          "only when that number is above zero.",
        placeholders: { count: "How many projects override the org default." },
      },
      "settings.structuralCells.resetDescription": {
        description:
          "Body of that same dialog, explaining that those projects keep " +
          "their own answer unless reset. The confirm button clears their " +
          "setting so they follow the organization again; the cancel button " +
          "leaves them alone. Pluralized on the same count as the title, " +
          "which it does not print — only 'it' versus 'them' changes.",
      },
      "settings.validationDefaults.textDescription": {
        description:
          "Help text under the 'Required validators (text)' row on the organization's " +
          "Project defaults page. A number picker (1 to 15) sits beside it.",
      },
      "settings.validationDefaults.audioDescription": {
        description:
          "Help text under the 'Required validators (audio)' row on the same page, " +
          "for recordings instead of translations.",
      },
      "settings.validationDefaults.resetTitle": {
        description:
          "Title of the dialog shown after an org maintainer changes one of these " +
          "numbers, when some projects set their own number and will ignore it. " +
          "Asked only when that number of projects is above zero.",
        placeholders: { count: "How many projects set their own number." },
      },
      "settings.validationDefaults.resetDescription": {
        description:
          "Body of that dialog. The confirm button clears those projects' own " +
          "number so they follow the organization; the cancel button leaves them alone.",
      },
      "settings.keyInUse.platform": {
        description:
          "Beside an AI key field or provider choice (Project settings → AI, Preferences, the Set up AI dialog): " +
          "drafts currently go to the platform's own AI, which needs no key of yours.",
        placeholders: { name: "The platform provider's product name, 'Frontier'. Not translated." },
      },
      "settings.keyInUse.prefsNone": {
        description:
          "Under 'AI provider (advanced)' in Preferences → AI provider keys, when the person has saved no provider " +
          "of their own: projects then use the platform's AI unless the project set its own provider.",
        placeholders: { name: "The platform provider's product name, 'Frontier'. Not translated." },
      },
      "settings.overrideStatus.allFollow": {
        description:
          "Small status line under an organization default on the Project defaults page " +
          "(validations needed, counting headings, timeline and recording settings). " +
          "Shown when no project has set its own value, so every project uses this default " +
          "and changing it asks no follow-up question.",
      },
      "settings.overrideStatus.someOwnNumber": {
        description:
          "Same status line when some projects set their own number for this default " +
          "(e.g. how many validators are required) and so ignore it. A 'Reset to default' " +
          "link follows it after a middle dot.",
        placeholders: { count: "How many projects set their own number." },
      },
      "settings.overrideStatus.someOwnSetting": {
        description:
          "Same status line for on/off or choice defaults (counting headings, timing lock, " +
          "who may add rows…) when some projects set their own value and ignore the default. " +
          "A 'Reset to default' link follows it after a middle dot.",
        placeholders: { count: "How many projects set their own setting." },
      },
      "settings.overrideStatus.someStricter": {
        description:
          "Status line under the organization's 'who can see the member list' and 'who can see " +
          "member progress' settings (Settings → Security). A project may only make these stricter " +
          "(hide more), never looser; this says how many projects in the organization chose to. " +
          "There is no reset: a stricter project is a deliberate choice.",
        placeholders: {
          count: "Whole number of projects, 1 or more.",
        },
      },
      "settings.overrideStatus.reset": {
        description:
          "Link after that status line. It opens a confirmation asking whether those " +
          "projects should go back to following the organization's default.",
      },
      "settings.overrideStatus.andMore": {
        description:
          "Last line of the list that opens when someone clicks one of the status lines above " +
          "(e.g. '2 projects set their own number'). The list names those projects, one per " +
          "line, each a link to that project; this line counts the ones not named — because " +
          "the list stops at 50, or because the person may not see some of those projects. " +
          "Lower-case 'and': it continues the list of names above it.",
        placeholders: {
          count: "Whole number of projects not named in the list, 1 or more.",
        },
      },
      "settings.mediaDefaults.groupLabel": {
        description:
          "Heading of a group on the organization's Project defaults page holding the timeline and recording defaults " +
          "(timing lock, track editing, who may add and remove lines, recording validation).",
      },
      "settings.mediaDefaults.timingLockedDescription": {
        description: "Help text under the timing-lock row in that group. An on/off switch sits beside it.",
      },
      "settings.mediaDefaults.allowTrackEditingDescription": {
        description: "Help text under the timeline-track-editing row in that group. An on/off switch sits beside it.",
      },
      "settings.mediaDefaults.cellEditingFloorDescription": {
        description: "Help text under the 'Who can add and remove cells' row in that group. A role picker sits beside it.",
      },
      "settings.mediaDefaults.allowSelfValidationAudioDescription": {
        description: "Help text under the 'Allow validating your own recordings' row in that group. An on/off switch sits beside it.",
      },
      "settings.mediaDefaults.validationRoleFloorAudioDescription": {
        description: "Help text under the 'Minimum role to validate recordings' row in that group. A role picker sits beside it.",
      },
      "settings.mediaDefaults.resetDescription": {
        description:
          "Body of the dialog shown after an org maintainer changes one of these defaults, when some projects set their " +
          "own value and will ignore it. The confirm button clears those projects' own value so they follow the " +
          "organization; the cancel button leaves them alone. Pluralized on how many projects.",
      },
      "settings.personalProvider.trailingPathHint": {
        description:
          "Hint under the personal AI-provider endpoint field, rendered with " +
          "<RichMessage> so the two path fragments keep monospace styling. " +
          "Explains that the endpoint URL may or may not include a trailing " +
          "API path segment.",
        placeholders: {
          v1Path: "Literal, not-translated API path fragment: '/v1'.",
          chatCompletionsPath: "Literal, not-translated API path fragment: '/chat/completions'.",
        },
      },
      "settings.personalProvider.authHeaderHint": {
        description:
          "Hint under the personal AI-provider API-key field, rendered with " +
          "<RichMessage> so the header name/format keeps monospace styling.",
        placeholders: {
          authHeader: "Literal, not-translated HTTP header example: 'Authorization: Bearer …'.",
        },
      },
      "settings.orgSettingsIndex.description": {
        description:
          "Subtitle under the 'Organization settings' page heading, rendered with " +
          "<RichMessage> so {link} stays a real, routable link to /preferences " +
          "rather than flattening into plain text.",
        placeholders: {
          link:
            "A <Link> element whose visible text is the 'Preferences' string " +
            "(reused from nav.account.preferences) — not a plain value.",
        },
      },
      "settings.orgIdentity.deleteConfirmBody": {
        description:
          "Body of the confirm dialog that deletes an organization. Names the " +
          "organization so the owner can see which workspace they are about to remove.",
        placeholders: {
          name: "The organization's name — not translated.",
        },
      },
      "settings.notifications.groupLabel": {
        description:
          "Card heading over the single comment-email control on the "
          + "Preferences → Notifications page.",
        maxLength: 28,
      },
      "settings.notifications.commentEmailLabel": {
        description:
          "Label of the dropdown that chooses how much comment email the "
          + "signed-in user receives.",
        maxLength: 40,
      },
      "settings.notifications.commentEmailDescription": {
        description:
          "Help text under the comment-email dropdown. Explains what the "
          + "setting covers and reassures the reader that thread grouping is "
          + "not something they have to turn on.",
      },
      "settings.notifications.option.all": {
        description:
          "Dropdown option: send email for every @-mention AND every reply on "
          + "a thread the user is part of. The noisiest of the three.",
        maxLength: 36,
      },
      "settings.notifications.option.mentions": {
        description:
          "Dropdown option, and the default: send email only when someone "
          + "@-mentions this user in a comment. '@-mentions' refers to typing "
          + "@username in a comment — keep the @ symbol.",
        maxLength: 36,
      },
      "settings.notifications.option.off": {
        description:
          "Dropdown option: send no comment email at all. One word if the "
          + "language allows it.",
        maxLength: 20,
      },
      "settings.notifications.loadFailed": {
        description:
          "Inline error shown in place of the dropdown when the current "
          + "setting could not be read from the server.",
      },
      "settings.notifications.saveFailed": {
        description:
          "Inline error shown under the dropdown when saving the chosen "
          + "setting failed; the dropdown reverts to its previous value.",
      },
      "settings.notifications.section.title": {
        description:
          "Nav row title and page heading for the Notifications section of "
          + "personal Preferences.",
        maxLength: 24,
      },
      "settings.notifications.section.description": {
        description:
          "One-line summary under the Notifications nav row on the "
          + "Preferences index, telling the reader what the section holds.",
      },
      "settings.monday.dismissNoticeAriaLabel": {
        description:
          "Accessible name for the small ✕ icon button that dismisses the " +
          "connected/error notice banner after a Monday.com OAuth round trip. " +
          "The button shows only the ✕ glyph, no visible text.",
      },
      "settings.usage.historyChartAriaLabel": {
        description:
          "Accessible description of the 7-day bar-chart container in the " +
          "Usage preferences section (each individual bar has its own tooltip " +
          "and aria-label with that day's value). Distinct from the visible " +
          "'7-day audio history' heading above it — this one names the chart " +
          "as a chart, for a screen-reader user who can't see the bars.",
      },
      "settings.monday.failure.cancelled": {
        description:
          "Why connecting Monday.com failed: the person cancelled or declined on Monday's " +
          "approval screen. Shown on the page Monday returns to and in a red notice on " +
          "the organization's Monday.com settings.",
      },
      "settings.monday.failure.expired": {
        description:
          "Why connecting Monday.com failed: the approval came back more than 10 minutes " +
          "after it was started (or the same approval link was used twice). Shown on the " +
          "page Monday returns to and in a red notice on the organization's Monday.com settings.",
      },
      "settings.monday.failure.rejected": {
        description:
          "Why connecting Monday.com failed: Monday refused to hand over access after the " +
          "person approved. Shown on the page Monday returns to and in a red notice on the " +
          "organization's Monday.com settings.",
      },
      "settings.monday.failure.timeout": {
        description:
          "Red notice in the tab that opened Monday.com for connecting, when 11 minutes " +
          "pass with no word from the Monday tab. \"Reload this page\" means the current " +
          "Aquilla settings page.",
      },
      "settings.monday.openMondayButton": {
        description:
          "Button on the organization's Monday.com settings, beside Disconnect, shown once " +
          "an account is connected. Opens the connected Monday.com account's home page in a " +
          "new tab. \"Monday.com\" is a product name and is not translated.",
      },
      "settings.monday.connectedAsRow": {
        description:
          "Row on the Monday.com (or Airtable — AQU-804) connection card naming the connected user.",
        placeholders: {
          username: "The connected account's display username, or for Airtable its email. Not translated.",
        },
      },
      "settings.airtable.tokenHelp": {
        description:
          "Help under the Airtable personal-access-token field, followed by a 'Create a token in Airtable' link.",
        placeholders: {
          scopes: "Airtable scope names, comma-separated, exactly as Airtable spells them (e.g. 'data.records:read'). Never translated.",
        },
      },
      "settings.airtable.connectedNotice": {
        description: "Confirmation after an Airtable token was accepted and saved for the organization.",
        placeholders: { count: "How many Airtable bases the token can see, a whole number." },
      },
      "settings.monday.connectedOnRow": {
        description:
          "Row on the Monday.com connection card giving the date the connection was made.",
        placeholders: {
          date: "A locale-formatted date string (already localized by the caller before interpolation).",
        },
      },
      "settings.monday.connectedAsOnRow": {
        description:
          "Row on the Monday.com (or Airtable — AQU-804) connection card: who connected it and when.",
        placeholders: {
          username: "The connected account's display username, or for Airtable its email. Not translated.",
          date: "A locale-formatted date string (already localized by the caller before interpolation).",
        },
      },
    },
  },
  surfaces: [],
})
