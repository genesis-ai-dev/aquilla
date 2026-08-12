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

    // ── Project creation dialog ──
    "projectSettings.create.trigger": "New Project",
    "projectSettings.create.dialogTitle": "Create New Project",
    // AQU-832: no separate create.nameLabel/sourceLanguageLabel/targetLanguageLabel —
    // this dialog reuses projectSettings.info.{nameLabel,sourceLanguageLabel,
    // targetLanguageLabel} (the settings-page Project Info card's field labels)
    // rather than minting Title-Case-vs-sentence-case duplicates of the same word.
    "projectSettings.create.namePlaceholder": "My Translation Project",
    "projectSettings.create.sourceLanguagePlaceholder": "English, Grade 7 English, es-419…",
    "projectSettings.create.targetLanguagesLabel": "Target language(s)",
    "projectSettings.create.targetLanguagePlaceholder": "French, conversational Swahili, zh-Hant…",
    "projectSettings.create.languageHintAriaLabel": "What can I enter here?",
    "projectSettings.create.languageHintTooltip":
      "Any label works — a BCP-47 tag, a language name, or a register description " +
      "(e.g. \"Grade 7 English\", \"conversational Swahili\").",
    "projectSettings.create.advancedShapeSummary": "Advanced: project shape",
    "projectSettings.create.shapeSelfContainedName": "Self-contained",
    "projectSettings.create.shapeSelfContained": "{name} — owns its source and target.",
    "projectSettings.create.shapeSourceOnlyName": "Source-only",
    "projectSettings.create.shapeSourceOnly":
      "{name} — a canonical source others link against. No target.",
    "projectSettings.create.shapeLinkedTargetName": "Linked target",
    "projectSettings.create.shapeLinkedTarget":
      "{name} — reads source from another project; owns only its target.",
    "projectSettings.create.upstreamProjectLabel": "Upstream project",
    "projectSettings.create.upstreamProjectPlaceholder": "Choose a project to link from…",
    "projectSettings.create.linkModeLabel": "Clone or live?",
    // AQU-832: no separate create.linkModeLiveName/linkModeCloneName — reuses
    // projectSettings.sourceLink.modeLive/modeClone (the Source Link card's
    // mode badges), the same "Live"/"Clone" vocabulary this dialog is choosing.
    "projectSettings.create.linkModeLive":
      "{name} — stays subscribed; upstream fixes propagate here automatically.",
    "projectSettings.create.linkModeClone":
      "{name} — one-time snapshot; this project becomes independent immediately.",
    "projectSettings.create.linkConsumesLabel": "What should become this project's source?",
    "projectSettings.create.linkConsumesSourceName": "Its source",
    "projectSettings.create.linkConsumesSource":
      "{name} — sibling-translation case (this project translates the same original " +
      "text). For same-org sibling languages, a target lane on the upstream project " +
      "is the recommended shape instead.",
    "projectSettings.create.linkConsumesTargetName": "Its translations",
    "projectSettings.create.linkConsumesTarget":
      "{name} — chain case (this project translates the upstream project's target, " +
      "e.g. French → Chaluba).",
    "projectSettings.create.submitCreating": "Creating…",
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
    "projectSettings.share.roleFieldLabel": "Role",
    "projectSettings.share.signInToCreateLink": "Sign in to create an invite link",
    "projectSettings.share.recipientEmailLabel": "Recipient email",
    "projectSettings.share.optionalFieldNote": "(optional)",
    "projectSettings.share.emailPlaceholder": "name@example.com",
    "projectSettings.share.emailRestrictedNote":
      "Only an account with this email can redeem this link.",
    "projectSettings.share.openLinkNote":
      "Leave blank for an open link anyone signed in can redeem.",
    "projectSettings.share.linkExpiresLabel": "Link expires",
    "projectSettings.share.expiryOneDay": "1 day",
    "projectSettings.share.expirySevenDays": "7 days",
    "projectSettings.share.expiryThirtyDaysDefault": "30 days (default)",
    "projectSettings.share.expiryNoExpiry": "No expiry",
    // "Creating…" button-busy label → projectSettings.create.submitCreating (identical text)
    "projectSettings.share.createInviteLinkButton": "Create invite link",
    "projectSettings.share.loadingActiveLinks": "Loading active links…",
    "projectSettings.share.activeLinksHeading": "Active links",
    "projectSettings.share.openLinkConnector": "open link",
    "projectSettings.share.expiresOn": "Expires {date}",
    "projectSettings.share.revokeButton": "Revoke",
    "projectSettings.share.revokeLinkAriaLabel": "Revoke this invite link",

    // ── Page chrome (nav, groups, save bar, discard dialog) ──
    "projectSettings.pageTitle": "Project settings",
    "projectSettings.pageDescription": "Configure this project. Changes apply to everyone with access.",
    "projectSettings.searchPlaceholder": "Search settings…",
    "projectSettings.searchAriaLabel": "Search settings",
    "projectSettings.backLinkLabel": "Settings",
    "projectSettings.breadcrumbEditor": "Editor",
    "projectSettings.saveChanges": "Save changes",
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
    "projectSettings.group.generalLabel": "General",
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
    "projectSettings.ai.topKDescription": "How many reference examples the AI retrieves per translation (1–20). Default: 5.",
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
    "projectSettings.advancedLlm.connectionFailedError": "Connection failed",
    "projectSettings.loadingLabel": "Loading project settings",
    "projectSettings.advancedLlm.apiKeyLabelRequired": "API key *",
    "projectSettings.advancedLlm.apiKeyLabelOptional": "API key (optional)",
    "projectSettings.advancedLlm.apiKeyPlaceholderRequired": "Paste your API key",
    "projectSettings.advancedLlm.apiKeyPlaceholderNoAuth": "Leave blank for no auth",
    "projectSettings.advancedLlm.apiKeyHelp": "Sent as Authorization: Bearer <key>. Stored locally in your browser; never uploaded to Frontier.",
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
    "projectSettings.advancedLlm.modelOverrideHelp": "Optionally specify an OpenRouter model (e.g. {example}).",
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
    "projectSettings.terminology.description": "Manage approved terms, renderings, and the project glossary (term base).",
    "projectSettings.terminology.openButton": "Open Terminology Library",

    // ── ValidationSettingsSection.tsx ──
    "projectSettings.validation.requiredTextLabel": "Required validators (text)",
    "projectSettings.validation.requiredTextDescription": "Cells need this many distinct validators to count as fully validated.",
    "projectSettings.validation.requiredAudioLabel": "Required validators (audio)",
    "projectSettings.validation.requiredAudioAppliesNote": "Applies to audio translations.",
    "projectSettings.validation.requiredAudioDisabledNote": "Enabled once audio translations exist.",
    "projectSettings.validation.minRoleLabel": "Minimum validator role",
    "projectSettings.validation.minRoleDescription": "Only users with at least this role can cast a validation vote. Defaults to reviewer.",
    "projectSettings.validation.allowSelfLabel": "Allow self-validation",
    "projectSettings.validation.allowSelfDescription": "When off, a contributor's vote on their own commit is ignored.",
    "projectSettings.validation.namedValidatorsLabel": "Named validators (optional)",
    "projectSettings.validation.namedValidatorsPlaceholder": "alice, bob, carol",
    "projectSettings.validation.namedValidatorsDescription":
      "Comma-separated usernames. When set, only these users' votes count toward the " +
      "threshold (AND'd with the role floor). Leave empty to allow any " +
      "sufficiently-privileged user.",

    // ── DecaySettingsSection.tsx ──
    "projectSettings.decay.summary": "Retrieval support",
    "projectSettings.decay.description":
      "This support signal measures proximity to approved neighboring cells in the " +
      "retrieval graph. It can prioritize review, but it is not a translation-quality " +
      "score and never removes the human-review requirement.",
    "projectSettings.decay.maxHopsLabel": "Max hops",
    "projectSettings.decay.maxHopsDescription":
      "Propagation radius from approved cells. Larger values let support ripple " +
      "further through the retrieval graph. Default {defaultValue}.",
    "projectSettings.decay.attentionThresholdLabel": "Attention threshold",
    "projectSettings.decay.attentionThresholdDescription":
      "Low support beyond this threshold shows the cell's review-priority marker " +
      "(0–1). Default {defaultValue}.",

    // ── AudioMediaStrategySection.tsx ──
    "projectSettings.audioMedia.title": "Audio loading",
    "projectSettings.audioMedia.description":
      "Decide when audio recordings are downloaded from storage to this device. You " +
      "can switch any time without re-recording — only future loads are affected.",
    "projectSettings.audioMedia.strategyStreamName": "Stream",
    "projectSettings.audioMedia.strategyStreamDescription": "Play directly from the network. No local cache, no waveforms unless you opt in.",
    "projectSettings.audioMedia.strategyLazyName": "Lazy (default)",
    "projectSettings.audioMedia.strategyLazyDescription": "Download a cell's audio when you scroll to it or press play. Caches locally.",
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

    // ── LanguagesSection.tsx ──
    "projectSettings.languages.defaultTargetLabel": "Default target language",
    "projectSettings.languages.defaultTargetNote": "The default (unnamed) lane. Change it on Project Info, above.",
    "projectSettings.languages.additionalLanesLabel": "Additional target lanes",
    "projectSettings.languages.additionalLanesDescription":
      "Extra target-language lanes for this project — e.g. dialect variants or " +
      "parallel drafts of the same source.",
    "projectSettings.languages.noAdditionalLanes": "No additional lanes yet.",
    "projectSettings.languages.archiveConfirm":
      "Archive \"{lane}\"? It's hidden from the lane switcher by default but kept — " +
      "its cell data is preserved and you can restore it anytime.",
    "projectSettings.languages.archivingButton": "Archiving…",
    "projectSettings.languages.confirmArchiveButton": "Confirm archive",
    "projectSettings.languages.archiveLaneAriaLabel": "Archive lane {lane}",
    "projectSettings.languages.archivedLanesLabel": "Archived lanes",
    "projectSettings.languages.archivedLanesDescription":
      "Hidden from the lane switcher by default. Their translations are kept; " +
      "restore a lane to make it active again.",
    "projectSettings.languages.restoringButton": "Restoring…",
    "projectSettings.languages.restoreButton": "Restore",
    "projectSettings.languages.restoreLaneAriaLabel": "Restore lane {lane}",
    "projectSettings.languages.addLaneLabel": "Add a target lane",
    // "e.g. fr-CA" placeholder → projectSettings.create.extraLanguagesPlaceholder (identical text)
    "projectSettings.languages.addingButton": "Adding…",
    "projectSettings.languages.addLaneButton": "Add lane",
    "projectSettings.languages.alreadyDefaultError": "This is already the default target language.",
    "projectSettings.languages.alreadyExistsError": "This lane already exists.",
    "projectSettings.languages.conflictError": "Someone else updated shared settings. Refresh to reapply your change.",
    "projectSettings.languages.offlineError": "You're offline. Reconnect to save language lanes.",
    "projectSettings.languages.permissionError": "You don't have permission to change shared settings.",
    "projectSettings.languages.savingFailedGeneric": "Saving failed.",
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
      "projectSettings.create.trigger": {
        description: "Button that opens the create-project dialog. Short, with a leading + icon.",
      },
      "projectSettings.create.targetLanguagesLabel": {
        description:
          "Field label above the target-language input when the chosen project shape " +
          "is self-contained (multiple target lanes allowed).",
      },
      "projectSettings.create.languageHintAriaLabel": {
        description: "Accessible name of the small info-icon button beside a source/target language field that opens an explanatory tooltip.",
      },
      "projectSettings.create.shapeSelfContained": {
        description:
          "One of three radio-option descriptions under 'Advanced: project shape'. " +
          "The bold name is a separate translated+styled placeholder so word order " +
          "can move per locale.",
        placeholders: {
          name: "The bold shape name, already translated via projectSettings.create.shapeSelfContainedName and wrapped in <strong> by the caller.",
        },
      },
      "projectSettings.create.shapeSourceOnly": {
        description: "Second project-shape radio-option description; see shapeSelfContained.",
        placeholders: {
          name: "The bold shape name, already translated via projectSettings.create.shapeSourceOnlyName and wrapped in <strong> by the caller.",
        },
      },
      "projectSettings.create.shapeLinkedTarget": {
        description: "Third project-shape radio-option description; see shapeSelfContained.",
        placeholders: {
          name: "The bold shape name, already translated via projectSettings.create.shapeLinkedTargetName and wrapped in <strong> by the caller.",
        },
      },
      "projectSettings.create.linkModeLive": {
        description:
          "Radio-option description for the 'live' link mode, shown only when shape " +
          "is 'linked-target'.",
        placeholders: {
          name: "The bold mode name, already translated via projectSettings.sourceLink.modeLive and wrapped in <strong> by the caller.",
        },
      },
      "projectSettings.create.linkModeClone": {
        description: "Radio-option description for the 'clone' link mode; see linkModeLive.",
        placeholders: {
          name: "The bold mode name, already translated via projectSettings.sourceLink.modeClone and wrapped in <strong> by the caller.",
        },
      },
      "projectSettings.create.linkConsumesSource": {
        description:
          "Radio-option description for 'consumes source' (sibling-translation case) " +
          "in the linked-target advanced flow.",
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
        description: "Field label for the optional recipient-email input on the invite-link form. The '(optional)' qualifier is a separate, smaller-styled span using projectSettings.share.optionalFieldNote.",
      },
      "projectSettings.share.expiresOn": {
        description: "Row text on an active invite link showing when it expires.",
        placeholders: {
          date: "The already-formatted expiry date (via formatDate), e.g. 'Aug 12, 2026'.",
        },
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
        description: "Help text under the 'Max hops' input on the Retrieval support (decay) panel.",
        placeholders: {
          defaultValue: "The default max-hops value as a plain number (data), e.g. '4'.",
        },
      },
      "projectSettings.decay.attentionThresholdDescription": {
        description: "Help text under the 'Attention threshold' input on the Retrieval support (decay) panel.",
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
    },
  },
  surfaces: [],
})
