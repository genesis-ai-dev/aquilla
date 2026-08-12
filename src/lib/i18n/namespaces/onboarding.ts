import { defineNamespace, plural } from "./types"

/**
 * `onboarding` namespace — registered up front by the swarm orchestrator so parallel
 * agents fill only this file and never contend on the `messages/en.ts` barrel.
 *
 * Every key here MUST be prefixed `onboarding.` — the namespace's name is derived
 * from its first key, not from the filename.
 *
 * Scope (AQU-832 wave 4, WS-12): first-run onboarding (wizard steps, product tour,
 * project setup checklist), and the personal account surfaces reachable from
 * Preferences (workspace/appearance/language/privacy/profile settings, API tokens)
 * plus the credit-usage surfaces (org panel, agent dial) since they render inside
 * those same account/org screens. Shared one-word verbs (Save, Cancel, Close,
 * Back, Next, Dismiss, Add, Loading…, Name, Log in) come from `common.*` — not
 * re-keyed here.
 */
export const onboarding = defineNamespace({
  keys: {
    // — Shared small words reused across this namespace's own surfaces ———————
    "onboarding.common.continue": "Continue",
    "onboarding.common.skipForNow": "Skip for now",
    "onboarding.common.done": "Done",
    "onboarding.common.copy": "Copy",
    // "Copied" reuses `nav.version.copiedLabel` (identical text)
    "onboarding.common.creating": "Creating…",

    // — Shared privacy/analytics vocabulary (PrivacyStep + Preferences' Privacy row) —
    "onboarding.privacy.shareUsageData": "Share usage data",
    "onboarding.privacy.disabledWarning":
      "With analytics disabled, we may not be able to help diagnose problems you encounter.",

    // — Shared time-window labels (credit surfaces + Preferences usage hint) ——
    "onboarding.timeWindow.today": "Today",
    "onboarding.timeWindow.thisWeek": "This week",

    // ═══════════════════════════════════════════════════════════════════════
    // Onboarding wizard shell (OnboardingWizard.tsx)
    // ═══════════════════════════════════════════════════════════════════════
    "onboarding.wizard.setupAriaLabel": "Account setup",
    "onboarding.wizard.stepProgress": "Step {step} of {total}",

    // ═══════════════════════════════════════════════════════════════════════
    // Product tour (ProductTour.tsx) — TOUR_STEPS content + chrome
    // ═══════════════════════════════════════════════════════════════════════
    "onboarding.tour.welcome.title": "Welcome to your workspace",
    "onboarding.tour.welcome.body":
      "This quick tour shows you where everything lives. You can skip at any time.",
    "onboarding.tour.orgSwitcher.title": "Switch organizations",
    "onboarding.tour.orgSwitcher.body":
      "Click here to switch between organizations or create a new one.",
    "onboarding.tour.projects.body":
      "Open the project hub for the current organization or All organizations, then filter, sort, open, or create projects from one place.",
    // title reuses `editor.navTitle.assignedToMe` (identical text)
    "onboarding.tour.assigned.body":
      "Jump straight to the segments assigned to you across all projects.",
    "onboarding.tour.settingsStep.title": "Settings & members",
    "onboarding.tour.settingsStep.body":
      "Manage your organization settings, invite members, and configure access here.",
    "onboarding.tour.account.title": "Your account",
    "onboarding.tour.account.body":
      "Access your preferences, add another account, or sign out from here.",
    "onboarding.tour.skipAriaLabel": "Skip tour",
    "onboarding.tour.stepDialogLabel": "Tour step {step} of {total}: {title}",

    // ═══════════════════════════════════════════════════════════════════════
    // Wizard steps
    // ═══════════════════════════════════════════════════════════════════════

    // — WelcomeStep —
    "onboarding.step.welcome.getStarted": "Get Started",

    // — PrivacyStep —
    "onboarding.step.privacy.heading": "Help us improve",
    "onboarding.step.privacy.description":
      "We use product analytics to understand which features people use and where things go wrong.",
    "onboarding.step.privacy.shareDescription":
      "Helps us provide support and improve Aquilla for everyone. Includes usage events and session recordings for diagnosing issues.",
    "onboarding.step.privacy.footer":
      "You can change this anytime in Settings. Read our",
    "onboarding.step.privacy.policyLink": "Privacy Policy",

    // — SignInStep —
    "onboarding.step.signIn.signedInAs": "Signed in as {username}",
    "onboarding.step.signIn.readyBlurb":
      "AI translations, sync, and cloud import are available.",
    "onboarding.step.signIn.headingSignup": "Create your Frontier account",
    "onboarding.step.signIn.headingLogin": "Sign in to Frontier",
    // "Reset your password" reuses `auth.resetPassword.title`
    "onboarding.step.signIn.unlockBlurb":
      "Unlock AI-powered translations, sync across devices, and import projects from the cloud.",
    // "Already have an account?" reuses `auth.join.alreadyHaveAccount`
    // "New to Frontier?" reuses `nav.account.newToFrontier`
    "onboarding.step.signIn.createOne": "Create one",
    "onboarding.step.signIn.devLogin": "Dev login (skip auth)",

    // — NameStep —
    "onboarding.step.name.heading": "What should we call you?",
    "onboarding.step.name.description": "This name appears on your edits and comments.",
    "onboarding.step.name.displayNameLabel": "Display name",
    "onboarding.step.name.displayNamePlaceholder": "Anonymous translator",

    // — IntentStep —
    "onboarding.step.intent.heading": "How will you use Aquilla?",
    "onboarding.step.intent.description":
      "This just tailors your setup — you can change it later.",
    "onboarding.step.intent.personalTitle": "Just me",
    "onboarding.step.intent.personalDescription":
      "A personal workspace to translate on my own.",
    "onboarding.step.intent.teamTitle": "My team",
    "onboarding.step.intent.teamDescription":
      "Set up an organization and invite collaborators to translate together.",

    // — OrgStep —
    "onboarding.step.org.signInRequired": "Sign in to create an organization.",
    "onboarding.step.org.createFailed": "Couldn't create your organization.",
    "onboarding.step.org.heading": "Set up your organization",
    "onboarding.step.org.description":
      "Give your team a home, and invite collaborators to get started together.",
    "onboarding.step.org.nameLabel": "Organization name",
    "onboarding.step.org.namePlaceholder": "Acme Bible Translation",
    "onboarding.step.org.inviteLabel": "Invite teammates (optional)",
    "onboarding.step.org.inviteDescription":
      "Comma- or space-separated emails. They'll get a link to join.",
    "onboarding.step.org.createButton": "Create organization",

    // — ProjectStep —
    "onboarding.step.project.createFailed": "Failed to create project.",
    "onboarding.step.project.signInHeading": "Sign in to create a project",
    "onboarding.step.project.signInDescription":
      "Projects are stored on the server. You need to be signed in so the project is accessible on all your devices and won't 403 when you open it.",
    "onboarding.step.project.backToSignIn": "Back to sign in",
    "onboarding.step.project.doThisLater": "Do this later",
    "onboarding.step.project.heading": "Create your first project",
    "onboarding.step.project.description":
      "You can import files and invite collaborators after setup.",
    "onboarding.step.project.nameLabel": "Project name",
    "onboarding.step.project.namePlaceholder": "My Translation Project",
    "onboarding.step.project.sourceLanguageLabel": "Source language",
    "onboarding.step.project.sourceLanguagePlaceholder": "English",
    "onboarding.step.project.targetLanguagePlaceholder": "French",
    "onboarding.step.project.createButton": "Create Project",

    // — ReadyStep —
    "onboarding.step.ready.heading": "You're all set!",
    "onboarding.step.ready.description": "{projectName} is ready. We'll walk you through setting up AI and inviting collaborators next.",
    "onboarding.step.ready.startTranslating": "Start Translating",

    // ═══════════════════════════════════════════════════════════════════════
    // Setup checklist drawer + steps (project workspace, post-onboarding)
    // ═══════════════════════════════════════════════════════════════════════

    // — SetupChecklistDrawer shell —
    "onboarding.checklist.drawer.title": "Project setup",
    "onboarding.checklist.drawer.description":
      "A few quick steps so AI suggestions, voice, and collaboration are ready before you dive in.",
    "onboarding.checklist.drawer.progress": "{completed} of {total} complete",
    "onboarding.checklist.drawer.allSetTitle": "You're all set",
    "onboarding.checklist.drawer.allSetDescription":
      "You can reopen this checklist any time from the project header.",
    "onboarding.checklist.drawer.hideButton": "Hide checklist and start translating",

    // — RoleGatedStep —
    "onboarding.checklist.roleGated.tooltip": "{action} is available to {role} and above.",

    // — ImportFilesStep + shared checklist-item copy —
    "onboarding.checklist.importFiles.title": "Import files",
    "onboarding.checklist.importFiles.stepDescription":
      "Bring in your source text first — USFM, plain text, or other supported formats. Everything else works on specific files.",
    "onboarding.checklist.importFiles.description":
      "Import your source text first — USFM, plain text, or other supported formats. Everything else (AI suggestions, voice, and collaboration) works on specific files, so importing first sets you up for success.",
    "onboarding.checklist.importFiles.countImported": plural({
      one: "{count} file imported",
      other: "{count} files imported",
    }),
    "onboarding.checklist.importFiles.importMore": "Import more files",

    // — AiInstructionsStep —
    "onboarding.checklist.aiInstructions.title": "Set translation instructions",
    "onboarding.checklist.aiInstructions.stepDescription":
      "A short system prompt that shapes tone, formality, and style. Shared with everyone in this project.",
    "onboarding.checklist.aiInstructions.actionLabel": "Editing translation instructions",
    "onboarding.checklist.aiInstructions.introPrefix":
      "Tell the AI how to translate. The starter prompt works for most projects; edit it to match your tone, formality, or domain (legal, scripture, marketing, etc.). Use",
    "onboarding.checklist.aiInstructions.introAnd": "and",
    "onboarding.checklist.aiInstructions.introSuffix": "as placeholders.",
    "onboarding.checklist.aiInstructions.resetToDefault": "Reset to default",
    "onboarding.checklist.aiInstructions.charCount": plural({
      one: "{count} character",
      other: "{count} characters",
    }),
    "onboarding.checklist.aiInstructions.saveButton": "Save instructions",

    // — AiProviderStep —
    "onboarding.checklist.aiProvider.description":
      "AI fills in suggested translations as you go and keeps style consistent across the project. You can change this later in Project Settings.",
    "onboarding.checklist.aiProvider.frontierSignInRequired":
      "Sign in with a Frontier account to use the managed model.",
    "onboarding.checklist.aiProvider.endpointRequired": "Endpoint URL is required",
    "onboarding.checklist.aiProvider.frontierLabel": "Frontier AI",
    "onboarding.checklist.aiProvider.recommendedBadge": "Recommended",
    "onboarding.checklist.aiProvider.frontierSignedIn":
      "Signed in as {username} — no setup needed.",
    "onboarding.checklist.aiProvider.customLabel": "Custom endpoint",
    "onboarding.checklist.aiProvider.customDescription":
      "Self-hosted, local, or any OpenAI-compatible server.",
    "onboarding.checklist.aiProvider.endpointLabel": "Endpoint URL",
    "onboarding.checklist.aiProvider.modelLabel": "Model",
    "onboarding.checklist.aiProvider.optional": "(optional)",
    "onboarding.checklist.aiProvider.saveButton": "Save provider",

    // — AiModelsStep — model metadata (was module-level ModelMeta consts)
    "onboarding.checklist.aiModels.whisper.label": "Whisper transcription",
    "onboarding.checklist.aiModels.whisper.blurb":
      "Word-level timing for recorded audio. Runs locally; no network after download.",
    "onboarding.checklist.aiModels.kokoro.label": "Kokoro voices",
    "onboarding.checklist.aiModels.kokoro.blurb":
      "English voices that run in the browser after a one-time download.",
    "onboarding.checklist.aiModels.mms.label": "MMS multilingual voices",
    "onboarding.checklist.aiModels.mms.blurb":
      "Local voices for many languages — one language model per download.",
    "onboarding.checklist.aiModels.title": "Configure voice & transcription",
    "onboarding.checklist.aiModels.stepDescription":
      "Gemini TTS is recommended for voice; Whisper transcription runs locally.",
    "onboarding.checklist.aiModels.actionLabel": "Configuring voice and transcription",
    "onboarding.checklist.aiModels.intro":
      "AI features are optional. Pick what you want — nothing downloads until you tap the button.",
    "onboarding.checklist.aiModels.expandTitle": "Set up transcription & voice",
    "onboarding.checklist.aiModels.expandHint": "Click to choose specific features",
    "onboarding.checklist.aiModels.transcriptionLegend": "Transcription",
    "onboarding.checklist.aiModels.voiceLegend": "Voice generation",
    "onboarding.checklist.aiModels.noneLabel": "None — set up later",
    "onboarding.checklist.aiModels.noneHint":
      "Skip voice generation entirely. You can come back from project settings.",
    "onboarding.checklist.aiModels.geminiLabel": "Gemini (cloud, BYOK)",
    "onboarding.checklist.aiModels.geminiHint":
      "Highest quality, promptable voices. Needs a Google AI Studio API key. No local download.",
    "onboarding.checklist.aiModels.geminiKeySaved": "Gemini key saved",
    // replace button reuses `audio.clone.replaceButton` (identical text)
    "onboarding.checklist.aiModels.geminiKeyLabel": "Gemini API key",
    "onboarding.checklist.aiModels.saveKey": "Save key",
    "onboarding.checklist.aiModels.geminiKeyHelp":
      "Get a key at aistudio.google.com/apikey. Stored locally and sent directly to Google.",
    "onboarding.checklist.aiModels.geminiKeyMissing":
      "Enter your Gemini API key, or choose “None — set up later” above.",
    "onboarding.checklist.aiModels.geminiKeyInvalid":
      "That doesn’t look like a Gemini key — they start with “AIza”. Double-check and paste again.",
    "onboarding.checklist.aiModels.downloadNotice": "~{size} MB to download",
    "onboarding.checklist.aiModels.downloadWarning":
      "Large downloads can take several minutes on slow or metered connections. The download keeps going in the background — you can keep working.",
    "onboarding.checklist.aiModels.nothingSelected": "Nothing selected",
    // "Ready" reuses `autopilot.readiness.level.ready` (identical text)
    "onboarding.checklist.aiModels.downloadingButton": "Downloading…",
    "onboarding.checklist.aiModels.downloadButton": "Download",
    "onboarding.checklist.aiModels.downloadButtonWithSize": "Download ~{size} MB",
    "onboarding.checklist.aiModels.keepWorking": "You can keep working — this won't block you.",
    "onboarding.checklist.aiModels.readyToUse": "Ready to use.",
    "onboarding.checklist.aiModels.skippedNotice": "Voice & transcription skipped for this project.",
    "onboarding.checklist.aiModels.setUpAnyway": "Set up anyway",
    "onboarding.checklist.aiModels.skipLink": "We don’t use voice or transcription — skip this",
    "onboarding.checklist.aiModels.statusFailed": "Failed",
    "onboarding.checklist.aiModels.statusDownloading": "downloading",
    "onboarding.checklist.aiModels.sizeMb": "{size} MB",

    // — InviteStep —
    "onboarding.checklist.invite.title": "Invite collaborators",
    "onboarding.checklist.invite.stepDescription":
      "Translators and reviewers join with the same permissions you choose.",
    "onboarding.checklist.invite.actionLabel": "Inviting collaborators",
    "onboarding.checklist.invite.descriptionPrefix": "Add teammates as",
    "onboarding.checklist.invite.descriptionSuffix":
      "— they can read, comment, and edit cells. You can change roles or upgrade them in Project → Share.",
    "onboarding.checklist.invite.usernameLabel": "Invite by Aquilla username",
    "onboarding.checklist.invite.usernamePlaceholder": "e.g. mariad",
    "onboarding.checklist.invite.signInRequired": "Sign in to invite by username.",
    "onboarding.checklist.invite.addedPrefix": "Added",
    "onboarding.checklist.invite.addedSuffix": "as contributor.",
    "onboarding.checklist.invite.noSuchUser": "No Aquilla user named “{username}”.",
    "onboarding.checklist.invite.addFailed": "Couldn't add member.",
    "onboarding.checklist.invite.linkSignInRequired": "Sign in to create an invite link.",
    "onboarding.checklist.invite.linkCreateFailed":
      "Couldn't create invite. Try again, or check your permission on this project.",
    "onboarding.checklist.invite.shareLinkLabel": "Or share a link",
    "onboarding.checklist.invite.createLinkButton": "Create link",
    // "Copied!" reuses `nav.report.copied`; "Copied" (aria) reuses `nav.version.copiedLabel` — identical text
    "onboarding.checklist.invite.copyLinkAriaLabel": "Copy invite link",
    "onboarding.checklist.invite.createAnotherLink": "Create another link",
    "onboarding.checklist.invite.shareLinkHint":
      "Anyone with the link joins as a contributor after signing in. Use this when you don't have the recipient's username yet.",

    // — ComingSoonStep + its two checklist entries —
    "onboarding.checklist.comingSoon.badge": "Coming soon",
    "onboarding.checklist.comingSoon.standards.title": "Upload project standards",
    "onboarding.checklist.comingSoon.standards.description":
      "Style guides and translation standards the AI will follow.",
    "onboarding.checklist.comingSoon.glossary.title": "Import glossary / translation memory",
    "onboarding.checklist.comingSoon.glossary.description":
      "Existing TM or glossaries to keep terminology consistent.",

    // ═══════════════════════════════════════════════════════════════════════
    // System prompt nudge (editor banner)
    // ═══════════════════════════════════════════════════════════════════════
    "onboarding.systemPromptNudge.message":
      "Your AI is still using the default translation instructions.",
    "onboarding.systemPromptNudge.detail":
      "Customize them to match your project's tone and domain — shared with everyone on the project.",
    "onboarding.systemPromptNudge.customizeButton": "Customize",

    // ═══════════════════════════════════════════════════════════════════════
    // Preferences (src/pages/Preferences.tsx)
    // ═══════════════════════════════════════════════════════════════════════

    // — Rail / theme / group option labels —
    "onboarding.preferences.rail.left": "Left rail",
    "onboarding.preferences.rail.top": "Top bar",
    "onboarding.preferences.theme.system": "System",
    "onboarding.preferences.theme.light": "Light",
    "onboarding.preferences.theme.dark": "Dark",
    "onboarding.preferences.group.general": "General",
    "onboarding.preferences.group.aiPersonalization": "AI & personalization",
    "onboarding.preferences.group.account": "Account",

    // — Translator profile fields (was PROFILE_TEXT_FIELDS) —
    "onboarding.preferences.profile.responseLanguage.label": "Assistant language",
    "onboarding.preferences.profile.responseLanguage.placeholder":
      "e.g. Tagalog — the AI replies in this language",
    "onboarding.preferences.profile.age.label": "Age",
    "onboarding.preferences.profile.age.placeholder": "e.g. 32",
    "onboarding.preferences.profile.gender.label": "Gender",
    "onboarding.preferences.profile.gender.placeholder": "e.g. Female",
    "onboarding.preferences.profile.educationLevel.label": "Level of education",
    "onboarding.preferences.profile.educationLevel.placeholder": "e.g. High school",
    "onboarding.preferences.profile.religiousBackground.label": "Religious background",
    "onboarding.preferences.profile.religiousBackground.placeholder": "e.g. Christian",
    "onboarding.preferences.profile.translationExperience.label": "Translation experience",
    "onboarding.preferences.profile.translationExperience.placeholder": "e.g. 2 years",
    "onboarding.preferences.profile.geographicalSetting.label": "Geographical setting",
    "onboarding.preferences.profile.geographicalSetting.placeholder": "e.g. Rural, Asia",
    "onboarding.preferences.profile.otherInfoLabel": "Other relevant information",
    "onboarding.preferences.profile.otherInfoPlaceholder":
      "Anything else that should shape the summaries you get",

    // — WorkspaceSection —
    "onboarding.preferences.workspace.groupLabel": "Workspace",
    "onboarding.preferences.workspace.railLabel": "Sidebar tab layout",
    "onboarding.preferences.workspace.railDescription":
      "Show Files, Chat, and Search as a vertical rail on the left or a horizontal bar across the top of the sidebar.",
    "onboarding.preferences.workspace.confirmReplaceLabel":
      "Confirm before replacing a translation",
    "onboarding.preferences.workspace.confirmReplaceDescription":
      "Ask for confirmation when AI Generate replaces a cell that already has a translation. Validated cells always confirm regardless of this setting.",

    // — AppearanceSection —
    "onboarding.preferences.appearance.groupLabel": "Theme",
    "onboarding.preferences.appearance.themeDescription":
      "Follow your system appearance or choose a theme for this device.",

    // — LanguageSection — group label reuses `language.label` (identical text)
    "onboarding.preferences.language.rowDescription":
      "The language the app's own interface (menus, buttons, messages) is shown in.",

    // — PrivacySection —
    "onboarding.preferences.privacy.groupLabel": "Analytics",
    "onboarding.preferences.privacy.rowDescription":
      "Events like project creation, exports, and AI translations. Never the contents of your translations or files.",

    // — TranslatorProfileSection —
    "onboarding.preferences.profileSection.groupLabel": "About you",
    "onboarding.preferences.profileSection.rowLabel": "Profile fields",
    "onboarding.preferences.profileSection.rowDescription":
      "All fields are optional. Stored on this device and sent to the AI to tailor your summaries.",

    // — PREFERENCE_SECTIONS index entries (title reuses the group labels above
    //   where the English is identical; description is the nav-row summary,
    //   distinct from each section's own in-page description) —
    "onboarding.preferences.section.workspace.description":
      "Layout and editing behavior for the project workspace.",
    "onboarding.preferences.section.appearance.title": "Appearance",
    "onboarding.preferences.section.appearance.description": "How the workspace looks on this device.",
    "onboarding.preferences.section.language.description":
      "The language the app's own interface is shown in.",
    "onboarding.preferences.section.privacy.title": "Privacy",
    "onboarding.preferences.section.privacy.description":
      "Control what's shared with us about how you use the app.",
    "onboarding.preferences.section.profile.title": "Translator profile",
    "onboarding.preferences.section.profile.description":
      "Tell the AI about yourself so its summaries and answers fit your context — and so it replies in your language.",
    "onboarding.preferences.section.providerKeys.title": "AI provider keys",
    "onboarding.preferences.section.providerKeys.description":
      "Optional personal AI provider override for this device only.",
    "onboarding.preferences.section.localModels.title": "Local models",
    "onboarding.preferences.section.localModels.description":
      "Whisper transcription and Kokoro / MMS voices run entirely in your browser — stored once and shared across all projects on this device.",
    "onboarding.preferences.section.usage.title": "Usage",
    "onboarding.preferences.section.usage.description": "Your audio and AI activity. No pricing is shown here.",
    "onboarding.preferences.section.apiTokens.title": "API tokens",
    "onboarding.preferences.section.apiTokens.description":
      "Personal access tokens for the Agent API. Anyone holding a token can act with your access, up to its scope — treat it like a password.",

    // — Index hints —
    "onboarding.preferences.hint.sharingOn": "Sharing on",
    "onboarding.preferences.hint.sharingOff": "Sharing off",
    "onboarding.preferences.hint.profileSet": "{filled}/{total} set",
    "onboarding.preferences.hint.notSet": "Not set",
    "onboarding.preferences.hint.personal": "Personal",
    "onboarding.preferences.hint.onDevice": "On-device",

    // — Page chrome — title reuses `nav.account.preferences` (identical text)
    "onboarding.preferences.pageDescription":
      "Personal preferences that apply to you across all projects on this device.",
    "onboarding.preferences.dialogDescription": "Personal preferences that apply across projects.",

    // ═══════════════════════════════════════════════════════════════════════
    // API tokens (src/components/settings/ApiTokensSection.tsx)
    // ═══════════════════════════════════════════════════════════════════════
    "onboarding.apiTokens.expiry.30d": "30 days",
    "onboarding.apiTokens.expiry.90d": "90 days",
    "onboarding.apiTokens.expiry.none": "No expiry",
    "onboarding.apiTokens.scope.projectFallback": "Project {id}",
    "onboarding.apiTokens.scope.orgFallback": "Org {id}",
    "onboarding.apiTokens.scope.unscoped": "Unscoped (personal)",
    "onboarding.apiTokens.loadFailed": "Failed to load tokens.",
    "onboarding.apiTokens.heading": "Access",
    "onboarding.apiTokens.yourTokensLabel": "Your tokens",
    "onboarding.apiTokens.empty":
      "No tokens yet. Mint one to let an agent call the Agent API on your behalf.",
    "onboarding.apiTokens.revokedBadge": "Revoked",
    "onboarding.apiTokens.expiredBadge": "Expired",
    "onboarding.apiTokens.expiresOn": "Expires {date}",
    "onboarding.apiTokens.lastUsedOn": "Last used {date}",
    "onboarding.apiTokens.agentSetupButton": "Agent setup",
    "onboarding.apiTokens.revokeButton": "Revoke",
    "onboarding.apiTokens.revokeDialogTitle": "Revoke token?",
    "onboarding.apiTokens.revokeWarning":
      "({prefix}…) will stop working immediately. This can't be undone.",
    "onboarding.apiTokens.revokeFailed": "Failed to revoke token.",
    "onboarding.apiTokens.revokingButton": "Revoking…",
    "onboarding.apiTokens.revokeTokenButton": "Revoke token",
    "onboarding.apiTokens.newTokenDialogTitle": "Your new API token",
    "onboarding.apiTokens.showOnceWarning":
      "Copy this now — you will not see it again. If you lose it, revoke this token and mint a new one.",
    "onboarding.apiTokens.agentHandoffHint":
      "Handing this to an agent? Copy the token wrapped in a ready-to-paste prompt that sends the agent to the API's self-describing endpoint to learn what it can do, and spells out this token's {mode} mode.",
    "onboarding.apiTokens.copyAgentInstructions": "Copy agent instructions",
    "onboarding.apiTokens.agentInstructionsDialogTitle": "Instructions for your agent",
    "onboarding.apiTokens.agentInstructionsBody":
      "Paste this into Claude Code, Codex, or any agent chat. It gives the agent the token, points it at the API's own self-describing endpoint so it discovers what's available rather than trusting a snapshot, and tells it how this token's {mode} mode limits what it can do without you.",
    "onboarding.apiTokens.agentInstructionsPlaceholderNote":
      "Replace the placeholder with the token you copied when you minted it.",
    "onboarding.apiTokens.copyInstructionsButton": "Copy instructions",
    "onboarding.apiTokens.newTokenTrigger": "New token",
    "onboarding.apiTokens.newTokenDialogHeading": "New API token",
    "onboarding.apiTokens.namePlaceholder": "e.g. Import agent",
    "onboarding.apiTokens.modeLabel": "Mode",
    "onboarding.apiTokens.modeAskLabel": "Ask",
    "onboarding.apiTokens.modeAskDescription": "every write waits for your approval.",
    "onboarding.apiTokens.modeActLabel": "Act",
    "onboarding.apiTokens.modeActDescription":
      "writes apply immediately. Requires a project below where you're a maintainer.",
    "onboarding.apiTokens.orgLabel": "Organization",
    "onboarding.apiTokens.orgPlaceholder": "No organization (personal)",
    "onboarding.apiTokens.orgHint": "Only orgs where you're at least a contributor are listed.",
    "onboarding.apiTokens.projectPlaceholder": "No project (org-wide)",
    "onboarding.apiTokens.expiryLabel": "Expiry",
    "onboarding.apiTokens.nameRequired": "Give this token a name.",
    "onboarding.apiTokens.mintFailed": "Failed to mint token.",
    "onboarding.apiTokens.mintingButton": "Minting…",
    "onboarding.apiTokens.mintTokenButton": "Mint token",

    // ═══════════════════════════════════════════════════════════════════════
    // Credit-usage surfaces (org CreditsPanel, agent CreditsDial, rail palette)
    // ═══════════════════════════════════════════════════════════════════════
    // agent rail label reuses `nav.dock.agentTab` (identical text)
    "onboarding.credits.rail.llm": "Chat",
    "onboarding.credits.rail.tts": "TTS",
    "onboarding.credits.panelTitle": "Compute credits",
    "onboarding.credits.panelDescription": "Usage against daily & weekly caps, broken out by rail",
    "onboarding.credits.agentSpendNote": "Agent spend (elevated rail — own cap, 5× markup)",
    "onboarding.credits.dialSummary": "Agent credits used today: {credits}",
    "onboarding.credits.popoverAgentTitle": "Agent credits",
    "onboarding.credits.popoverAllUsageTitle": "All AI usage (every rail)",
    "onboarding.credits.dialFooter": "{remaining} agent credits left today · caps set by your org",
  },
  context: {
    _context: {
      description:
        "First-run onboarding and account preferences — the setup checklist that teaches the app, the product tour, and the personal settings screens (profile, appearance, API tokens). These are the first strings a new translator reads, often before they understand the product's vocabulary, so prefer plain wording over internal jargon.",
    },
    keys: {
      "onboarding.wizard.setupAriaLabel": {
        description:
          "Screen-reader name of the full-page onboarding wizard container. Not visible on screen.",
      },
      "onboarding.wizard.stepProgress": {
        description:
          "Screen-reader label on the step-dots progressbar in the onboarding wizard, stating position.",
        placeholders: {
          step: "Current step number (1-based).",
          total: "Total number of steps in the wizard (8).",
        },
      },
      "onboarding.tour.skipAriaLabel": {
        description: "Accessible name of the small X button that dismisses the whole product tour.",
      },
      "onboarding.tour.stepDialogLabel": {
        description:
          "Screen-reader label on the tour tooltip's dialog role, read before its visible content.",
        placeholders: {
          step: "Current tour step number (1-based, after role filtering).",
          total: "Total number of tour steps the viewer can see.",
          title: "That step's own title string (already translated).",
        },
      },
      "onboarding.step.signIn.signedInAs": {
        description:
          "Heading shown on the sign-in wizard step when the visitor already has an active session.",
        placeholders: { username: "The signed-in user's handle. Not translated." },
      },
      "onboarding.step.ready.description": {
        description: "Confirmation sentence on the final onboarding step, naming the project just created.",
        placeholders: { projectName: "The new project's name, as entered by the user. Not translated." },
      },
      "onboarding.checklist.drawer.progress": {
        description:
          "Small status line under the setup checklist's progress bar, stating how many of the steps are done.",
        placeholders: {
          completed: "Number of checklist items completed so far.",
          total: "Total number of checklist items.",
        },
      },
      "onboarding.checklist.roleGated.tooltip": {
        description:
          "Tooltip shown over a checklist step whose action is disabled because the viewer's project role is below the required floor.",
        placeholders: {
          action: "Short description of the gated action, e.g. 'Editing translation instructions'. Already translated at the call site.",
          role: "The minimum role name required, already pluralised (e.g. 'Maintainers'). Comes from common.role.*.",
        },
      },
      "onboarding.checklist.importFiles.countImported": {
        description:
          "Confirmation line under the Import files checklist step, once at least one file has been imported.",
        placeholders: { count: "Number of files imported into the project so far." },
      },
      "onboarding.checklist.aiInstructions.charCount": {
        description:
          "Small counter under the system-prompt textarea in the AI instructions checklist step, showing its current length.",
        placeholders: { count: "Number of characters currently typed in the prompt textarea." },
      },
      "onboarding.checklist.aiProvider.frontierSignedIn": {
        description:
          "Description under the 'Frontier AI' provider option once the viewer is signed in, naming their account.",
        placeholders: { username: "The signed-in user's handle. Not translated." },
      },
      "onboarding.checklist.aiModels.downloadNotice": {
        description:
          "Small notice above the download button in the voice/transcription checklist step, stating the total pending download size.",
        placeholders: { size: "Total megabytes to download for every currently-selected, not-yet-ready model. A plain number." },
      },
      "onboarding.checklist.aiModels.downloadButtonWithSize": {
        description:
          "Primary download button label in the voice/transcription checklist step, once at least one model needs downloading.",
        placeholders: { size: "Total megabytes still to download. A plain number." },
      },
      "onboarding.checklist.aiModels.sizeMb": {
        description:
          "Size badge next to an individual model's name (Whisper, Kokoro, MMS) before it has been downloaded.",
        placeholders: { size: "That model's download size in megabytes. A plain number." },
      },
      "onboarding.checklist.invite.copyLinkAriaLabel": {
        description: "Accessible name of the copy-to-clipboard button next to the invite link, before it's clicked.",
      },
      "onboarding.checklist.invite.noSuchUser": {
        description:
          "Inline form error under the username field when the typed handle doesn't match any Aquilla account.",
        placeholders: { username: "The username the person typed, echoed back verbatim. Not translated." },
      },
      "onboarding.preferences.hint.profileSet": {
        description:
          "Nav-row hint next to 'Translator profile' in the Preferences index, showing how many of its optional fields are filled in.",
        placeholders: {
          filled: "Count of profile fields the user has filled in.",
          total: "Total number of profile fields.",
        },
      },
      "onboarding.apiTokens.scope.projectFallback": {
        description:
          "Fallback scope label for an API token bound to a project the caller can no longer resolve by name (e.g. access was revoked).",
        placeholders: { id: "The project's raw id. Not translated." },
      },
      "onboarding.apiTokens.scope.orgFallback": {
        description:
          "Fallback scope/name label for an org the caller can no longer resolve by name, or whose name is empty.",
        placeholders: { id: "The org's raw numeric id. Not translated." },
      },
      "onboarding.apiTokens.expiresOn": {
        description: "Expiry date shown on a token's row in the personal API tokens list.",
        placeholders: { date: "The token's expiry date, already locale-formatted." },
      },
      "onboarding.apiTokens.lastUsedOn": {
        description: "Last-used date shown on a token's row in the personal API tokens list.",
        placeholders: { date: "The date the token was last used, already locale-formatted." },
      },
      "onboarding.apiTokens.revokeWarning": {
        description:
          "Confirmation-dialog warning when revoking an API token. Rendered immediately after the bold token name, so it starts with the parenthesised prefix.",
        placeholders: { prefix: "The first few characters of the token, shown so the user can identify it. Not translated." },
      },
      "onboarding.apiTokens.agentHandoffHint":
        {
          description:
            "Helper text under a freshly-minted token, explaining the 'Copy agent instructions' option.",
          placeholders: { mode: "The token's access mode, 'ask' or 'act'. Not translated — a literal API value." },
        },
      "onboarding.apiTokens.agentInstructionsBody": {
        description:
          "Body paragraph of the 'Instructions for your agent' dialog, explaining what the pasted prompt does.",
        placeholders: { mode: "The token's access mode, 'ask' or 'act'. Not translated — a literal API value." },
      },
      "onboarding.credits.dialSummary": {
        description:
          "Tooltip and accessible name on the small agent-credits ring shown in the agent dock/workbench header.",
        placeholders: { credits: "Today's agent-rail credit spend, already locale-formatted." },
      },
      "onboarding.credits.dialFooter": {
        description:
          "Small footer line in the agent-credits popover, stating remaining daily allowance.",
        placeholders: { remaining: "Agent credits remaining today, already locale-formatted." },
      },
    },
  },
  surfaces: [],
})
