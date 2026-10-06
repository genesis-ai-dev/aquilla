import { defineNamespace, plural } from "./types"

/**
 * `projectSettings` namespace — registered up front by the swarm orchestrator so parallel
 * agents fill only this file and never contend on the `messages/en.ts` barrel.
 *
 * Every key here MUST be prefixed `projectSettings.` — the namespace's name is derived
 * from its first key, not from the filename.
 *
 * Covers: ProjectCreateDialog.tsx, SharePanel.tsx, ProjectSettings.tsx and its
 * ProjectSettings/* sub-panels (SettingsNav, ValidationSettingsSection,
 * DecaySettingsSection, AudioMediaStrategySection, SourceLinkSection,
 * LanguagesSection), and the shared PermissionDeniedAlert component's
 * project-settings-originated action/role-floor keys.
 */
export const projectSettings = defineNamespace({
  keys: {
    // ── Permission-denied (shared component, project-settings call sites) ──
    "projectSettings.permission.changeSharedSettingsAction": "change shared settings",
    "projectSettings.permission.roleOrHigher": "{role} or higher",
    "projectSettings.permission.editSharedSettingsRequiresRole": "{roleFloor} can edit shared settings.",
    "projectSettings.permission.renameRequiresRole": "{roleFloor} can rename this project.",
    "projectSettings.permission.reconnectToEdit": "Reconnect to edit shared settings.",
    "projectSettings.permission.onlyRoleCanModify": "Only {role} can modify",
    "projectSettings.permission.viewPrivilegedMembers": "View {role}",
    "projectSettings.permission.privilegedDialogTitle": "Project {role}",
    "projectSettings.permission.privilegedDialogDescription":
      "{role} can change shared settings, members, and other project configuration.",
    "projectSettings.permission.privilegedDialogEmpty": "No {role} on this project.",
    "projectSettings.permission.privilegedDialogError": "Couldn't load {role}.",

    // ── Project creation dialog ──
    "projectSettings.create.trigger": "New Project",
    "projectSettings.create.dialogTitle": "Create New Project",
    // AQU-1352: destination picker at the top of the create dialog.
    "projectSettings.create.destinationLabel": "Create in",
    "projectSettings.create.destinationPersonal": "Personal",
    "projectSettings.create.destinationThisOrg": "this organization",
    "projectSettings.create.destinationRoleHint":
      "You're a {role} in {org}, so you can't create projects there. You can create one in Personal.",
    "projectSettings.create.destinationNotAllowedHint":
      "You can't create projects in {org}. You can create one in Personal.",
    "projectSettings.create.destinationLoadError":
      "Couldn't load where you can create projects. Close this dialog and try again.",
    "projectSettings.create.createdToast": "Created {name} in {destination}",
    // AQU-1352 P2: teams multi-select under the destination picker.
    "projectSettings.create.teamsLabel": "Teams",
    "projectSettings.create.teamsPlaceholder": "Choose teams",
    "projectSettings.create.teamsSearch": "Search teams",
    "projectSettings.create.teamsEmpty": "No teams found.",
    "projectSettings.create.teamsRequiredHint": "Pick a team you lead. The project will belong to that team.",
    "projectSettings.create.teamsRequiredError": "Choose at least one team to create this project in.",
    // AQU-832: create.nameLabel/sourceLanguageLabel still reuse
    // projectSettings.info.{nameLabel,sourceLanguageLabel}. Target label is
    // create-dialog-only and stays "Target Language(s)" for any lane count.
    "projectSettings.create.namePlaceholder": "My Translation Project",
    "projectSettings.create.sourceLanguagePlaceholder": "English, Grade 7 English, es-419…",
    "projectSettings.create.targetLanguagesLabel": "Target Language(s)",
    "projectSettings.create.targetLanguagePlaceholder": "French, conversational Swahili, zh-Hant…",
    "projectSettings.create.additionalTargetPlaceholder": "Add another…",
    "projectSettings.create.addTargetLanguageAction": "Add another language",
    "projectSettings.create.bulkTargetLanguagesHint":
      "That's all {max} boxes. Add any remaining languages here, separated by commas.",
    "projectSettings.create.bulkTargetLanguagesPlaceholder":
      "Swahili, Yoruba, Hausa, zh-Hant…",
    "projectSettings.create.bulkTargetLanguagesCount": plural({
      one: "Adds {count} more lane.",
      other: "Adds {count} more lanes.",
    }),
    "projectSettings.create.languageHintAriaLabel": "What can I enter here?",
    "projectSettings.create.languageHintTooltip":
      "Any label works — a BCP-47 tag, a language name, or a register description " +
      "(e.g. \"Grade 7 English\", \"conversational Swahili\").",
    "projectSettings.create.advancedShapeSummary": "Advanced: project shape",
    "projectSettings.create.shapeSelfContainedName": "Self Contained (Default)",
    "projectSettings.create.shapeSelfContained": plural({
      one: "{name} — this project owns both its source and its target.",
      other: "{name} — this project owns both its source and its targets.",
    }),
    "projectSettings.create.shapeLinkedTargetName": plural({
      one: "Linked Target",
      other: "Linked Targets",
    }),
    "projectSettings.create.shapeLinkedTarget": plural({
      one:
        "{name} — this project reads its source from another project and owns only its target.",
      other:
        "{name} — this project reads its source from another project and owns only its targets.",
    }),
    // Mode is implied by shape (self-contained → optional clone; linked-target → live).
    // These intros replace the old clone/live radio pair under Advanced.
    "projectSettings.create.cloneModeName": "Cloned",
    "projectSettings.create.cloneIntro":
      "Do you want to import a {mode} copy of another project? This will create a " +
      "one-time snapshot and then remain independent.",
    "projectSettings.create.liveModeName": "live",
    "projectSettings.create.liveIntro":
      "You are creating a {mode} copy. Your new project will be connected to the " +
      "upstream project, and fixes in the upstream project will automatically " +
      "propagate here.",
    "projectSettings.create.upstreamProjectLabel": "Upstream project",
    "projectSettings.create.upstreamProjectPlaceholder": "Choose a project to link from…",
    // AQU-1518: the upstream picker is a searchable combobox, not a
    // scroll-only dropdown.
    "projectSettings.create.upstreamProjectSearchPlaceholder": "Search projects…",
    "projectSettings.create.upstreamProjectSearchAriaLabel": "Search projects",
    "projectSettings.create.upstreamProjectNoMatches": "No projects match.",
    "projectSettings.create.upstreamProjectNone": "No upstream project",
    "projectSettings.create.linkConsumesLabel":
      "Which corpus should become this project's source?",
    "projectSettings.create.linkConsumesSourceName": "Its Source",
    "projectSettings.create.linkConsumesSource": plural({
      one:
        "{name} — sibling-translation case (this project translates the same original " +
        "text). For same-org sibling languages, a target lane on the upstream project " +
        "is the recommended shape instead.",
      other:
        "{name} — sibling-translation case (this project translates the same original " +
        "text). For same-org sibling languages, target lanes on the upstream project " +
        "are the recommended shape instead.",
    }),
    "projectSettings.create.linkConsumesTargetName": "One of its Targets",
    "projectSettings.create.linkConsumesTarget":
      "{name} — chain case (this project translates one of the upstream project's " +
      "targets, e.g. French → Chaluba).",
    "projectSettings.create.validationLinkConsumesRequired":
      "Choose which corpus should become this project's source",
    // ── AQU-1561: which of the upstream's files the new project brings in.
    // Same question the Source & sync link flow asks, so the list itself reuses
    // `projectSettings.linkSource.selectAllFiles` / `fileClashBadge` — only the
    // sentences around it differ, because a clone's one-time copy and a live
    // link's ongoing follow are different promises.
    "projectSettings.create.upstreamFilesLabel": "Files to bring in",
    "projectSettings.create.upstreamFilesLoading": "Loading that project's files…",
    "projectSettings.create.upstreamFilesLoadError":
      "Couldn't load that project's file list, so we can't say which files would " +
      "be brought in. Nothing has been created.",
    "projectSettings.create.upstreamFilesRetryButton": "Try again",
    "projectSettings.create.upstreamFilesNoneSelected":
      "Pick at least one file to bring in.",
    "projectSettings.create.upstreamFilesEmptyUpstream":
      "That project has no files yet, so none will be brought in now.",
    "projectSettings.create.upstreamFilesCount": plural({
      one: "{count} file will be brought into the new project.",
      other: "{count} files will be brought into the new project.",
    }),
    // The live case follows the upstream from here on, so whether the link is
    // whole-project or a fixed list decides what arrives LATER too.
    "projectSettings.create.upstreamFilesLiveAllNote":
      "The new project will follow the whole source project, so files it adds " +
      "later will arrive too.",
    "projectSettings.create.upstreamFilesLiveSubsetNote":
      "The new project will follow only the files you picked. Files the source " +
      "project adds later will not arrive on their own.",
    // A clone never syncs again, so there is no "later" to describe — only what
    // the one snapshot copies.
    "projectSettings.create.upstreamFilesCloneNote":
      "A copy is taken once, of the files you picked. The new project does not " +
      "follow the source project afterwards.",
    // "Creating…" busy label → common.creating (identical text)
    "projectSettings.create.submitCreatingAndLinking": "Creating & linking…",
    "projectSettings.create.submitCreate": "Create Project",
    "projectSettings.create.submitCreateAndLink": "Create & Link",
    "projectSettings.create.errorSignInRequired": "You need to be signed in to create a project.",
    "projectSettings.create.errorGeneric": "Failed to create project. Please try again.",
    "projectSettings.create.extraLanguagesWarning":
      "Project created; adding extra languages failed — add them in Settings → Languages.",
    "projectSettings.create.extraLanguagesDescription":
      "Optional — add more target languages for this project (e.g. dialect variants " +
      "or parallel drafts of the same source).",
    "projectSettings.create.extraLanguagesPlaceholder": "e.g. fr-CA",
    "projectSettings.create.extraLanguagesRemoveAriaLabel": "Remove {lang}",
    "projectSettings.create.extraLanguagesEmptyError": "Enter a language tag.",
    "projectSettings.create.extraLanguagesTooLongError": "Must be {max} characters or fewer.",
    "projectSettings.create.extraLanguagesDuplicatePrimaryError":
      "This is already the primary target language.",
    "projectSettings.create.extraLanguagesAlreadyAddedError": "Already added.",
    "projectSettings.create.validationTargetLanguageRequired": "Target language is required",
    "projectSettings.create.validationUpstreamProjectRequired": "Choose an upstream project",
    "projectSettings.create.laneRecommendationHeading": "Same source, new language?",
    "projectSettings.create.laneRecommendation":
      "{heading} Add it as a target lane on {projectName} instead — no separate " +
      "project to keep in sync.",
    "projectSettings.create.laneRecommendationAdding": "Adding lane…",
    "projectSettings.create.laneRecommendationAddButton": "Add as lane on {projectName}",
    "projectSettings.create.laneRecommendationSignInError":
      "You need to be signed in to add a lane.",
    "projectSettings.create.laneRecommendationEmptyTargetError":
      "Enter a target language above first.",
    "projectSettings.create.laneRecommendationAlreadyDefaultError":
      "\"{lane}\" is already {projectName}'s default target language.",
    "projectSettings.create.laneRecommendationAlreadyLaneError":
      "\"{lane}\" is already a lane on {projectName}.",
    "projectSettings.create.laneRecommendationSuccess":
      "Added \"{lane}\" as a lane on {projectName}. Open that project to start translating.",
    "projectSettings.create.laneRecommendationConflictError":
      "Someone else updated that project's settings just now. Try again.",
    "projectSettings.create.laneRecommendationForbiddenError":
      "You need maintainer access on {projectName} to add a lane there.",
    "projectSettings.create.laneRecommendationGenericError":
      "Couldn't add the lane. Please try again.",

    // ── Share panel ──
    "projectSettings.share.dialogTitle": "Share Project",
    "projectSettings.share.tabMembers": "Members",
    "projectSettings.share.tabInviteLink": "Invite link",
    "projectSettings.share.lockedHintOrg": "Remove from org to revoke",
    "projectSettings.share.lockedHintCreator": "Project creator",
    "projectSettings.share.emptySuggestionsHint":
      "All org members already have access to this project.",
    "projectSettings.share.inviteEmailInvalid":
      "Enter a valid email address, or leave blank for an open link.",
    "projectSettings.share.signInToInvite": "Sign in to create an invite link.",
    "projectSettings.share.createInviteFailed":
      "Couldn't create invite. You may not have permission, or the server is unreachable.",
    "projectSettings.share.inviteLinkReady": "Invite link ready. Send it to the recipient.",
    "projectSettings.share.copyUrlLabel": "Copy URL",
    "projectSettings.share.copied": "Copied!",
    "projectSettings.share.recipientJoinsAs":
      "The recipient signs in (or signs up) and is added as {role}.",
    "projectSettings.share.recipientJoinsAsFallbackRole": "a member",
    "projectSettings.share.singleUseNote":
      "This link is single-use — once redeemed, click {createAnotherLink} to generate " +
      "a fresh one for the next person.",
    "projectSettings.share.revokeBeforeRedeemedNote":
      "To revoke before it is redeemed, use the Active links list below.",
    "projectSettings.share.createAnotherLinkButton": "Create another link",
    // "Role" field label → common.roleLabel (identical text)
    "projectSettings.share.signInToCreateLink": "Sign in to create an invite link",
    "projectSettings.share.recipientEmailLabel": "Recipient email",
    // "(optional)" → common.optionalFieldNote (identical text)
    "projectSettings.share.emailPlaceholder": "name@example.com",
    "projectSettings.share.emailRestrictedNote":
      "Only an account with this email can redeem this link.",
    "projectSettings.share.openLinkNote":
      "Leave blank for an open link anyone signed in can redeem.",
    "projectSettings.share.linkExpiresLabel": "Link expires",
    "projectSettings.share.expiryOneDay": "1 day",
    "projectSettings.share.expirySevenDays": "7 days",
    "projectSettings.share.expiryThirtyDaysDefault": "30 days (default)",
    // "No expiry" → common.noExpiry (identical text)
    // "Creating…" button-busy label → common.creating (identical text)
    "projectSettings.share.createInviteLinkButton": "Create invite link",
    "projectSettings.share.loadingActiveLinks": "Loading active links…",
    "projectSettings.share.activeLinksHeading": "Active links",
    "projectSettings.share.openLinkConnector": "open link",
    // "Expires {date}" → common.expiresOn (identical text)
    // "Revoke" button → common.revoke (identical text)
    "projectSettings.share.revokeLinkAriaLabel": "Revoke this invite link",

    // ── Page chrome (nav, groups, save bar, discard dialog) ──
    "projectSettings.pageTitle": "Project settings",
    "projectSettings.pageDescription": "Configure this project. Changes apply to everyone with access.",
    "projectSettings.searchPlaceholder": "Search settings…",
    "projectSettings.searchAriaLabel": "Search settings",
    "projectSettings.backLinkLabel": "Settings",
    "projectSettings.breadcrumbEditor": "Editor",
    // "Save changes" → common.saveChanges (identical text)
    "projectSettings.moreSaveOptionsAriaLabel": "More save options",
    "projectSettings.saveAndClose": "Save and close",
    "projectSettings.closeWithoutSaving": "Close without saving",
    "projectSettings.unsavedChanges": "Unsaved changes",
    "projectSettings.settingsChangedElsewhere": "Settings changed elsewhere — refresh to reapply.",
    "projectSettings.dismissConflictAriaLabel": "Dismiss conflict notice",
    "projectSettings.noMatchingSettings": "No matching settings.",
    "projectSettings.discardDialogTitle": "Discard changes?",
    "projectSettings.discardDialogDescription":
      "You have unsaved changes to project settings. They will be lost if you leave now.",
    "projectSettings.keepEditing": "Keep editing",

    "projectSettings.save.noChanges": "No changes to save.",
    "projectSettings.save.savedShort": "Saved: {list}.",
    "projectSettings.save.savedMany": plural({
      other: "Saved {count} changes: {list}, +{more} more.",
    }),

    // ── Changed-field nouns (AQU-408 "Saved: X, Y, Z." delta message) ──
    // AQU-832: several concepts here reuse an existing FieldLabel/section key
    // instead of a duplicate lowercase noun (no-duplicates.test.ts hard-fails
    // on an unexcused 2+-key collision, and a case-only difference is never a
    // valid exception reason) — see the reused key named in each comment.
    "projectSettings.field.aiProvider": "AI provider",
    "projectSettings.field.endpoint": "endpoint",
    "projectSettings.field.apiKey": "API key",
    // AQU-646, keyed 2026-08-20.
    "projectSettings.field.apiKeyRequired": "API key *",
    "projectSettings.field.apiKeyPlaceholder": "Paste your API key",
    "projectSettings.field.apiKeyNoAuth": "Leave blank for no auth",
    "projectSettings.advancedLlm.modelPlaceholder": "Type a model id",
    "projectSettings.shared.lastEdited": "Last edited by {name} · {date}",
    "projectSettings.shared.lastEditedOn": "Last edited {date}",
    "projectSettings.shared.nameHint": "Shown across the workspace and project list.",
    "projectSettings.timeline.lockLabel": "Lock the timings against dragging",
    "projectSettings.timeline.lockHint":
      "On by default, and on for everyone \u2014 project leads included. The timings came from the client's own file, and a dragged chip moves a line for the whole team with nothing to compare it against afterwards. While this is on, the handles are gone from every imported line and cue; a line somebody added here still moves, and recordings can still be placed against their lines as usual. Only a maintainer can turn it off, and the timeline says so for as long as it is off.",
    "projectSettings.timeline.trackEditingLabel": "Let maintainers add and edit timeline tracks",
    "projectSettings.timeline.trackEditingHint":
      "Off by default. With this on, a maintainer can add extra tracks to a file's timeline, group them into folders, give them colours and delete them. Deleting a track deletes every recording on it, and asks first. Renaming a track and dragging one up or down the list are not affected by this \u2014 a maintainer can always do both. Turning this back off leaves every track exactly as it is and everything still plays; it only stops the tracks being changed.",
    "projectSettings.cellEditing.sectionTitle": "Content structure",
    "projectSettings.cellEditing.label": "Who can add and remove cells",
    "projectSettings.cellEditing.description":
      "Puts buttons on each row to insert or remove cells. Removing one also removes its " +
      "translations, recordings and comments; removing an imported cell always needs a " +
      "maintainer.",
    // Open-dropdown option text for the cell-editing floor select. FLOOR_LABEL
    // (src/pages/settings/constants.ts) supplies the shorter closed-trigger
    // word for each rung; "No one" is not a role, so it has no FLOOR_LABEL
    // entry and shows this string in both places. AQU-1068 (Matthew's review):
    // these were bespoke phrases ("Maintainers and project leads", "Anyone who
    // can edit") and are now the product's standard ladder, so a project admin
    // reads the same names here as on the Members panel.
    "projectSettings.cellEditing.optionNone": "No one — default",
    "projectSettings.cellEditing.optionCommenter": "Commenter (200)",
    "projectSettings.cellEditing.optionReviewer": "Reviewer (300)",
    "projectSettings.cellEditing.optionContributor": "Contributor (400)",
    "projectSettings.cellEditing.optionProjectLead": "Project lead (500)",
    "projectSettings.cellEditing.optionMaintainer": "Maintainer (600)",
    // model → projectSettings.advancedLlm.modelLabel
    "projectSettings.field.temperature": "temperature",
    "projectSettings.field.healthPenalty": "health penalty",
    "projectSettings.field.examplesRetrieved": "examples retrieved",
    // context window → projectSettings.ai.contextWindowLabel
    "projectSettings.field.validatedExamplesOnly": "validated examples only",
    // reference example format → projectSettings.ai.referenceExampleFormatLabel
    "projectSettings.field.assistedLanguage": "assisted language",
    // AI completions batch size → projectSettings.ai.completionBatchSizeLabel
    // batch validation size → projectSettings.ai.validationBatchSizeLabel
    // project name → projectSettings.info.nameLabel
    // username → projectSettings.user.usernameLabel
    "projectSettings.field.decaySettings": "decay settings",
    "projectSettings.field.audioMediaStrategy": "audio media strategy",
    "projectSettings.field.autoSync": "auto-sync",
    "projectSettings.field.voiceApiKey": "voice API key",
    // source language → projectSettings.info.sourceLanguageLabel
    // target language → projectSettings.info.targetLanguageLabel
    // AI instructions → projectSettings.section.aiInstructions
    "projectSettings.field.validationCount": "validation count",
    "projectSettings.field.audioValidationCount": "audio validation count",
    "projectSettings.field.validationRoleFloor": "validation role floor",
    "projectSettings.field.namedValidators": "named validators",
    "projectSettings.field.selfValidation": "self-validation",
    "projectSettings.field.harmonizeMinRole": "harmonize min role",
    // Bible resources → projectSettings.section.bibleResources
    "projectSettings.field.usfmFrontMatter": "USFM front matter",
    // draft context → projectSettings.section.draftContext

    // ── Save-flow errors ──
    "projectSettings.save.nameRequired": "Enter a project name.",
    "projectSettings.save.signedOutRenameError": "You're signed out. Sign in again to rename this project.",
    "projectSettings.save.renameFailedGeneric": "Renaming the project failed.",
    "projectSettings.save.conflictToast": "Synced settings update from {username}.",
    "projectSettings.save.conflictFallbackUsername": "another collaborator",
    "projectSettings.save.conflictError": "Someone else updated shared settings. Refresh to reapply your edits.",
    "projectSettings.save.offlineError": "You're offline. Reconnect to save shared fields.",
    "projectSettings.save.sharedSettingsFailedGeneric": "Saving shared settings failed.",
    "projectSettings.save.projectNotFoundError": "Project not found",

    // ── Settings-group index (SETTINGS_GROUPS) ──
    // "General" group label → common.general (identical text)
    "projectSettings.group.generalDescription": "Name, languages, username, Bible resources",
    "projectSettings.group.sourceSyncLabel": "Source & sync",
    "projectSettings.group.sourceSyncDescription": "Linked source project, upstream changes, git sync",
    "projectSettings.group.aiLabel": "AI & completion",
    "projectSettings.group.aiDescription": "Instructions, draft context, provider, voice, terminology",
    "projectSettings.group.validationLabel": "Validation & health",
    "projectSettings.group.validationDescription": "Approvals, harmonization, staleness decay",
    // audio-media group label → projectSettings.section.audioMedia (identical text)
    "projectSettings.group.audioMediaDescription": "How audio is fetched from storage",
    // metrics group label → projectSettings.section.aiMetrics (identical text)
    "projectSettings.group.metricsDescription": "Post-edit distance and AI usage",
    "projectSettings.group.integrationsLabel": "Integrations",
    "projectSettings.group.integrationsDescription": "Monday.com board sync",
    // experimental group label → projectSettings.section.experimental (identical text)
    "projectSettings.group.experimentalDescription": "Early features, this device only",

    // ── Section labels (ALL_SECTIONS + reused as the matching card titles) ──
    "projectSettings.section.sourceLink": "Source link",
    "projectSettings.section.upstreamChanges": "Upstream changes",
    "projectSettings.section.dcsUpstream": "Door43 upstream",
    "projectSettings.section.projectInfo": "Project Info",
    "projectSettings.section.languages": "Languages",
    "projectSettings.section.bibleResources": "Bible resources",
    "projectSettings.section.import": "Import",
    "projectSettings.section.user": "User",
    "projectSettings.section.aiInstructions": "AI Instructions",
    "projectSettings.section.draftContext": "Draft Context",
    "projectSettings.section.advancedLlm": "Advanced LLM",
    "projectSettings.section.voice": "Voice",
    "projectSettings.section.localModels": "Local AI models",
    "projectSettings.section.decay": "Decay",
    "projectSettings.section.validation": "Validation",
    "projectSettings.section.audioMedia": "Audio Media",
    "projectSettings.section.gitSync": "Git Sync",
    "projectSettings.section.terminology": "Terminology",
    "projectSettings.section.termbaseSharing": "Term Base Sharing",
    "projectSettings.section.aiMetrics": "AI Metrics",
    "projectSettings.section.monday": "Monday.com",
    "projectSettings.section.experimental": "Experimental",

    // ── Project Info card ──
    "projectSettings.info.nameLabel": "Project Name",
    "projectSettings.info.lastEditedBy": "Last edited by {username} · {date}",
    "projectSettings.info.sourceLanguageLabel": "Source Language",
    "projectSettings.info.targetLanguageLabel": "Target Language",
    "projectSettings.info.smartQuotesLabel": "Smart quotes",
    "projectSettings.info.smartQuotesDescription": "Turn straight quotes into curly quotes as you type, in the target language's style. Press Backspace right after to keep a straight quote.",

    // ── Bible resources card ──
    "projectSettings.bible.enableLabel": "Enable Bible resources",
    "projectSettings.bible.description": "Scholarly reference data from bibletranslation.org in Search and the agent.",
    "projectSettings.bible.scriptureDefaultHint": "Available by default for scripture projects — turn off to disable.",
    "projectSettings.bible.nonScriptureDefaultHint": "Off by default for non-scripture projects — turn on to enable.",
    "projectSettings.bible.disabledHint": "Turned off for this project. This is always respected, even for scripture projects.",

    // ── Import card ──
    "projectSettings.import.excludeFrontMatterLabel": "Exclude USFM front matter",
    "projectSettings.import.excludeFrontMatterDescription":
      "When on, USFM imports drop the book name, running header, TOC, main title, and " +
      "introduction paragraphs. Section headings and Psalm titles still import. Off " +
      "(the default) imports front matter as translatable cells.",

    // ── User card ──
    "projectSettings.user.usernameLabel": "Username",
    "projectSettings.user.usernamePlaceholder": "local",
    "projectSettings.user.usernameDescription": "Used as author name in translation history.",

    // ── AI Instructions card ──
    "projectSettings.ai.instructionsHelp":
      "Describe what this project is producing and how translations should read — the " +
      "AI uses this on every completion. Use {sourceVar} and {targetVar} as placeholders.",
    "projectSettings.ai.topKLabel": "Examples retrieved (top_k)",
    "projectSettings.ai.topKDescription":
      "How many reference examples the AI retrieves per translation (1–20). Default: {defaultCount}.",
    "projectSettings.ai.completionBatchSizeLabel": "AI completions batch size",
    "projectSettings.ai.completionBatchSizeDescription":
      "How many untranslated cells one \"Run AI completions\" package drafts (1–50). " +
      "Run again to advance further. Default: {defaultSize}.",
    "projectSettings.ai.validationBatchSizeLabel": "Batch validation size",
    "projectSettings.ai.validationBatchSizeHelp":
      "How many eligible cells one \"Batch validate\" run approves (0–500). {zeroNote} " +
      "set a cap to validate in bounded batches.",
    "projectSettings.ai.validationBatchSizeZeroNote": "0 validates all eligible cells (default);",
    "projectSettings.ai.contextWindowLabel": "Context window",
    "projectSettings.ai.contextWindowSmall": "Small — tight window",
    "projectSettings.ai.contextWindowMedium": "Medium — paragraph (default)",
    "projectSettings.ai.contextWindowLarge": "Large — chapter",
    "projectSettings.ai.contextWindowDescription": "Controls how much surrounding passage context is included.",
    "projectSettings.ai.assistantLanguageLabel": "Assistant language",
    "projectSettings.ai.assistantLanguagePlaceholder": "e.g. English, Français, Español…",
    "projectSettings.ai.assistantLanguageDescription": "Language the AI assistant uses in chat responses. Independent of the UI locale.",
    "projectSettings.ai.approvedExamplesOnlyLabel": "Approved examples only",
    "projectSettings.ai.approvedExamplesOnlyDescription":
      "Drafting always retrieves human-validated project translations. Raw machine " +
      "drafts never enter the trusted example pool.",
    "projectSettings.ai.referenceExampleFormatLabel": "Reference example format",
    "projectSettings.ai.referenceExampleFormatSourceAndTarget": "Source + target (default)",
    "projectSettings.ai.referenceExampleFormatTargetOnly": "Target only",
    "projectSettings.ai.referenceExampleFormatDescription":
      "\"Target only\" shows only the target text of each example, useful when source " +
      "alignment is unavailable or undesirable. The model is told these are reference " +
      "translations to imitate.",

    // ── Draft Context card ──
    "projectSettings.draftContext.precedingCellsLabel": "Preceding committed-target cells",
    "projectSettings.draftContext.precedingCellsDescription":
      "How many immediately preceding committed target cells to include as discourse " +
      "left-context when drafting. 0 disables preceding-context. Default: {defaultCount}.",

    // ── Advanced LLM details ──
    "projectSettings.advancedLlm.summary": "Advanced LLM settings",
    "projectSettings.advancedLlm.frontierDefaultStatus": "Frontier (default)",
    "projectSettings.advancedLlm.customEndpointStatus": "Custom: {endpoint}",
    "projectSettings.advancedLlm.notSet": "not set",
    "projectSettings.advancedLlm.providerLabel": "Provider",
    "projectSettings.advancedLlm.providerFrontierName": "Frontier",
    "projectSettings.advancedLlm.providerFrontier":
      "{name} (recommended) — calls {domain} using your Frontier login. Works out of the box.",
    "projectSettings.advancedLlm.providerCustomName": "Custom endpoint",
    "projectSettings.advancedLlm.providerCustom":
      "{name} — localhost, self-hosted, or a third-party OpenAI-compatible API " +
      "(OpenRouter, OpenAI, Groq, Together, ...). Bring your own key.",
    "projectSettings.advancedLlm.presetLabel": "Provider preset",
    "projectSettings.advancedLlm.presetLocalLabel": "Local / self-hosted (no key)",
    "projectSettings.advancedLlm.presetCustomLabel": "Other (enter URL manually)",
    "projectSettings.advancedLlm.endpointLabel": "Endpoint URL",
    "projectSettings.advancedLlm.endpointPlaceholder": "http://localhost:8000",
    "projectSettings.advancedLlm.connectButton": "Connect",
    "projectSettings.advancedLlm.endpointHelp":
      "Base URL. Trailing {v1Path} or {chatCompletionsPath} is accepted.",
    "projectSettings.advancedLlm.connectedStatus": plural({
      one: "Connected — {count} model",
      other: "Connected — {count} models",
    }),
    "projectSettings.advancedLlm.endpointRequiredError": "Endpoint URL is required",
    "projectSettings.advancedLlm.apiKeyRequiredError": "API key is required for this endpoint",
    "projectSettings.advancedLlm.connectionFailedError": "Connection failed",
    "projectSettings.loadingLabel": "Loading project settings",
    "projectSettings.advancedLlm.apiKeyLabelRequired": "API key *",
    "projectSettings.advancedLlm.apiKeyLabelOptional": "API key (optional)",
    "projectSettings.advancedLlm.apiKeyPlaceholderRequired": "Paste your API key",
    "projectSettings.advancedLlm.apiKeyPlaceholderNoAuth": "Leave blank for no auth",
    "projectSettings.advancedLlm.apiKeyHelp": "Sent as Authorization: Bearer <key>. Stored in your browser; never uploaded to Frontier.",
    "projectSettings.advancedLlm.apiKeyDeviceOnlyNote": "Stays on this device — not shared with collaborators.",
    "projectSettings.advancedLlm.modelLabel": "Model",
    "projectSettings.advancedLlm.modelManualLabel": "Model (if not listed)",
    "projectSettings.advancedLlm.modelManualPlaceholderOpenRouter": "anthropic/claude-3.5-sonnet",
    "projectSettings.advancedLlm.modelManualPlaceholderGeneric": "Type a model id",
    "projectSettings.advancedLlm.modelManualHelp":
      "Click Connect to discover models, or type one manually (required for providers " +
      "that don't expose {modelsPath}).",
    "projectSettings.advancedLlm.modelOverrideLabel": "Model override (optional)",
    "projectSettings.advancedLlm.modelOverridePlaceholder": "Leave blank for Frontier's default",
    "projectSettings.advancedLlm.modelOverrideHelp": "Enter an OpenRouter model (optional), for example {example}.",
    "projectSettings.advancedLlm.maxTokensLabel": "Max Tokens",
    "projectSettings.advancedLlm.temperatureLabel": "Temperature ({value})",
    "projectSettings.advancedLlm.healthPenaltyLabel": "LLM Health Penalty ({percent}%)",
    "projectSettings.advancedLlm.healthPenaltyDescription":
      "LLM translations are penalized by this amount in health calculations. 0% = full " +
      "trust, 50% = heavy penalty. Default: 10%.",

    // ── Voice card ──
    "projectSettings.voice.geminiKeyLabel": "Gemini API key",
    "projectSettings.voice.geminiKeyPlaceholder": "AIza...",
    "projectSettings.voice.geminiKeyHelp":
      "Used for Gemini-powered text-to-speech. Get a key at aistudio.google.com/apikey. " +
      "Sent directly to Google; never uploaded to Frontier.",
    "projectSettings.voice.libraryNote": "Voice library and cast assignments live in the Voice Studio.",
    "projectSettings.voice.openStudioButton": "Open Voice Studio",

    // ── Local AI models card (device-shared; downloads managed in Preferences) ──
    "projectSettings.localModels.description":
      "Whisper transcription and the local voices run in your browser and are shared " +
      "across every project on this device. Manage downloads in your personal preferences.",
    "projectSettings.localModels.manageButton": "Manage models",

    // ── Harmonization card ──
    "projectSettings.harmonization.title": "Harmonization",
    "projectSettings.harmonization.minRoleLabel": "Minimum role to run a harmonization sweep",
    // AQU-832: no separate "Project Lead"/"Maintainer" role labels — resolved
    // via resolveRoleName()/common.role.* (roles.ts) at the call site instead
    // of minting duplicates. "(default)" is the only project-settings-owned text.
    "projectSettings.harmonization.defaultRoleSuffix": "{role} (default)",
    "projectSettings.harmonization.description":
      "Only users with at least this role can open a harmonization sweep on this " +
      "project. The floor cannot be lowered below Project Lead (hard floor per spec).",

    // ── Git Sync card ──
    "projectSettings.gitSync.originLabel": "Origin: {url} (branch: {branch})",
    "projectSettings.gitSync.autoSyncLabel": "Auto-sync every",
    "projectSettings.gitSync.minutesSuffix": "minutes (only when there are changes)",
    "projectSettings.gitSync.intervalNote": "Interval is floored at 1 minute. Sync will only push when there are local changes.",

    // ── Terminology card ──
    "projectSettings.terminology.title": "Terminology Library",
    "projectSettings.terminology.description": "Manage approved terms, renderings, and the project terminology (term base).",
    "projectSettings.terminology.openButton": "Open Terminology Library",

    // ── ValidationSettingsSection.tsx ──
    // Card headings: the text and audio rules each get their own card.
    "projectSettings.validation.textGroup": "Text validation",
    "projectSettings.validation.audioGroup": "Audio validation",
    "projectSettings.validation.requiredTextLabel": "Required validators (text)",
    "projectSettings.validation.requiredTextDescription": "Cells need this many distinct validators to count as validated.",
    "projectSettings.validation.requiredAudioLabel": "Required validators (audio)",
    "projectSettings.validation.requiredAudioAppliesNote": "Applies to audio translations, once recordings exist.",
    "projectSettings.validation.minRoleLabel": "Minimum validator role",
    "projectSettings.validation.minRoleDescription": "Only users with at least this role can cast a validation vote. Defaults to reviewer.",
    // ── StructuralCellsProjectSection ── AQU-1083
    "projectSettings.structuralCells.label": "Count headings as translatable content",
    "projectSettings.structuralCells.description":
      "Whether chapter headings, section titles and book names count toward " +
      "this project's translation and validation percentages. Leaving them " +
      "out means a book reads 100% once every verse is done.",
    "projectSettings.structuralCells.inherit": "Organization default",
    "projectSettings.structuralCells.currentlyCounting":
      "The organization currently counts them",
    "projectSettings.structuralCells.currentlyExcluding":
      "The organization currently leaves them out",
    "projectSettings.structuralCells.count": "Count them",
    "projectSettings.structuralCells.exclude": "Leave them out",
    "projectSettings.structuralCells.saveFailed": "Could not save that change",

    // AQU-1391 — repetition auto-propagation, same tri-state shape as above.
    "projectSettings.autoPropagateRepetitions.label": "Auto-propagate repetitions",
    "projectSettings.autoPropagateRepetitions.description":
      "Whether validating a cell copies its translation into the other cells in " +
      "the same file whose source text is identical. Filled-in cells are left " +
      "unvalidated, and cells someone has already validated are never changed.",
    "projectSettings.autoPropagateRepetitions.inherit": "Organization default",
    "projectSettings.autoPropagateRepetitions.currentlyOn":
      "The organization currently propagates them",
    "projectSettings.autoPropagateRepetitions.currentlyOff":
      "The organization currently leaves them alone",
    "projectSettings.autoPropagateRepetitions.on": "Propagate",
    "projectSettings.autoPropagateRepetitions.off": "Don't propagate",
    "projectSettings.autoPropagateRepetitions.saveFailed": "Could not save that change",

    "projectSettings.validation.allowSelfLabel": "Allow self-validation",
    // AQU-1571: the server refuses the vote up front, for every role, and the
    // editor greys the check out; "ignored" and "a contributor's" were both wrong.
    "projectSettings.validation.allowSelfDescription":
      "When off, nobody can validate a line whose latest change is their own, whatever " +
      "their role. Someone else has to.",
    "projectSettings.validation.namedValidatorsLabel": "Named validators",
    "projectSettings.validation.namedValidatorsPlaceholder": "alice, bob, carol",
    // AQU-1571: people off the list cannot vote at all (the server refuses it),
    // and the field is a member picker, not a comma-separated box.
    "projectSettings.validation.namedValidatorsDescription":
      "When anyone is listed, only these people can validate text, and they still " +
      "need the minimum role above. Leave empty to allow anyone who meets the " +
      "minimum role.",

    // ── AQU-490: the audio policy, beside the text policy rather than folded
    // into it. Sam's ruling is that these are SEPARATE settings, so every
    // label has to say which of the two it governs — "Minimum role to
    // validate" alone, twice, would read as one rule stated twice.
    "projectSettings.validation.minRoleAudioLabel": "Minimum role to validate recordings",
    "projectSettings.validation.minRoleAudioDescription":
      "Who may sign off a recording. Set separately from the text rule above — a " +
      "project can want a higher bar for audio than for translations, or the other " +
      "way round.",
    "projectSettings.validation.allowSelfAudioLabel": "Allow validating your own recordings",
    "projectSettings.validation.allowSelfAudioDescription":
      "When off, whoever recorded a take cannot validate it — someone else has to " +
      "listen. Takes whose recorder is not known are unaffected, so older " +
      "recordings never become impossible to sign off.",
    "projectSettings.validation.namedValidatorsAudioLabel": "Named recording validators",
    "projectSettings.validation.namedValidatorsAudioDescription":
      "When anyone is listed, only these people may validate recordings. Leave " +
      "empty to allow anyone who meets the minimum role above.",

    // ── DecaySettingsSection.tsx ──
    "projectSettings.decay.summary": "Health",
    "projectSettings.decay.description":
      "This health signal measures proximity to approved neighboring cells in the " +
      "retrieval graph. It can prioritize review, but it is not a translation-quality " +
      "score and never removes the human-review requirement.",
    "projectSettings.decay.maxHopsLabel": "Max hops",
    "projectSettings.decay.maxHopsDescription":
      "Propagation radius from approved cells. Larger values let health ripple " +
      "further through the retrieval graph. Default {defaultValue}.",
    "projectSettings.decay.attentionThresholdLabel": "Attention threshold",
    "projectSettings.decay.attentionThresholdDescription":
      "Low health beyond this threshold shows the cell's review-priority marker " +
      "(0–1). Default {defaultValue}.",

    // ── AudioMediaStrategySection.tsx ──
    "projectSettings.audioMedia.title": "Audio loading",
    "projectSettings.audioMedia.description":
      "Decide when audio recordings are downloaded from storage to this device. You " +
      "can switch any time without re-recording — only future loads are affected.",
    "projectSettings.audioMedia.strategyStreamName": "Stream",
    "projectSettings.audioMedia.strategyStreamDescription": "Play from the network. No cache on this device, no waveforms unless you opt in.",
    "projectSettings.audioMedia.strategyLazyName": "Lazy (default)",
    "projectSettings.audioMedia.strategyLazyDescription": "Download a cell's audio when you scroll to it or press play. Keeps a copy on this device.",
    "projectSettings.audioMedia.strategyEagerName": "Eager",
    "projectSettings.audioMedia.strategyEagerDescription": "Prefetch every cell's waveform when the file opens. Best for offline review.",
    "projectSettings.audioMedia.strategyManualName": "Manual",
    "projectSettings.audioMedia.strategyManualDescription": "Don't auto-download anything. You click a button per cell to load it.",

    // ── SourceLinkSection.tsx ──
    "projectSettings.sourceLink.description":
      "This project is linked to an upstream source project. Source cells are read " +
      "from the upstream; translators work on the target side here.",
    "projectSettings.sourceLink.upstreamIdLabel": "Upstream project ID:",
    "projectSettings.sourceLink.modeClone": "Clone",
    "projectSettings.sourceLink.modeLive": "Live",
    "projectSettings.sourceLink.consumesTranslations": "consumes translations",
    "projectSettings.sourceLink.consumesSource": "consumes source",
    "projectSettings.sourceLink.gateLabel": "gate: {value}",
    "projectSettings.sourceLink.gateValidatedOnly": "validated only",
    "projectSettings.sourceLink.gateEveryCommit": "every commit",
    "projectSettings.sourceLink.cursorLabel": "cursor: {value}",
    // AQU-1559: how much of the upstream this link follows. A subset link is
    // pinned to the files it was made with; a whole-project one keeps picking up
    // the files the upstream gains.
    "projectSettings.sourceLink.scopeAllFiles": "All files",
    "projectSettings.sourceLink.scopeSomeFiles": plural(
      {
        one: "{count} of {total} file",
        other: "{count} of {total} files",
      },
      "total",
    ),
    // AQU-1560: "Choose files" — add more of the upstream's files to a live
    // link that follows a fixed list, without detaching and re-linking.
    // Already-linked files are shown checked and locked (unlinking one is a
    // later slice). The dialog reuses the link flow's count sentence, scope
    // notes and same-name warning, so the two read the same.
    "projectSettings.sourceLink.chooseFilesButton": "Choose files",
    "projectSettings.sourceLink.chooseFilesTitle": "Choose which files this link follows",
    "projectSettings.sourceLink.chooseFilesDescription":
      "Files this link follows are checked. Check more of the source project's " +
      "files to add them here: each arrives with its complete source, and " +
      "receives the source project's changes from then on. Uncheck one to stop " +
      "following it and keep it as this project's own copy.",
    "projectSettings.sourceLink.chooseFilesLoading": "Loading the source project's files…",
    "projectSettings.sourceLink.chooseFilesLoadError":
      "Couldn't load the source project's file list. Nothing has been changed.",
    "projectSettings.sourceLink.chooseFilesLinkedBadge": "already linked",
    "projectSettings.sourceLink.chooseFilesAllLinked":
      "This link follows every file in the source project, and files it adds " +
      "later arrive here on their own. There is nothing to add — uncheck a file " +
      "to stop following it.",
    "projectSettings.sourceLink.chooseFilesNoneChecked":
      "Check a file above to add it to this link, or uncheck one to stop " +
      "following it.",
    "projectSettings.sourceLink.chooseFilesAddButton": "Add files",
    "projectSettings.sourceLink.chooseFilesAddingButton": "Adding files…",
    "projectSettings.sourceLink.chooseFilesIncomplete":
      "The files didn't finish arriving, so they haven't been added to the link " +
      "yet. Try again to finish bringing them in.",
    // AQU-1562: unchecking a file the link follows stops this project following
    // that one file — a per-file detach. The file stays, with everything on it;
    // only the flow of upstream changes ends. Checking a stopped file again
    // resumes it in the same file, which is a different promise from adding a
    // file this project never had, so the two are worded apart. Every one of
    // these sentences is in the confirm step, before anything changes.
    "projectSettings.sourceLink.chooseFilesStoppedBadge": "stopped following",
    "projectSettings.sourceLink.chooseFilesReviewButton": "Review changes",
    "projectSettings.sourceLink.chooseFilesConfirmTitle": "Confirm these changes to the link",
    "projectSettings.sourceLink.chooseFilesApplyingButton": "Saving the link…",
    "projectSettings.sourceLink.chooseFilesStopHeading": plural({
      one: "Stop following this file:",
      other: "Stop following these files:",
    }),
    "projectSettings.sourceLink.chooseFilesStopBody": plural({
      one:
        "It stays in this project with the source text it has now, and its " +
        "translations, validations and comments are untouched. It will no longer " +
        "receive the source project's changes.",
      other:
        "They stay in this project with the source text they have now, and their " +
        "translations, validations and comments are untouched. They will no longer " +
        "receive the source project's changes.",
    }),
    "projectSettings.sourceLink.chooseFilesStopOthersNote":
      "Every other file this link follows keeps syncing as before.",
    "projectSettings.sourceLink.chooseFilesStopWholeProjectWarning":
      "This link follows the whole source project. Stopping a file pins it to the " +
      "remaining files, so files the source project adds later will no longer " +
      "arrive here on their own.",
    "projectSettings.sourceLink.chooseFilesKeepOneError":
      "At least one file must stay linked. To stop following the source project " +
      "altogether, use \u201cDetach from source\u201d.",
    "projectSettings.sourceLink.chooseFilesResumeHeading": plural({
      one: "Follow this file again:",
      other: "Follow these files again:",
    }),
    "projectSettings.sourceLink.chooseFilesResumeBody": plural({
      one:
        "Its source text will be replaced with the source project's current text. " +
        "Its translations, validations and comments stay.",
      other:
        "Their source text will be replaced with the source project's current " +
        "text. Their translations, validations and comments stay.",
    }),
    // AQU-1679: an added upstream file can instead follow INTO a file this
    // project already has — the link flow's replace option, here too.
    "projectSettings.sourceLink.chooseFilesReplaceHeading": plural({
      one: "Replace the source in this file you already have:",
      other: "Replace the source in these files you already have:",
    }),
    "projectSettings.sourceLink.chooseFilesReplaceBody": plural({
      one:
        "It stays the same file, with its translations, validations and comments " +
        "on the same lines. Its source text becomes the source project's, and it " +
        "receives the source project's changes from then on. No second copy is added.",
      other:
        "They stay the same files, with their translations, validations and comments " +
        "on the same lines. Their source text becomes the source project's, and they " +
        "receive the source project's changes from then on. No second copies are added.",
    }),
    "projectSettings.sourceLink.chooseFilesAddHeading": plural({
      one: "Add this file:",
      other: "Add these files:",
    }),
    "projectSettings.sourceLink.chooseFilesAddBody": plural({
      one:
        "It arrives with its complete source text, and receives the source " +
        "project's changes from then on.",
      other:
        "They arrive with their complete source text, and receive the source " +
        "project's changes from then on.",
    }),
    // AQU-1544: a live link that has never brought anything through.
    "projectSettings.sourceLink.notSyncedBadge": "Not synced yet",
    "projectSettings.sourceLink.notSyncedNote":
      "Nothing has come through this link yet, so the source project's files are " +
      "not in this project. Sync now to bring them in.",
    "projectSettings.sourceLink.syncNowButton": "Sync now",
    "projectSettings.sourceLink.syncingButton": "Syncing…",
    "projectSettings.sourceLink.syncFailedNote":
      "Couldn't bring in the source project's files. The link is still saved, so " +
      "you can try again in a moment.",
    "projectSettings.sourceLink.syncNothingYetNote":
      "The source project has nothing to bring in yet. Its files will arrive here " +
      "as it gains them.",
    "projectSettings.sourceLink.cloneNote": "This is a one-time snapshot — upstream changes do not propagate here.",
    "projectSettings.sourceLink.irreversibleTitle": "Detaching is irreversible",
    "projectSettings.sourceLink.irreversibleDescription":
      "Detaching snapshots the current upstream source cells into this project and " +
      "severs the live link. Stale-source markers will clear. This action cannot be undone.",
    "projectSettings.sourceLink.roleGateNote": "Project lead or above required to detach from source.",
    "projectSettings.sourceLink.detachButton": "Detach from source",
    "projectSettings.sourceLink.detachDialogTitle": "Detach from source project?",
    "projectSettings.sourceLink.detachDialogDescription":
      "This will snapshot the upstream source cells into this project and " +
      "permanently sever the link. Stale-source markers will clear. You cannot " +
      "re-attach automatically — a project lead would need to re-link manually.",
    "projectSettings.sourceLink.typeToConfirm": "Type {word} to confirm.",
    "projectSettings.sourceLink.detachingButton": "Detaching…",
    "projectSettings.sourceLink.detachConfirmButton": "Detach",

    // ── LinkSourceSection.tsx (AQU-1525) ──
    "projectSettings.linkSource.title": "Link to a source project",
    "projectSettings.linkSource.description":
      "This project owns its own source. Link it to another project to read that " +
      "project's source files here, without recreating this project.",
    "projectSettings.linkSource.pickerLabel": "Source project",
    "projectSettings.linkSource.pickerPlaceholder": "Choose a project to link from…",
    "projectSettings.linkSource.pickerSearchPlaceholder": "Search projects…",
    "projectSettings.linkSource.pickerSearchAriaLabel": "Search projects",
    "projectSettings.linkSource.pickerNoMatches": "No projects match.",
    "projectSettings.linkSource.noProjectsNote": "No other project is available to link to.",
    "projectSettings.linkSource.additiveNote":
      "The link is live: the upstream's source files are mirrored in alongside " +
      "everything this project already holds, and later upstream edits keep " +
      "flowing through. Existing files, translations and validations are left as " +
      "they are. Detach later to stop following the upstream.",
    // AQU-1679: the same promise when the lead has chosen to replace the source
    // of a file they already have — "existing files are left as they are" is
    // no longer true of those.
    "projectSettings.linkSource.additiveNoteReplacing":
      "The link is live: later upstream edits keep flowing through, including " +
      "into the files whose source you are replacing. Your other files, and every " +
      "translation and validation, are left as they are. Detach later to stop " +
      "following the upstream.",
    "projectSettings.linkSource.linkButton": "Link source project",
    "projectSettings.linkSource.linkingButton": "Linking…",
    "projectSettings.linkSource.roleGateNote":
      "Project lead or above required to link a source project.",
    "projectSettings.linkSource.cycleError":
      "That project already reads its source from this one, so linking would " +
      "create a loop. This project is still unlinked — choose a different project.",

    // ── AQU-1526: the confirm step shown after an upstream is picked and
    // before anything is linked. It warns about same-named files; it never
    // blocks the link.
    "projectSettings.linkSource.reviewButton": "Review what will be added",
    "projectSettings.linkSource.cancelButton": "Cancel",
    "projectSettings.linkSource.previewTitle": "Link to {upstream}?",
    "projectSettings.linkSource.previewLoading": "Checking what this link will add…",
    "projectSettings.linkSource.previewCount": plural({
      one: "{count} source file will be added to this project.",
      other: "{count} source files will be added to this project.",
    }),
    // ── AQU-1559: the confirm step's file list. Every file arrives checked,
    // so the stock outcome is the whole-project link; unchecking any of them
    // pins the link to the rest.
    "projectSettings.linkSource.selectAllFiles": "All files",
    "projectSettings.linkSource.fileClashBadge": "same name here",
    "projectSettings.linkSource.previewNoneSelected":
      "Pick at least one file to link.",
    // ── AQU-1679: a file this project already has can follow the link itself,
    // instead of gaining a second copy. Offered per same-named file, off by
    // default, and shown with what it will do before anything is linked.
    "projectSettings.linkSource.replaceOption":
      "Replace the source in my existing {name} and keep its translations",
    "projectSettings.linkSource.replaceComparing": "Comparing the two files…",
    "projectSettings.linkSource.replaceCompareFailed":
      "Couldn't compare the two files. Turn this off and on to try again, or " +
      "leave it off to add the file as a separate copy.",
    "projectSettings.linkSource.replaceMatchSame": plural({
      one: "{same} of {count} line is the same in both files.",
      other: "{same} of {count} lines are the same in both files.",
    }),
    "projectSettings.linkSource.replaceMatchChanged": plural({
      one:
        "{count} line differs and will take the source project's text. Its " +
        "translation will be flagged as source changed.",
      other:
        "{count} lines differ and will take the source project's text. Their " +
        "translations will be flagged as source changed.",
    }),
    "projectSettings.linkSource.replaceMatchAdded": plural({
      one: "{count} line only the source project has will be added to your file.",
      other: "{count} lines only the source project has will be added to your file.",
    }),
    "projectSettings.linkSource.replaceMatchKept": plural({
      one: "{count} line only your file has will stay as it is.",
      other: "{count} lines only your file has will stay as they are.",
    }),
    "projectSettings.linkSource.replaceNoMatch": plural({
      one:
        "These two files are not the same material: {same} of {count} line matches. " +
        "Turn this off to add the file as a separate copy.",
      other:
        "These two files are not the same material: only {same} of {count} lines " +
        "match. Turn this off to add the file as a separate copy.",
    }),
    "projectSettings.linkSource.replaceCount": plural({
      one:
        "{count} file you already have will take its source from this link and " +
        "keep its translations.",
      other:
        "{count} files you already have will take their source from this link and " +
        "keep their translations.",
    }),
    "projectSettings.linkSource.scopeAllNote":
      "This link follows the whole project, so files the source project adds " +
      "later will arrive here too.",
    "projectSettings.linkSource.scopeSubsetNote":
      "This link follows only the files you picked. Files the source project " +
      "adds later will not arrive here on their own.",
    "projectSettings.linkSource.previewEmptyUpstream":
      "That project has no source files yet, so nothing will be added now. Files " +
      "will arrive here as the upstream gains them.",
    "projectSettings.linkSource.previewLoadError":
      "Couldn't load that project's file list, so we can't say what the link will " +
      "add. Nothing has been linked.",
    "projectSettings.linkSource.previewRetryButton": "Try again",
    // ── AQU-1544: the link was saved but its first sync failed. One sentence
    // and one action, shown wherever the user started the link.
    "projectSettings.linkSource.seedFailedMessage":
      "The link to the source project was saved, but its files have not arrived " +
      "here yet. Try again to bring them in.",
    "projectSettings.linkSource.seedRetryFailedNote":
      "That attempt did not bring them in either. The link is still saved, so you " +
      "can try again in a moment.",
    "projectSettings.linkSource.seedRetryingButton": "Trying again…",
    "projectSettings.linkSource.clashWarningHeading": plural({
      one: "This project already has a file with the same name:",
      other: "This project already has files with these names:",
    }),
    "projectSettings.linkSource.clashWarningBody": plural({
      one:
        "Your existing file is kept exactly as it is, with its translations. The " +
        "mirrored copy arrives alongside it with empty translations, so this name " +
        "will appear twice in the file list.",
      other:
        "Your existing files are kept exactly as they are, with their translations. " +
        "The mirrored copies arrive alongside them with empty translations, so each " +
        "of these names will appear twice in the file list.",
    }),

    // ── LanguagesSection.tsx ──
    "projectSettings.languages.defaultTargetLabel": "Default target language",
    "projectSettings.languages.additionalLanesLabel": "Additional target lanes",
    "projectSettings.languages.additionalLanesDescription":
      "Extra target-language lanes for this project — e.g. dialect variants or " +
      "parallel drafts of the same source.",
    "projectSettings.languages.laneNameLabel": "Lane name",
    "projectSettings.languages.laneNamePlaceholder": "Name this lane",
    // AQU-1592: a lane stores the language the user typed, an OPTIONAL display
    // name, and an OPTIONAL code override. The name's placeholder is the
    // language itself, because that is what the lane shows when no name is set.
    "projectSettings.languages.laneLanguageLabel": "Lane language",
    "projectSettings.languages.laneLanguagePlaceholder": "Language this lane translates into",
    "projectSettings.languages.laneLanguageRequiredError":
      "A lane needs a language. Type the language it translates into.",
    "projectSettings.languages.laneAdvancedToggle": "Advanced",
    "projectSettings.languages.laneCodeLabel": "Language code",
    "projectSettings.languages.laneCodeNote":
      "Leave blank to derive the code from the language. Set it only when the " +
      "derived code is wrong.",
    "projectSettings.languages.laneCodeDerivedPlaceholder": "Derived from the language",
    "projectSettings.languages.laneCodeMalformedError":
      "That is not a valid language code. Use a BCP 47 tag such as \"es\" or \"es-MX\".",
    "projectSettings.languages.duplicateNameError":
      "Another lane already has this name. Change one of them.",
    "projectSettings.languages.nameTooLongError": "That name is too long.",
    "projectSettings.languages.noAdditionalLanes": "No additional lanes yet.",
    "projectSettings.languages.archiveConfirm":
      "Archive \"{lane}\"? It's hidden from the lane switcher by default but kept — " +
      "its cell data is preserved and you can restore it anytime.",
    // AQU-1464: "is anyone still working in here?" — shown inside the archive
    // confirmation, above the Confirm button.
    "projectSettings.languages.lastChangeLoading": "Checking recent activity…",
    "projectSettings.languages.lastChange": "Last change in this lane: {date} by {editor}",
    "projectSettings.languages.lastChangeUnknownEditor": "Last change in this lane: {date}",
    "projectSettings.languages.lastChangeNone": "No changes in this lane yet.",
    "projectSettings.languages.lastChangeUnavailable": "Last change unavailable.",
    // AQU-1600: every target lane is archivable, including the former default
    // one — but a project must keep one active, so the last one's archive
    // control is disabled with this reason.
    "projectSettings.languages.lastActiveLaneTooltip":
      "This is the project's only active lane. Add another target lane before archiving this one.",
    "projectSettings.languages.archivingButton": "Archiving…",
    "projectSettings.languages.confirmArchiveButton": "Confirm archive",
    "projectSettings.languages.archiveLaneAriaLabel": "Archive lane {lane}",
    "projectSettings.languages.archivedLanesLabel": "Archived lanes",
    "projectSettings.languages.archivedLanesDescription":
      "Hidden from the lane switcher by default. Their translations are kept; " +
      "restore a lane to make it active again.",
    "projectSettings.languages.restoringButton": "Restoring…",
    // "Restore" button → common.restore (identical text)
    "projectSettings.languages.restoreLaneAriaLabel": "Restore lane {lane}",
    "projectSettings.languages.addLaneLabel": "Add a target lane",
    "projectSettings.languages.suggestionsAriaLabel": "Language suggestions",
    // "e.g. fr-CA" placeholder → projectSettings.create.extraLanguagesPlaceholder (identical text)
    // "Adding…" busy label → common.adding (identical text)
    "projectSettings.languages.addLaneButton": "Add lane",
    "projectSettings.languages.alreadyDefaultError": "This is already the default target language.",
    "projectSettings.languages.alreadyExistsError": "This lane already exists.",
    "projectSettings.languages.conflictError": "Someone else updated shared settings. Refresh to reapply your change.",
    "projectSettings.languages.offlineError": "You're offline. Reconnect to save language lanes.",
    "projectSettings.languages.permissionError": "You don't have permission to change shared settings.",
    "projectSettings.languages.savingFailedGeneric": "Saving failed.",

    // ── ProjectSettings.tsx — misc call sites without a pre-existing key ──
    "projectSettings.info.titleLabel": "Project title",
    "projectSettings.systemPrompt.label": "System prompt",
    "projectSettings.systemPrompt.navDescription":
      "The standing instructions behind every AI draft — how the AI should write, " +
      "not what the project is for.",
    "projectSettings.advancedLlm.modelOverrideName": "Model override",
    "projectSettings.voice.studioLabel": "Voice Studio",
    "projectSettings.localModels.onDeviceLabel": "On-device models",
    "projectSettings.gitSync.autoSyncIntervalAriaLabel": "Auto-sync interval minutes",
    "projectSettings.gitSync.minutesAbbrev": "min",

    // ── RulesSection.tsx ──

    // ── LocalModelsSection.tsx (device-model download rows) ──
    "projectSettings.localModels.downloadedBadge": "Downloaded",
    "projectSettings.localModels.notDownloadedBadge": "{size} MB · not downloaded",

    // ── MembersSection.tsx ──
    "projectSettings.members.filterAriaLabel": "Filter members",
    "projectSettings.members.filterProjectGrants": "Project grants",
    "projectSettings.members.filterViaOrg": "Via organization",
    "projectSettings.members.removeDirectAccess": "Remove direct access",
    "projectSettings.members.revokeAllAccess": "Revoke all access…",
    "projectSettings.members.noActionsAvailable": "No actions available",
    "projectSettings.members.roleChangeNeedsRole":
      "{role} or higher can change member roles",
    "projectSettings.members.roleChangeOutranked":
      "You can't change a member whose role is at or above your own",
    "projectSettings.members.addDialogDescription":
      "Grant access from your organization, or create a shareable invite link.",
    "projectSettings.members.actionsForRow": "Actions for {username}",

    // ── Monday.com integration (MondayIntegrationSection / MondayLinkedView /
    //    MondayMappingEditor / MondaySetupWizard) — SWARM-TODO(AQU-832, i18n)
    //    in MondayIntegrationSection.tsx scoped this trio to a dedicated later
    //    wave; this is that wave. "Monday"/"Monday.com" is the product's own
    //    name and stays as-is in every locale.
    "projectSettings.monday.boardSyncLabel": "Board sync",
    "projectSettings.monday.loadingIntegration": "Loading Monday integration…",
    "projectSettings.monday.orgNotConnected": "Your organization hasn't connected Monday.com yet.",
    "projectSettings.monday.orgSettingsLinkText": "organization settings",
    "projectSettings.monday.orgNotConnectedInstructions":
      "An org maintainer can connect it in {settingsLink}, or ask an org maintainer to set it up.",
    "projectSettings.monday.noBoardLinkedReadOnly":
      "No Monday board is linked to this project. Maintainers can set one up here.",
    "projectSettings.monday.linkBoardPrompt":
      "Link a Monday board to push this project's translation progress automatically.",
    "projectSettings.monday.setupWithAiButton": "Set up with AI",
    "projectSettings.monday.setupWithAiBlurb":
      "Picks the board, maps your progress metrics to its columns, and shows you the plan " +
      "before anything is written.",
    "projectSettings.monday.setupManuallyButton": "Set it up manually instead",
    "projectSettings.monday.boardSelectAriaLabel": "Monday board",
    "projectSettings.monday.useAiToConfigure": "Use AI to configure",
    "projectSettings.monday.analyzingBoardAndProject": "Analyzing the board and this project…",
    "projectSettings.monday.aiProposalLabel": "AI proposal",
    "projectSettings.monday.applyButton": "Apply",
    "projectSettings.monday.removeBoardLinkTitle": "Remove board link?",
    "projectSettings.monday.removeBoardLinkDescription":
      "Progress will stop pushing to {boardName}. The board and its items are left " +
      "untouched on Monday.",
    "projectSettings.monday.removeLinkButton": "Remove link",
    "projectSettings.monday.structureStaleWarning": "Board structure changed — review the mapping below.",
    "projectSettings.monday.linkedBoardPrefix": "Linked board:",
    "projectSettings.monday.oneItemPerLabel": "One item per {granularity}.",
    "projectSettings.monday.lastPushOk": "Last push {date} — ok.",
    "projectSettings.monday.lastPushFailed": "Last push {date} — failed.",
    "projectSettings.monday.notPushedYet": "Not pushed yet.",
    "projectSettings.monday.syncToggleLabel": "Sync",
    "projectSettings.monday.syncNowButton": "Sync now",
    "projectSettings.monday.removeBoardLinkAriaLabel": "Remove board link",
    "projectSettings.monday.columnMappingLabel": "Column mapping",
    "projectSettings.monday.reconfigureWithAiLabel": "Reconfigure with AI",
    "projectSettings.monday.reconfigurePlaceholder":
      "Describe what to change — e.g. “track validated % instead of completion, one item per file”",
    "projectSettings.monday.reconfigureTooltip": "Ask AI to update the mapping",
    "projectSettings.monday.noColumnsMapped": "No columns mapped.",
    "projectSettings.monday.columnHeader": "Monday column",
    "projectSettings.monday.metricHeader": "Metric",
    "projectSettings.monday.pickColumnPlaceholder": "Pick a column",
    "projectSettings.monday.removeMappingRowAriaLabel": "Remove mapping row",
    "projectSettings.monday.addRowButton": "Add row",
    "projectSettings.monday.introDescription":
      "Aquilla reads your Monday board names and columns plus this project's progress " +
      "figures, then proposes which board to use and what to push to each column. Nothing " +
      "is written to Monday until you approve it.",
    "projectSettings.monday.introBullet1": "Picks the board that best matches this project",
    "projectSettings.monday.introBullet2":
      "Maps completion, validation and activity metrics to suitable columns",
    "projectSettings.monday.introBullet3": "Skips columns Monday won't let anything write to",
    "projectSettings.monday.connectGateDescription":
      "Your organization isn't connected to Monday.com yet. Connecting opens Monday in a " +
      "new tab; come back here when it's done and setup continues automatically.",
    "projectSettings.monday.waitingForMonday": "Waiting for Monday…",
    "projectSettings.monday.scanStep1Label": "Reading this project and your Monday boards",
    "projectSettings.monday.scanStep2Label": "Matching progress metrics to board columns",
    "projectSettings.monday.boardCaption": "Board",
    "projectSettings.monday.loadingBoards": "Loading boards…",
    "projectSettings.monday.boardListFailed":
      "Couldn't list boards — an org maintainer can change the board later.",
    "projectSettings.monday.pickBoardPlaceholder": "Pick a board",
    "projectSettings.monday.boardItemsLabel": "Board items",
    "projectSettings.monday.granularityProjectLabel": "One item for the whole project",
    "projectSettings.monday.granularityFileLabel": "One item per file",
    "projectSettings.monday.someColumnsSkipped": "Some columns were skipped",
    "projectSettings.monday.reviewRowsCaption": "What gets pushed — change any row before applying",
    "projectSettings.monday.applyingStatus": "Linking the board and pushing your progress…",
    "projectSettings.monday.progressPushesAutomatically": "Progress pushes automatically as translators work.",
    "projectSettings.monday.viewBoardLink": "View board on Monday",
    "projectSettings.monday.connectButton": "Connect Monday.com",
    "projectSettings.monday.applyAndPushButton": "Apply and push",

    // ── Terminology source-term matching (AQU-1271) ──
    "projectSettings.termMatching.title": "Prefixes and suffixes",
    "projectSettings.termMatching.description":
      "Letters or syllables that attach to source words. Terminology matching will allow them around a term when the term's \"Allow prefixes and suffixes\" option is on.",
    "projectSettings.termMatching.prefixes": "Prefixes",
    "projectSettings.termMatching.suffixes": "Suffixes",
    "projectSettings.termMatching.maxAffixes": "Max chained per side",
    "projectSettings.termMatching.foldMarksDefault": "Ignore vowel marks and accents by default",
    "projectSettings.termMatching.loadPreset": "Load preset",
    "projectSettings.termMatching.addAffixPlaceholder": "Type and press Enter",
    "projectSettings.termMatching.remove": "Remove {affix}",
    "projectSettings.termMatching.preset.hebrew": "Hebrew",
    "projectSettings.termMatching.preset.arabic": "Arabic",
    "projectSettings.termMatching.preset.swahili": "Swahili",
    "projectSettings.termMatching.preset.turkish": "Turkish",
  },
  context: {
    _context: {
      description:
        "Creating a project and changing its settings — general details, source and " +
        "target language, AI and validation configuration, and sharing. Mostly form " +
        "labels above or beside their control, which have more room than nav or " +
        "button text.",
    },
    keys: {
      "projectSettings.shared.lastEdited": {
        description:
          "Sub-line under the project-name field recording who last changed the " +
          "shared settings and when. Not a sentence — a provenance line, no " +
          "period. Separated by a middle dot.",
        placeholders: {
          name: "Username of the person who last saved the shared settings.",
          date: "Date of that save, already formatted for the viewer's locale.",
        },
      },
      "projectSettings.shared.lastEditedOn": {
        description:
          "The same provenance line as lastEdited, when the app does not know " +
          "who saved the shared settings, only when. Not a sentence, no period.",
        placeholders: {
          date: "Date of that save, already formatted for the viewer's locale.",
        },
      },
      "projectSettings.permission.roleOrHigher": {
        description:
          "Composes a role-floor note, e.g. 'Maintainer or higher' — used inside " +
          "PermissionDeniedAlert's requiredRoleNote and the two shared-settings " +
          "disabled-field tooltips on this page. The role name comes pre-translated " +
          "and pre-resolved via resolveRoleName()/common.role.* — never hardcode a " +
          "role name string here.",
        placeholders: {
          role: "The already-localized role display name (e.g. via resolveRoleName), such as 'Maintainer'.",
        },
      },
      "projectSettings.permission.editSharedSettingsRequiresRole": {
        description:
          "Disabled-field tooltip shown on shared-settings inputs (source/target " +
          "language, etc.) when the active account's role is below the write floor.",
        placeholders: {
          roleFloor: "The rendered projectSettings.permission.roleOrHigher string, e.g. 'Maintainer or higher'.",
        },
      },
      "projectSettings.permission.renameRequiresRole": {
        description:
          "Disabled-field tooltip shown on the project-name input when the active " +
          "account's role is below the rename floor.",
        placeholders: {
          roleFloor: "The rendered projectSettings.permission.roleOrHigher string, e.g. 'Maintainer or higher'.",
        },
      },
      "projectSettings.permission.onlyRoleCanModify": {
        description:
          "Title of the compact per-control permission hint on a locked settings " +
          "field (GitHub-style: 'Only admins can modify'). Names the role class " +
          "that is allowed to edit, not the caller's current role. Short, no period.",
        placeholders: {
          role: "Plural localized role noun, e.g. 'Maintainers', already resolved via resolveRoleName().",
        },
      },
      "projectSettings.permission.viewPrivilegedMembers": {
        description:
          "Next-action control under the per-control lock hint. Opens a modal of " +
          "people who can change the setting (GitHub: 'View admins'). Short, no period.",
        placeholders: {
          role: "Plural localized role noun, e.g. 'Maintainers', already resolved via resolveRoleName().",
        },
      },
      "projectSettings.permission.privilegedDialogTitle": {
        description:
          "Title of the GitHub-style 'Workspace admins' modal listing people who " +
          "can change shared project settings. Short, no period.",
        placeholders: {
          role: "Plural localized role noun, e.g. 'Maintainers', already resolved via resolveRoleName().",
        },
      },
      "projectSettings.permission.privilegedDialogDescription": {
        description:
          "One-line explanation under the privileged-members modal title. Names " +
          "what that role class can do, not the caller's current role.",
        placeholders: {
          role: "Plural localized role noun, e.g. 'Maintainers', already resolved via resolveRoleName().",
        },
      },
      "projectSettings.permission.privilegedDialogEmpty": {
        description:
          "Empty state inside the privileged-members modal when nobody on the " +
          "project holds the write floor.",
        placeholders: {
          role: "Plural localized role noun, e.g. 'Maintainers', already resolved via resolveRoleName().",
        },
      },
      "projectSettings.permission.privilegedDialogError": {
        description:
          "Error state inside the privileged-members modal when the list could " +
          "not be loaded. Short, with a period.",
        placeholders: {
          role: "Plural localized role noun, e.g. 'Maintainers', already resolved via resolveRoleName().",
        },
      },
      "projectSettings.create.destinationRoleHint": {
        description:
          "Help text under the create-dialog destination picker when the caller " +
          "may not create projects in the org the page is showing.",
        placeholders: {
          role: "Singular localized role name, e.g. 'Contributor' or 'Guest'.",
          org: "Organization name, e.g. 'Biblica ETT'.",
        },
      },
      "projectSettings.create.destinationNotAllowedHint": {
        description:
          "Help text under the create-dialog destination picker when the caller may " +
          "not create projects in the page's org and their role there is unknown.",
        placeholders: { org: "Organization name, e.g. 'Biblica ETT'." },
      },
      "projectSettings.create.destinationLoadError": {
        description:
          "Error in the create-project dialog when the list of places the user may " +
          "create a project could not be loaded. Creating is blocked until it loads.",
      },
      "projectSettings.create.createdToast": {
        description: "Success toast after creating a project, naming where it was created.",
        placeholders: {
          name: "The new project's name.",
          destination: "Where it was created: an organization name or the user's personal workspace name.",
        },
      },
      "projectSettings.create.teamsLabel": {
        description: "Field label above the teams multi-select in the create-project dialog.",
      },
      "projectSettings.create.teamsPlaceholder": {
        description: "Placeholder in the teams multi-select trigger when no team is chosen.",
      },
      "projectSettings.create.teamsSearch": {
        description: "Placeholder and accessible name for the search box inside the teams multi-select.",
      },
      "projectSettings.create.teamsEmpty": {
        description: "Shown in the teams multi-select when the search matches no team.",
      },
      "projectSettings.create.teamsRequiredHint": {
        description:
          "Help text under the teams multi-select when the caller may only create projects " +
          "in this organization inside a team they lead.",
      },
      "projectSettings.create.teamsRequiredError": {
        description: "Form error when the caller submits without choosing a required team.",
      },
      "projectSettings.create.trigger": {
        description: "Button that opens the create-project dialog. Short, with a leading + icon.",
      },
      "projectSettings.create.targetLanguagesLabel": {
        description:
          "Field label above the target-language boxes in the create dialog. " +
          "Always 'Target Language(s)' — the parenthetical covers one or many " +
          "lanes without swapping the label as boxes fill.",
      },
      "projectSettings.create.shapeLinkedTargetName": {
        description:
          "Bold name of the linked-target project-shape radio. Inflects with how " +
          "many target-language lanes the user has filled in on this create pass " +
          "('Linked Target' vs 'Linked Targets'). Count is not shown as a numeral.",
      },
      "projectSettings.create.additionalTargetPlaceholder": {
        description:
          "Placeholder in the second and subsequent target-language boxes of the " +
          "create dialog, where the first box carries the full example placeholder.",
      },
      "projectSettings.create.addTargetLanguageAction": {
        description:
          "Label of the button under the target-language boxes in the create dialog " +
          "that appends one more empty box (one per additional target lane).",
      },
      "projectSettings.create.bulkTargetLanguagesHint": {
        description:
          "Field description above the comma-separated overflow field in the create " +
          "dialog, shown once the per-lane boxes have hit their limit and the plus " +
          "button has been replaced.",
        placeholders: {
          max: "The number of individual target-language boxes the dialog allows before switching to the overflow field.",
        },
      },
      "projectSettings.create.bulkTargetLanguagesPlaceholder": {
        description:
          "Placeholder in the comma-separated target-language overflow field, showing " +
          "the expected comma-delimited shape.",
      },
      "projectSettings.create.bulkTargetLanguagesCount": {
        description:
          "Count of extra target lanes recognised in the comma-separated overflow " +
          "field, shown beneath it as live feedback. Reflects lanes that would " +
          "actually be created, after duplicates and the overall cap are applied.",
        placeholders: {
          count: "How many extra target lanes the overflow field currently contributes; governs the plural form.",
        },
      },
      "projectSettings.create.languageHintAriaLabel": {
        description: "Accessible name of the small info-icon button beside a source/target language field that opens an explanatory tooltip.",
      },
      "projectSettings.create.shapeSelfContained": {
        description:
          "One of two radio-option descriptions under 'Advanced: project shape'. " +
          "The bold name is a separate translated+styled placeholder so word order " +
          "can move per locale. Inflects 'target'/'targets' from the filled " +
          "target-language count (not shown as a numeral).",
        placeholders: {
          name: "The bold shape name, already translated via projectSettings.create.shapeSelfContainedName and wrapped in <strong> by the caller.",
        },
      },
      "projectSettings.create.shapeLinkedTarget": {
        description:
          "Second project-shape radio-option description; see shapeSelfContained. " +
          "Inflects 'target'/'targets' from the filled target-language count.",
        placeholders: {
          name: "The bold shape name, already translated via projectSettings.create.shapeLinkedTargetName and wrapped in <strong> by the caller.",
        },
      },
      "projectSettings.create.cloneModeName": {
        description:
          "The emphasized mode word in projectSettings.create.cloneIntro — a one-time " +
          "snapshot copy, not a live link.",
      },
      "projectSettings.create.upstreamFilesCount": {
        description:
          "Sentence under the file list in the Create New Project dialog, saying how many of the upstream project's files the new project will bring in.",
        placeholders: {
          count: "How many files are checked (data, a plain integer), e.g. '3'.",
        },
      },
      "projectSettings.create.cloneIntro": {
        description:
          "Explanatory line under the Self Contained shape radio: offers an optional " +
          "one-time clone from an upstream project. The bold mode name is a separate " +
          "translated+styled placeholder so word order can move per locale.",
        placeholders: {
          mode:
            "The bold mode name, already translated via projectSettings.create.cloneModeName " +
            "and wrapped in <strong> by the caller.",
        },
      },
      "projectSettings.create.liveModeName": {
        description:
          "The emphasized mode word in projectSettings.create.liveIntro — a live-linked " +
          "copy that stays connected to the upstream project.",
      },
      "projectSettings.create.liveIntro": {
        description:
          "Explanatory line under the Linked Target shape radio: states that this " +
          "create is a live-linked copy. The bold mode name is a separate translated+styled " +
          "placeholder so word order can move per locale.",
        placeholders: {
          mode:
            "The bold mode name, already translated via projectSettings.create.liveModeName " +
            "and wrapped in <strong> by the caller.",
        },
      },
      "projectSettings.create.linkConsumesSource": {
        description:
          "Radio-option description for 'consumes source' (sibling-translation case) " +
          "in the advanced create flow. Inflects 'a target lane' vs 'target " +
          "lanes' from how many target languages the user has entered.",
        placeholders: {
          name: "The bold option name, already translated via projectSettings.create.linkConsumesSourceName and wrapped in <strong> by the caller.",
        },
      },
      "projectSettings.create.linkConsumesTarget": {
        description: "Radio-option description for 'consumes target' (chain case); see linkConsumesSource.",
        placeholders: {
          name: "The bold option name, already translated via projectSettings.create.linkConsumesTargetName and wrapped in <strong> by the caller.",
        },
      },
      "projectSettings.create.validationLinkConsumesRequired": {
        description:
          "Inline validation error when Advanced linking is active (linked-target, or " +
          "self-contained with an upstream picked) but the user has not chosen " +
          "whether to consume the upstream source or one of its targets.",
      },
      "projectSettings.create.extraLanguagesRemoveAriaLabel": {
        description: "Accessible name of the small x button on a chip removing one extra target language from the create-dialog's list.",
        placeholders: {
          lang: "The language tag being removed, exactly as the user entered it (data, not translated).",
        },
      },
      "projectSettings.create.extraLanguagesTooLongError": {
        description: "Inline validation error when a typed extra-language tag exceeds the character cap.",
        placeholders: {
          max: "The maximum allowed character count, e.g. '64'.",
        },
      },
      "projectSettings.create.laneRecommendation": {
        description:
          "Recommendation panel shown instead of creating a second project, when the " +
          "user picked the sibling-translation ('its source') link-consumes case: " +
          "offers to add the target language as a lane on the upstream project instead.",
        placeholders: {
          heading: "The bold rhetorical heading, already translated via projectSettings.create.laneRecommendationHeading and wrapped in <strong> by the caller.",
          projectName: "The upstream project's name (data), wrapped in <strong> by the caller — not translated.",
        },
      },
      "projectSettings.create.laneRecommendationAddButton": {
        description: "Button that adds the typed target language as a lane on the named upstream project.",
        placeholders: {
          projectName: "The upstream project's name (data, not translated).",
        },
      },
      "projectSettings.create.laneRecommendationAlreadyDefaultError": {
        description: "Inline error when the typed language matches the upstream project's existing default target language.",
        placeholders: {
          lane: "The language tag the user typed (data, not translated).",
          projectName: "The upstream project's name (data, not translated).",
        },
      },
      "projectSettings.create.laneRecommendationAlreadyLaneError": {
        description: "Inline error when the typed language already exists as a lane on the upstream project.",
        placeholders: {
          lane: "The language tag the user typed (data, not translated).",
          projectName: "The upstream project's name (data, not translated).",
        },
      },
      "projectSettings.create.laneRecommendationSuccess": {
        description: "Success message after a lane was added to the upstream project from this recommendation panel.",
        placeholders: {
          lane: "The language tag that was added (data, not translated).",
          projectName: "The upstream project's name (data, not translated).",
        },
      },
      "projectSettings.create.laneRecommendationForbiddenError": {
        description: "Inline error when the caller lacks maintainer access on the upstream project to add a lane.",
        placeholders: {
          projectName: "The upstream project's name (data, not translated).",
        },
      },
      "projectSettings.share.lockedHintOrg": {
        description: "Tooltip on a locked (non-editable) role row in the Share dialog's Members tab, for a member whose access comes from org membership.",
      },
      "projectSettings.share.lockedHintCreator": {
        description: "Tooltip on a locked role row for the project's creator, whose role can't be changed here.",
      },
      "projectSettings.share.recipientJoinsAs": {
        description:
          "Sentence shown after an invite link is minted, naming the role the " +
          "recipient will hold once they redeem it.",
        placeholders: {
          role: "The already-localized role display name (via resolveRoleName), or the projectSettings.share.recipientJoinsAsFallbackRole fallback text if the role option can't be resolved.",
        },
      },
      "projectSettings.share.singleUseNote": {
        description:
          "Note explaining an invite link is single-use, naming the button that " +
          "mints a fresh one for the next recipient.",
        placeholders: {
          createAnotherLink: "The rendered projectSettings.share.createAnotherLinkButton label, wrapped in <strong> by the caller — insert exactly as given.",
        },
      },
      "projectSettings.share.recipientEmailLabel": {
        description: "Field label for the optional recipient-email input on the invite-link form. The '(optional)' qualifier is a separate, smaller-styled span using common.optionalFieldNote.",
      },
      "projectSettings.share.openLinkConnector": {
        description: "Short connector text on an active-invite-link row shown instead of the recipient's email, when the link has no email restriction (anyone can redeem it).",
      },
      "projectSettings.share.revokeLinkAriaLabel": {
        description: "Accessible name of the trash-icon button that starts the revoke-confirmation flow for one active invite link.",
      },
      "projectSettings.searchAriaLabel": {
        description: "Accessible name of the settings search input, which filters section cards by label/keyword as the user types.",
      },
      "projectSettings.moreSaveOptionsAriaLabel": {
        description: "Accessible name of the small chevron button beside 'Save changes' that opens the 'Save and close' / 'Close without saving' menu.",
      },
      "projectSettings.dismissConflictAriaLabel": {
        description: "Accessible name of the small × button that dismisses the 'Settings changed elsewhere' banner.",
      },
      "projectSettings.save.savedShort": {
        description:
          "Success message shown briefly after Save when 3 or fewer fields changed — " +
          "a plain list of the changed field names.",
        placeholders: {
          list: "The changed field names (projectSettings.field.*), already joined into a localized list via formatList() — insert exactly as given.",
        },
      },
      "projectSettings.save.savedMany": {
        description:
          "Success message shown briefly after Save when more than 3 fields changed — " +
          "names the first 3 and counts the rest. count is always > 3 in the English " +
          "flow (the <=3 case uses savedShort instead), but other locales' plural " +
          "rules may still select a category other than 'other' for the same number.",
        placeholders: {
          count: "Total number of changed fields (always > 3 in the English flow — governs plural selection).",
          list: "The first 3 changed field names (projectSettings.field.*), already joined into a localized list via formatList() — insert exactly as given.",
          more: "How many additional changed fields beyond the first 3, as a plain cardinal number. Not separately pluralized.",
        },
      },
      "projectSettings.save.conflictToast": {
        description: "Toast shown when a background shared-settings update from another collaborator lands while this page is open.",
        placeholders: {
          username: "The other collaborator's username (data), or the projectSettings.save.conflictFallbackUsername fallback text if unknown.",
        },
      },
      "projectSettings.info.lastEditedBy": {
        description: "Small note under the Project Name field showing who last saved shared settings and when.",
        placeholders: {
          username: "The editor's username (data, not translated).",
          date: "The already-formatted edit date (via formatDate), e.g. 'Aug 12, 2026'.",
        },
      },
      "projectSettings.ai.instructionsHelp": {
        description:
          "Help text under the AI Instructions textarea, naming the two literal " +
          "placeholder tokens the textarea's own content can use.",
        placeholders: {
          sourceVar: "The literal, untranslated code snippet '{sourceLanguage}', styled as inline code by the caller — insert exactly as given.",
          targetVar: "The literal, untranslated code snippet '{targetLanguage}', styled as inline code by the caller — insert exactly as given.",
        },
      },
      "projectSettings.ai.topKDescription": {
        description: "Help text under the 'Examples retrieved (top_k)' input.",
        placeholders: {
          defaultCount: "The default example count as a plain number (data), e.g. '5'.",
        },
      },
      "projectSettings.ai.completionBatchSizeDescription": {
        description: "Help text under the 'AI completions batch size' input.",
        placeholders: {
          defaultSize: "The default batch size as a plain number (data), e.g. '20'.",
        },
      },
      "projectSettings.ai.validationBatchSizeHelp": {
        description: "Help text under the 'Batch validation size' input.",
        placeholders: {
          zeroNote: "The rendered projectSettings.ai.validationBatchSizeZeroNote string, styled bold by the caller — insert exactly as given.",
        },
      },
      "projectSettings.draftContext.precedingCellsDescription": {
        description: "Help text under the 'Preceding committed-target cells' input.",
        placeholders: {
          defaultCount: "The default cell count as a plain number (data), e.g. '2'.",
        },
      },
      "projectSettings.advancedLlm.customEndpointStatus": {
        description: "Collapsed-state status text on the Advanced LLM settings summary row, shown when a custom endpoint is configured.",
        placeholders: {
          endpoint: "The configured endpoint URL (data), or the projectSettings.advancedLlm.notSet fallback text if empty.",
        },
      },
      "projectSettings.advancedLlm.providerFrontier": {
        description: "Radio-option description for the Frontier (recommended, default) completion provider.",
        placeholders: {
          name: "The bold provider name, already translated via projectSettings.advancedLlm.providerFrontierName and wrapped in <strong> by the caller.",
          domain: "The literal, untranslated hostname 'api.frontierrnd.com', styled as inline code by the caller — insert exactly as given.",
        },
      },
      "projectSettings.advancedLlm.providerCustom": {
        description:
          "Radio-option description for the custom-endpoint completion provider. The " +
          "parenthetical service names (OpenRouter, OpenAI, Groq, Together) are brand " +
          "names and stay as written in every locale.",
        placeholders: {
          name: "The bold provider name, already translated via projectSettings.advancedLlm.providerCustomName and wrapped in <strong> by the caller.",
        },
      },
      "projectSettings.advancedLlm.endpointHelp": {
        description: "Help text under the custom-endpoint URL input, naming the two accepted trailing path forms.",
        placeholders: {
          v1Path: "The literal, untranslated path '/v1', styled as inline code by the caller — insert exactly as given.",
          chatCompletionsPath: "The literal, untranslated path '/chat/completions', styled as inline code by the caller — insert exactly as given.",
        },
      },
      "projectSettings.advancedLlm.connectedStatus": {
        description: "Status line shown after successfully connecting to a custom endpoint, naming how many models it exposed.",
        placeholders: {
          count: "How many models the endpoint returned.",
        },
      },
      "projectSettings.advancedLlm.modelManualHelp": {
        description: "Help text under the manual model-id input, shown when the endpoint returned no model list.",
        placeholders: {
          modelsPath: "The literal, untranslated path '/models', styled as inline code by the caller — insert exactly as given.",
        },
      },
      "projectSettings.advancedLlm.modelOverrideHelp": {
        description: "Help text under the optional model-override input for the Frontier provider.",
        placeholders: {
          example: "An example OpenRouter model id, e.g. 'anthropic/claude-3.5-sonnet', styled as inline code by the caller — data, not translated.",
        },
      },
      "projectSettings.advancedLlm.temperatureLabel": {
        description: "Field label for the temperature slider, showing its current value live.",
        placeholders: {
          value: "The current temperature value, e.g. '0.3'.",
        },
      },
      "projectSettings.advancedLlm.healthPenaltyLabel": {
        description: "Field label for the LLM health-penalty slider, showing its current value live.",
        placeholders: {
          percent: "The current penalty as a whole-number percentage, e.g. '10'.",
        },
      },
      "projectSettings.cellEditing.optionNone": {
        description:
          "First option in the 'Who can add and remove cells' dropdown, and the " +
          "value every project starts on. It is not a role — it means nobody at " +
          "all, including the project's owner. Keep the 'default' note: it is " +
          "what tells an admin this list has never been touched. Translate the " +
          "word 'default'; the dash is an em dash separating the two halves.",
      },
      "projectSettings.cellEditing.optionCommenter": {
        description:
          "Role option in the 'Who can add and remove cells' dropdown, naming the " +
          "lowest rank that may be granted the affordance. Translate the role " +
          "name exactly as common.role.commenter is translated — this list must " +
          "read identically to the Members panel. The number in brackets is the " +
          "role's level on the permission ladder: data, never translated.",
      },
      "projectSettings.cellEditing.optionReviewer": {
        description:
          "Role option in the 'Who can add and remove cells' dropdown. Translate " +
          "the role name exactly as common.role.reviewer is translated; the " +
          "bracketed number is the role's ladder level, data, never translated.",
      },
      "projectSettings.cellEditing.optionContributor": {
        description:
          "Role option in the 'Who can add and remove cells' dropdown. Translate " +
          "the role name exactly as common.role.contributor is translated; the " +
          "bracketed number is the role's ladder level, data, never translated.",
      },
      "projectSettings.cellEditing.optionProjectLead": {
        description:
          "Role option in the 'Who can add and remove cells' dropdown. Translate " +
          "the role name exactly as common.role.projectLead is translated; the " +
          "bracketed number is the role's ladder level, data, never translated.",
      },
      "projectSettings.cellEditing.optionMaintainer": {
        description:
          "Role option in the 'Who can add and remove cells' dropdown, and the " +
          "strictest rank the setting can name. Translate the role name exactly " +
          "as common.role.maintainer is translated; the bracketed number is the " +
          "role's ladder level, data, never translated.",
      },
      "projectSettings.harmonization.defaultRoleSuffix": {
        description:
          "Marks a role option in the harmonization minimum-role select as the " +
          "current default.",
        placeholders: {
          role: "The already-localized role display name (via resolveRoleName/common.role.*), e.g. 'Project lead'.",
        },
      },
      "projectSettings.gitSync.originLabel": {
        description: "Small note on the Git Sync card naming the configured git origin and branch.",
        placeholders: {
          url: "The git clone URL (data, not translated), styled as monospace by the caller.",
          branch: "The git branch name (data, not translated), styled as monospace by the caller.",
        },
      },
      "projectSettings.decay.maxHopsDescription": {
        description: "Help text under the 'Max hops' input on the Health (decay) panel.",
        placeholders: {
          defaultValue: "The default max-hops value as a plain number (data), e.g. '4'.",
        },
      },
      "projectSettings.decay.attentionThresholdDescription": {
        description: "Help text under the 'Attention threshold' input on the Health (decay) panel.",
        placeholders: {
          defaultValue: "The default threshold value as a plain number (data), e.g. '0.4'.",
        },
      },
      "projectSettings.sourceLink.gateLabel": {
        description: "Small badge on the Source link card naming the sync gate for a chain (consumes-target) link.",
        placeholders: {
          value: "The rendered projectSettings.sourceLink.gateValidatedOnly or gateEveryCommit string — insert exactly as given.",
        },
      },
      "projectSettings.sourceLink.scopeSomeFiles": {
        description:
          "Small badge on the Source link card saying how many of the upstream project's files this link follows, for a link made with only some of them picked.",
        placeholders: {
          count: "How many of the upstream's files this link follows (data, a plain integer), e.g. '2'.",
          total:
            "How many files the upstream project has in total (data, a plain integer), e.g. '3'. The plural form is chosen from THIS number.",
        },
      },
      "projectSettings.sourceLink.cursorLabel": {
        description: "Small badge on the Source link card naming the link's current sync cursor position, for a live (non-clone) link.",
        placeholders: {
          value: "The cursor position (data, a plain integer), e.g. '42'.",
        },
      },
      "projectSettings.sourceLink.typeToConfirm": {
        description: "Instruction above the detach-confirmation input, naming the exact word the user must type.",
        placeholders: {
          word: "The literal, untranslated confirmation word 'DETACH' the user must type verbatim — styled bold-monospace by the caller. Never translate this word: the input is validated against the exact English literal.",
        },
      },
      "projectSettings.languages.archiveConfirm": {
        description: "Inline confirmation prompt shown before archiving one target lane.",
        placeholders: {
          lane: "The lane's language tag (data, not translated).",
        },
      },
      "projectSettings.languages.lastChange": {
        description:
          "Inside the archive-lane confirmation: when this lane was last translated in, and " +
          "by whom. Tells the project manager whether the lane is dormant or someone is " +
          "working in it right now, because archiving locks the lane's translators out of " +
          "editing. Shown only to people who may archive the lane.",
        placeholders: {
          date: "The already-formatted, locale-aware date of the edit (data) — insert exactly as given, do not reformat or reorder its parts.",
          editor: "The editing member's username (data, never translated).",
        },
      },
      "projectSettings.languages.lastChangeUnknownEditor": {
        description:
          "Same as projectSettings.languages.lastChange, for a lane whose newest edit " +
          "records no editor name (an imported or pre-attribution row). Keep the two " +
          "wordings consistent — only the trailing \"by <name>\" is dropped.",
        placeholders: {
          date: "The already-formatted, locale-aware date of the edit (data) — insert exactly as given, do not reformat or reorder its parts.",
        },
      },
      "projectSettings.languages.archiveLaneAriaLabel": {
        description: "Accessible name of the archive-icon button for one target lane row.",
        placeholders: {
          lane: "The lane's language tag (data, not translated).",
        },
      },
      "projectSettings.languages.restoreLaneAriaLabel": {
        description: "Accessible name of the restore button for one archived target lane row.",
        placeholders: {
          lane: "The lane's language tag (data, not translated).",
        },
      },
      "projectSettings.languages.suggestionsAriaLabel": {
        description:
          "Accessible name of the dropdown list of languages that appears under a " +
          "source/target language field as the user types (AQU-988). Screen-reader " +
          "only — the list itself shows language names, so this just says what the " +
          "list is. The field still accepts any typed text, so avoid wording that " +
          "implies these are the only allowed values.",
        maxLength: 30,
      },
      "projectSettings.localModels.notDownloadedBadge": {
        description: "Badge on a not-yet-downloaded local AI model row, stating its download size.",
        placeholders: {
          size: "The model's download size in megabytes, as a plain number (data), e.g. '140'.",
        },
      },
      "projectSettings.members.filterAriaLabel": {
        description:
          "Accessible name of the access-source filter select on the Members table " +
          "toolbar (All / Project grants / Via organization). The select shows only the " +
          "current choice, not a separate visible label.",
      },
      "projectSettings.monday.orgSettingsLinkText": {
        description:
          "The words 'organization settings', used both as the visible text of a link to " +
          "the org's Monday connection settings and, when the caller lacks a linkable " +
          "org id, as the same words rendered plain (no link) inside " +
          "projectSettings.monday.orgNotConnectedInstructions.",
      },
      "projectSettings.monday.orgNotConnectedInstructions": {
        description:
          "Second line of the read-only 'org not connected' notice shown to a project " +
          "member who cannot manage the Monday integration themselves.",
        placeholders: {
          settingsLink: "The rendered projectSettings.monday.orgSettingsLinkText string — insert exactly as given; the caller wraps it in a link when one is available.",
        },
      },
      "projectSettings.monday.removeBoardLinkDescription": {
        description: "Body text of the confirmation dialog before unlinking the project's Monday board.",
        placeholders: {
          boardName: "The linked board's name (data, not translated), or a generic fallback noun if unknown.",
        },
      },
      "projectSettings.monday.oneItemPerLabel": {
        description:
          "Small note under the linked-board status row, naming what one Monday board " +
          "item corresponds to.",
        placeholders: {
          granularity: "The literal, untranslated word 'file' or 'project' (data) — matches the value stored on the link's itemGranularity setting, not a separately translated enum.",
        },
      },
      "projectSettings.monday.lastPushOk": {
        description:
          "Status sentence under the linked-board row after a successful Monday.com " +
          "progress push; {date} is a hover-dated relative timestamp.",
        placeholders: {
          date: "A DateTooltip element rendering the last push time (data, not translated).",
        },
      },
      "projectSettings.monday.lastPushFailed": {
        description:
          "Status sentence under the linked-board row after the last Monday.com " +
          "progress push failed; a red error line follows it.",
        placeholders: {
          date: "A DateTooltip element rendering the last push time (data, not translated).",
        },
      },
      "projectSettings.monday.notPushedYet": {
        description:
          "Status sentence under the linked-board row when no Monday.com progress " +
          "push has happened yet for this project.",
      },
      "projectSettings.monday.boardSelectAriaLabel": {
        description:
          "Accessible name of the Monday-board picker select, in both the manual link " +
          "flow and the AI setup wizard's board-change control. No separate visible " +
          "label — only a placeholder inside the closed select.",
      },
      "projectSettings.monday.removeBoardLinkAriaLabel": {
        description: "Accessible name of the icon-only trash button that opens the remove-board-link confirmation.",
      },
      "projectSettings.monday.removeMappingRowAriaLabel": {
        description: "Accessible name of the icon-only trash button that deletes one column-mapping row.",
      },
      "projectSettings.gitSync.autoSyncIntervalAriaLabel": {
        description:
          "Accessible name of the numeric minutes input beside the auto-sync toggle — " +
          "no separate visible label, just the enable switch, this input, and a trailing 'min' unit.",
      },
      "projectSettings.members.actionsForRow": {
        description:
          "Accessible name of the icon-only row-actions button in the last column " +
          "of the project Members table, naming which member's row it opens.",
        placeholders: {
          username: "The row's member username (data, not translated).",
        },
      },
      "projectSettings.members.roleChangeNeedsRole": {
        description:
          "Shown on the project Members table when the VIEWER's own role is below the " +
          "floor for managing membership: as a disabled row-menu note in place of " +
          "'Change role', and as the tooltip on the disabled 'Add a member' button. " +
          "States the required role rather than leaving the control silently missing.",
        placeholders: {
          role: "The localized name of the required role (today 'Project lead'), resolved from the role ladder — insert exactly as given.",
        },
      },
      "projectSettings.members.roleChangeOutranked": {
        description:
          "Disabled note in a project Members row menu, shown in place of 'Change role' " +
          "when the viewer may manage membership in general but not THIS member, whose " +
          "current role is at or above the viewer's own.",
      },
      "projectSettings.create.upstreamProjectSearchAriaLabel": {
        description:
          "Accessible name of the search box inside the Create New Project dialog's " +
          "\"Upstream project\" picker (AQU-1518). Screen-reader-only — never rendered " +
          "as visible text; the visible hint is upstreamProjectSearchPlaceholder. " +
          "\"Projects\" here means Aquilla translation projects, the same sense as " +
          "projectSettings.create.upstreamProjectLabel.",
      },
      "projectSettings.linkSource.pickerSearchAriaLabel": {
        description:
          "Accessible name of the search box inside the \"Link to a source project\" " +
          "picker in Project Settings → Source & sync (AQU-1525). Screen-reader-only — " +
          "never rendered as visible text; the visible hint is " +
          "projectSettings.linkSource.pickerSearchPlaceholder. \"Projects\" here means " +
          "Aquilla translation projects, the same sense as " +
          "projectSettings.linkSource.pickerLabel.",
      },
      // AQU-1526 — the confirm step between picking an upstream and linking it.
      "projectSettings.linkSource.previewTitle": {
        description:
          "Heading of the confirm step in Project Settings \u2192 Source & sync, shown after " +
          "an upstream project has been picked and before anything is linked. A " +
          "question, because the step can still be cancelled.",
        placeholders: {
          upstream: "The display name of the upstream project about to be linked, as the user named it \u2014 never translated.",
        },
      },
      "projectSettings.linkSource.previewCount": {
        description:
          "The confirm step's headline fact: how many source files the link will " +
          "mirror into this project. Shown only when the upstream has at least one " +
          "file (an upstream with none gets previewEmptyUpstream instead, never " +
          "\"0 source files\"). \"Source files\" are the upstream's own source-side " +
          "files, not file uploads.",
        placeholders: {
          count: "How many upstream source files will be added; governs the plural form.",
        },
      },
      "projectSettings.linkSource.previewEmptyUpstream": {
        description:
          "Replaces the file count in the confirm step when the chosen upstream has " +
          "no source files yet. Reassuring, not a refusal: the link is still " +
          "allowed, and files appear here as the upstream gains them.",
      },
      "projectSettings.linkSource.previewLoading": {
        description:
          "Transient line in the confirm step while the upstream's file list is being " +
          "read, before the count and any same-name warning can be shown.",
      },
      "projectSettings.linkSource.previewLoadError": {
        description:
          "Shown in the confirm step when the upstream's file list could not be read, " +
          "so the step cannot say what the link would add. Deliberately distinct from " +
          "previewEmptyUpstream \u2014 \"we don't know\" is not \"nothing is coming\" \u2014 and it " +
          "states that nothing has been linked, because the user is mid-action.",
      },
      "projectSettings.linkSource.previewRetryButton": {
        description:
          "Retry button with two homes in the link flow. Beside previewLoadError it " +
          "re-reads the upstream's file list; beside seedFailedMessage it re-runs the " +
          "sync that brings the linked project's files in. In both it repeats the " +
          "step that just failed — never a page reload, and never the link itself.",
      },
      "projectSettings.linkSource.seedFailedMessage": {
        description:
          "Shown after a link was saved but the first sync that copies the source " +
          "project's files in failed. Appears in the Import dialog, on the settings " +
          "card and as a banner on the project page, next to a \"Try again\" button. " +
          "Three facts in order: the link exists, the files are missing, retrying is " +
          "the fix. Plain language — no error code and no technical cause.",
      },
      "projectSettings.linkSource.seedRetryFailedNote": {
        description:
          "Added under seedFailedMessage when the user pressed \"Try again\" and that " +
          "failed as well. \"Them\" is the source project's files from the sentence " +
          "above. Reassures that the link itself was not lost and the retry is still " +
          "there.",
      },
      "projectSettings.linkSource.seedRetryingButton": {
        description:
          "Label of the \"Try again\" button beside seedFailedMessage while its retry " +
          "is running; the button is disabled meanwhile.",
      },
      "projectSettings.sourceLink.chooseFilesButton": {
        description:
          "Button on the Source link card (Project Settings) that opens a list of the " +
          "upstream project's files, to add more of them to this project's link. A " +
          "verb phrase: 'choose' as in pick.",
      },
      "projectSettings.sourceLink.chooseFilesTitle": {
        description:
          "Title of the dialog listing the upstream project's files with checkboxes. " +
          "Files already linked are checked and cannot be unchecked; the rest can be " +
          "checked to add them.",
      },
      "projectSettings.sourceLink.chooseFilesLinkedBadge": {
        description:
          "Small label beside a file in that list that this project already receives " +
          "from the upstream, explaining why its checkbox is checked and locked.",
      },
      "projectSettings.sourceLink.chooseFilesAddButton": {
        description:
          "The dialog's confirm button: brings the checked files into this project. " +
          "The sentence above it states how many.",
      },
      // AQU-1562: the confirm step shown before a link's file choice changes.
      // Each heading introduces a bulleted list of file names; the body beneath
      // it is the promise made about exactly those files. Headings and bodies
      // are paired, so a translator should read each pair together.
      "projectSettings.sourceLink.chooseFilesStopHeading": {
        description:
          "Heading over the list of files that will STOP being followed, in the confirm " +
          "step of \"Choose files\" (Project Settings → Source link). Ends in a colon: the " +
          "file names follow immediately beneath it. The number is never printed — it only " +
          "chooses the form, so a language with more plural categories needs each of them.",
      },
      "projectSettings.sourceLink.chooseFilesStopBody": {
        description:
          "Under the stop list: what stopping does to those files. The reassurance is the " +
          "point — before this existed, the only ways to stop following a file were to " +
          "delete it (losing its translations) or to detach the whole project. Say plainly " +
          "that the file stays with everything on it and only stops receiving changes.",
      },
      "projectSettings.sourceLink.chooseFilesStopOthersNote": {
        description:
          "One more sentence under the stop list: the link's OTHER files are unaffected. " +
          "Stopping is per file, and a lead stopping one book needs to know the rest keeps " +
          "arriving.",
      },
      "projectSettings.sourceLink.chooseFilesStopWholeProjectWarning": {
        description:
          "Warning in the same confirm, shown only when the link currently follows the whole " +
          "source project. Stopping one file turns it into a fixed list of the rest, so files " +
          "the source project adds later stop arriving on their own — a consequence nobody " +
          "asked for, hence stating it before it happens. \"Pins\" as in fixes/locks to.",
      },
      "projectSettings.sourceLink.chooseFilesKeepOneError": {
        description:
          "Shown in place of the confirm when every followed file has been unchecked. A link " +
          "following no files could never bring anything in; stopping everything is the " +
          "separate \"Detach from source\" action on the same card, which the sentence names " +
          "in quotes — translate that name the same way it is translated on the button.",
      },
      "projectSettings.sourceLink.chooseFilesResumeHeading": {
        description:
          "Heading over the list of previously-stopped files that will be followed AGAIN. " +
          "Distinct from the add heading below because the file is already in the project: " +
          "this resumes it rather than bringing a new one in. Ends in a colon; names follow.",
      },
      "projectSettings.sourceLink.chooseFilesResumeBody": {
        description:
          "Under the resume list: the one thing resuming costs. The file's source text is " +
          "replaced with the source project's current text — the lead may have been editing " +
          "it in the meantime — while the translations on it are kept. Both halves matter.",
      },
      "projectSettings.sourceLink.chooseFilesReplaceHeading": {
        description:
          "Heading in the Choose files confirm step over the list of files the project " +
          "already has whose source the added upstream files will replace (AQU-1679). Ends " +
          "in a colon; names follow. Kept apart from the add heading: these files are not " +
          "arriving, they are being joined to the link.",
      },
      "projectSettings.sourceLink.chooseFilesReplaceBody": {
        description:
          "Under the replace list: the file keeps its identity and everything on it " +
          "(translations, validations, comments) line by line; only its source text " +
          "becomes the source project's, and it follows the source project afterwards. " +
          "Says explicitly that no second copy is added \u2014 the thing a lead fears here.",
      },
      "projectSettings.sourceLink.chooseFilesAddHeading": {
        description:
          "Heading over the list of files being added that this project never held. Ends in " +
          "a colon; names follow. Kept apart from the resume heading above, which promises " +
          "something different.",
      },
      "projectSettings.sourceLink.chooseFilesAddBody": {
        description:
          "Under the add list: an added file arrives with its WHOLE current source, not only " +
          "the changes made from now on, and follows the source project afterwards like any " +
          "other linked file.",
      },
      "projectSettings.sourceLink.chooseFilesStoppedBadge": {
        description:
          "Small label beside a file in the \"Choose files\" list that this project stopped " +
          "following: it is here with its translations but no longer receives the source " +
          "project's changes. Explains why its checkbox is clear when the file is plainly in " +
          "the project, and warns that checking it replaces its source text.",
      },
      "projectSettings.sourceLink.chooseFilesReviewButton": {
        description:
          "The \"Choose files\" dialog's primary button when the lead has stopped or resumed a " +
          "file: it opens the confirm step rather than acting, since those carry promises the " +
          "checkboxes do not. A verb phrase.",
      },
      "projectSettings.sourceLink.chooseFilesConfirmTitle": {
        description: "Title of that confirm step, replacing the file-list dialog's own title.",
      },
      "projectSettings.sourceLink.chooseFilesApplyingButton": {
        description:
          "Label of the confirm step's button while the changes are being saved; the button is " +
          "disabled meanwhile.",
      },
      "projectSettings.sourceLink.chooseFilesIncomplete": {
        description:
          "Error under the list when the files could not all be brought in. Nothing " +
          "is half-added: the files are not in the project yet, and pressing the " +
          "button again resumes.",
      },
      "projectSettings.sourceLink.notSyncedBadge": {
        description:
          "Badge on the Source link settings card, in the row with \"Live\", for a " +
          "link that has never brought any content through. Replaces the cursor " +
          "badge. A state, not an error — keep it as short as the other badges.",
      },
      "projectSettings.sourceLink.notSyncedNote": {
        description:
          "Explains the \"Not synced yet\" badge on the Source link settings card and " +
          "points at the \"Sync now\" button beside it. The link exists; what is " +
          "missing is the source project's files.",
      },
      "projectSettings.sourceLink.syncNowButton": {
        description:
          "Button on the Source link settings card that runs the sync bringing the " +
          "linked source project's files into this project. Shown only while the link " +
          "has never synced.",
      },
      "projectSettings.sourceLink.syncingButton": {
        description: "Label of the \"Sync now\" button while that sync is running; the button is disabled meanwhile.",
      },
      "projectSettings.sourceLink.syncFailedNote": {
        description:
          "Replaces notSyncedNote after \"Sync now\" failed. Says the files did not " +
          "come in, that the link was not lost, and that the button can be pressed " +
          "again. No error code and no technical cause.",
      },
      "projectSettings.sourceLink.syncNothingYetNote": {
        description:
          "Replaces notSyncedNote after \"Sync now\" worked but the source project is " +
          "empty, so there was nothing to copy. Reassuring, not an error: files will " +
          "appear once the source project has some.",
      },
      "projectSettings.linkSource.additiveNoteReplacing": {
        description:
          "Replaces additiveNote under the link confirm step once at least one " +
          "existing file is set to have its source replaced. Same reassurance, minus " +
          "the claim that existing files are untouched: the replaced files' source " +
          "text changes and keeps following the upstream; translations and " +
          "validations are still never touched.",
      },
      "projectSettings.linkSource.replaceOption": {
        description:
          "Checkbox under an upstream file in the link confirm step, shown when this " +
          "project already has exactly one file of the same name. On: the link " +
          "follows into that existing file \u2014 its source text is replaced by the " +
          "source project's and its translations stay \u2014 instead of adding a second " +
          "file of that name. Off by default.",
        placeholders: {
          name: "The file's name as the user named it \u2014 never translated.",
        },
      },
      "projectSettings.linkSource.replaceComparing": {
        description:
          "Shown under replaceOption right after it is turned on, while the server " +
          "compares the project's file with the source project's file.",
      },
      "projectSettings.linkSource.replaceCompareFailed": {
        description:
          "Shown under replaceOption when the comparison could not be made. The link " +
          "cannot be confirmed with the option on until a comparison succeeds; the " +
          "sentence gives both ways out. No error code.",
      },
      "projectSettings.linkSource.replaceMatchSame": {
        description:
          "First line of the comparison under replaceOption: how many lines of text " +
          "are word-for-word identical in the project's file and the source project's " +
          "file. \"Lines\" are the file's translation units (verses, paragraphs).",
        placeholders: {
          same: "How many lines are identical in both files.",
          count: "How many lines the longer of the two files has; governs the plural form.",
        },
      },
      "projectSettings.linkSource.replaceMatchChanged": {
        description:
          "Comparison line, shown only when above zero: lines that correspond but " +
          "whose source text differs. They take the source project's text, and their " +
          "existing translations get the app's \"source changed\" flag for review.",
        placeholders: {
          count: "How many lines will take the source project's text; governs the plural form.",
        },
      },
      "projectSettings.linkSource.replaceMatchAdded": {
        description:
          "Comparison line, shown only when above zero: lines the source project's " +
          "file has and the project's file does not. They are added to the project's file.",
        placeholders: {
          count: "How many lines will be added; governs the plural form.",
        },
      },
      "projectSettings.linkSource.replaceMatchKept": {
        description:
          "Comparison line, shown only when above zero: lines the project's file has " +
          "and the source project's file does not. Nothing happens to them.",
        placeholders: {
          count: "How many lines only this project's file has; governs the plural form.",
        },
      },
      "projectSettings.linkSource.replaceNoMatch": {
        description:
          "Replaces the comparison when fewer than half of the lines are identical: " +
          "the two files share a name but are not the same text, so the source cannot " +
          "be replaced. The link stays unconfirmable until the option is turned off.",
        placeholders: {
          same: "How many lines are identical in both files.",
          count: "How many lines the longer of the two files has; governs the plural form.",
        },
      },
      "projectSettings.linkSource.replaceCount": {
        description:
          "Summary sentence in the link confirm step, beside the count of files that " +
          "will be added: how many existing files will follow the link in place " +
          "(source replaced, translations kept) rather than gaining a second copy.",
        placeholders: {
          count: "How many existing files will follow the link; governs the plural form.",
        },
      },
      "projectSettings.linkSource.clashWarningHeading": {
        description:
          "Opens the confirm step's warning that some upstream files share a name with " +
          "files this project already has; the names follow as a list. Ends in a colon " +
          "for that reason. A caution, not an error \u2014 the link is still allowed.",
      },
      "projectSettings.linkSource.clashWarningBody": {
        description:
          "Follows the clashing file names and says what will happen: the project's " +
          "own files are kept untouched with their translations, and the mirrored " +
          "copies arrive beside them with empty translations, so each name appears " +
          "twice in the file list. Nothing is overwritten or merged.",
      },
      "projectSettings.linkSource.reviewButton": {
        description:
          "Button that leaves the picker and opens the confirm step. It links nothing " +
          "by itself \u2014 the wording has to make that clear, because the press that " +
          "actually links is linkButton on the next step.",
      },
      "projectSettings.linkSource.cancelButton": {
        description:
          "Backs out of the confirm step to the picker without linking. The picked " +
          "project is kept, so this is \"not yet\", not \"discard\".",
      },
      "projectSettings.termMatching.title": {
        description: "Heading of the project-settings card for the project's shared prefix/suffix affix inventory.",
      },
      "projectSettings.termMatching.description": {
        description:
          "Explains what the affix inventory is for — it only takes effect on terms with " +
          "\"Allow prefixes and suffixes\" enabled.",
      },
      "projectSettings.termMatching.prefixes": {
        description: "Label and accessible name of the prefix tag-input row in the affix inventory editor.",
      },
      "projectSettings.termMatching.suffixes": {
        description: "Label and accessible name of the suffix tag-input row in the affix inventory editor.",
      },
      "projectSettings.termMatching.maxAffixes": {
        description: "Label of the numeric input capping how many chained affixes are allowed per side (1-4).",
      },
      "projectSettings.termMatching.foldMarksDefault": {
        description:
          "Label of the switch that sets the project-wide default for ignoring vowel marks/accents " +
          "when matching terms, absent a per-concept override.",
      },
      "projectSettings.termMatching.loadPreset": {
        description: "Button that opens a menu of built-in affix presets (Hebrew, Arabic, Swahili, Turkish, …) to load.",
      },
      "projectSettings.termMatching.addAffixPlaceholder": {
        description: "Placeholder text in the prefix/suffix tag-input fields.",
      },
      "projectSettings.termMatching.remove": {
        description: "Accessible name of the small remove button on one affix chip.",
        placeholders: {
          affix: "The affix text on the chip being removed (data, not translated).",
        },
      },
      "projectSettings.termMatching.preset.hebrew": {
        description: "Name of a language whose affix preset can be loaded into the terminology matching settings.",
      },
      "projectSettings.termMatching.preset.arabic": {
        description: "Name of a language whose affix preset can be loaded into the terminology matching settings.",
      },
      "projectSettings.termMatching.preset.swahili": {
        description: "Name of a language whose affix preset can be loaded into the terminology matching settings.",
      },
      "projectSettings.termMatching.preset.turkish": {
        description: "Name of a language whose affix preset can be loaded into the terminology matching settings.",
      },
    },
  },
  surfaces: [],
})
