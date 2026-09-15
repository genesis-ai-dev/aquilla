import { defineNamespace } from "./types"

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
    // ── AssignmentAuthoritySection (org settings → security) ──
    "settings.assignmentAuthority.floorLabel": "Who can assign work",
    "settings.assignmentAuthority.floorDescription":
      "Minimum project role required to assign, reassign, or unassign file, " +
      "chapter, target-lane, and AI review tasks. Defaults to Project lead.",
    "settings.assignmentAuthority.label": "Allow self-assignment",
    "settings.assignmentAuthority.description":
      "When on, a member (contributor and above) can claim a book/chapter/take " +
      "for themselves from the assign-work picker — they still can't assign " +
      "work to anyone else. Leads and maintainers can always assign, to " +
      "anyone, regardless of this setting.",

    // ── OrgProviderSection (org settings → AI provider keys) ──
    "settings.providerKeys.groupLabel": "Provider keys",
    "settings.providerKeys.geminiTtsLabel": "Gemini TTS API key",
    "settings.providerKeys.restrictedNotice":
      "Only org maintainers and owners can set org-level keys. You can still " +
      "save a personal key in your project or personal settings.",
    "settings.providerKeys.geminiTtsDescription":
      "Used by Gemini TTS synthesis for all org members when no project or " +
      "personal key is present. Precedence: project key > personal key > org key.",
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

    // ── RosterProgressSection (org settings → security) ──
    "settings.rosterProgress.groupLabel": "Visibility",
    "settings.rosterProgress.groupDescription":
      "Who can see the member roster and per-member progress. Both default to Maintainer.",
    "settings.rosterProgress.rosterLabel": "Who can view the roster",
    "settings.rosterProgress.rosterDescription":
      "Minimum role required to see the member list and member count, on both " +
      "the org Members page and each project's Members tab. Below this role, " +
      "the roster and count are hidden entirely — not shown empty, just absent.",
    "settings.rosterProgress.progressLabel": "Who can view member progress",
    "settings.rosterProgress.progressDescription":
      "Minimum role required to see per-member progress/productivity. " +
      "Independent of roster visibility — a role can see who's on the team " +
      "without seeing their progress, or vice versa.",
    // Open-dropdown option text for the roster/progress floor selects. FLOOR_LABEL
    // (src/pages/settings/constants.ts) supplies the short closed-trigger text; these
    // are the fuller sentences shown once the dropdown is open. The role name +
    // numeric level are fixed per option (not a runtime placeholder) — same
    // treatment as settings.termbase.option* below.
    "settings.rosterProgress.optionViewer": "Viewer (100) — anyone with access",
    "settings.rosterProgress.optionContributor": "Contributor (400)",
    "settings.rosterProgress.optionProjectLead": "Project lead (500)",
    "settings.rosterProgress.optionMaintainer": "Maintainer (600) — default",
    "settings.rosterProgress.optionOwner": "Owner (700) — most restrictive",

    // ── TermbaseEditSection (org settings → security) ──
    "settings.termbase.label": "Who can manage terminology",
    "settings.termbase.description":
      "Minimum role required to add, edit, delete, and archive terms in a " +
      "project's term base. Below this role the term base is read-only. This " +
      "setting covers terminology only — every other project setting still " +
      "requires Maintainer.",
    // Open-dropdown option text for the termbase-edit floor select; see the
    // roster/progress options above for why the level number is baked in.
    "settings.termbase.optionContributor": "Contributor (400) — translators manage terms",
    "settings.termbase.optionProjectLead": "Project lead (500) — default",
    "settings.termbase.optionMaintainer": "Maintainer (600) — most restrictive",

    // ── LanguageEditSection (org settings → security) — AQU-1086 ──
    "settings.languageEdit.label": "Who can change project languages",
    "settings.languageEdit.description":
      "Minimum role required to change a project's source and target language " +
      "and to add or archive extra target languages. This setting covers " +
      "languages only — every other project setting still requires Maintainer.",
    // Open-dropdown option text for the language-edit floor select; see the
    // roster/progress options above for why the level number is baked in.
    "settings.languageEdit.optionProjectLead":
      "Project lead (500) — project managers fix their own languages",
    "settings.languageEdit.optionMaintainer": "Maintainer (600) — default",
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
    "settings.commentPermissions.createOptionCommenter": "Commenter (200) — default",
    "settings.commentPermissions.createOptionReviewer": "Reviewer (300) — reviewers and above",
    "settings.commentPermissions.createOptionContributor":
      "Contributor (400) — translators and above",
    "settings.commentPermissions.createOptionProjectLead": "Project lead (500) — leads and above",
    "settings.commentPermissions.createOptionMaintainer": "Maintainer (600) — most restrictive",
    "settings.commentPermissions.resolveOptionCommenter":
      "Commenter (200) — anyone who can comment",
    "settings.commentPermissions.resolveOptionReviewer": "Reviewer (300) — reviewers and above",
    "settings.commentPermissions.resolveOptionContributor": "Contributor (400) — default",
    "settings.commentPermissions.resolveOptionProjectLead": "Project lead (500) — leads and above",
    "settings.commentPermissions.resolveOptionMaintainer": "Maintainer (600) — most restrictive",

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
    "settings.orgIdentity.nameDescription": "Shown across the workspace.",
    // "Organization name" (label, sr-only FieldLabel, placeholder) →
    // org.createDialog.nameLabel (identical text)

    // ── OrgSettingsIndex ──
    // Rendered via <RichMessage> so the embedded <Link to="/preferences"> stays
    // a real, routable link rather than being flattened into plain text; {link}
    // renders `t("nav.account.preferences")` inside the anchor.
    "settings.orgSettingsIndex.description": "Manage this organization. Personal preferences moved to {link}.",
    "settings.orgSettingsIndex.navIdentity": "Identity",
    "settings.orgSettingsIndex.navSecurity": "Security",
    "settings.orgSettingsIndex.navGroupPeopleProjects": "People & Projects",
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
    "settings.monday.connectFailedWithReason": "Connecting to Monday.com failed ({reason}). Try again.",
    "settings.monday.connectionCardTitle": "Connection",
    "settings.monday.loadingStatus": "Loading connection status…",
    "settings.monday.reauthExpiredNotice":
      "The Monday.com authorization has expired (Monday limits it to 6 months). " +
      "Reconnect to resume syncing — board links and mappings are kept.",
    "settings.monday.reconnectButton": "Reconnect",
    "settings.monday.connectedAsRow": "Connected as {username}",
    "settings.monday.connectedOnRow": "Connected {date}",
    "settings.monday.disconnectButton": "Disconnect",
    "settings.monday.manageRestrictedNotice": "Only org maintainers and owners can manage this connection.",
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
      "settings.monday.connectFailedWithReason": {
        description:
          "Inline error notice after a failed Monday.com OAuth round trip, " +
          "shown instead of settings.monday.connectFailed when the server " +
          "returned a specific reason.",
        placeholders: {
          reason: "Short, already-English machine/server-provided failure reason (not translated).",
        },
      },
      "settings.monday.connectedAsRow": {
        description: "Row on the Monday.com connection card naming the connected Monday user.",
        placeholders: {
          username: "The connected Monday.com account's display username. Not translated.",
        },
      },
      "settings.monday.connectedOnRow": {
        description:
          "Row on the Monday.com connection card giving the date the connection was made.",
        placeholders: {
          date: "A locale-formatted date string (already localized by the caller before interpolation).",
        },
      },
    },
  },
  surfaces: [],
})
