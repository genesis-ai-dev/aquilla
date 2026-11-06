import { defineNamespace, plural } from "./types"

export const langquest = defineNamespace({
  keys: {
    "langquest.name": "LangQuest",
    // Project creation
    "langquest.create.entry": "Import from LangQuest",
    "langquest.create.entryHint": "Follow a LangQuest language. Its recordings come in and stay up to date.",
    "langquest.create.title": "Import from LangQuest",
    "langquest.create.tokenLabel": "LangQuest access token",
    "langquest.create.tokenHelp":
      "Make a token on LangQuest's Connect page and paste it here. Aquilla keeps it on its server and never shows it again.",
    "langquest.create.openConnect": "Open LangQuest Connect",
    "langquest.create.check": "Check token",
    "langquest.create.checking": "Checking token",
    "langquest.create.tokenFor": "Token for {org}",
    "langquest.create.neverExpires": "Never expires",
    "langquest.create.languageLabel": "Language to follow",
    "langquest.create.noAccess": "{name} (no access)",
    "langquest.create.permissionsTitle": "What this token lets Aquilla do",
    "langquest.create.nameLabel": "Project name",
    "langquest.create.submit": "Create and import",
    "langquest.create.creating": "Creating project",
    "langquest.create.retryLink": "Try linking again",
    "langquest.create.createdToast": "{name} is linked to LangQuest. Its recordings are importing now.",
    // New-project wizard (one choice per step)
    "langquest.wizard.sourceTitle": "Where does this project come from?",
    "langquest.wizard.sourceScratch": "Start from scratch",
    "langquest.wizard.sourceScratchHint": "A new project with its own source and target languages.",
    "langquest.wizard.sourceLinked": "From another Aquilla project",
    "langquest.wizard.sourceLinkedHint": "Read the source text from a project you already have, and keep it in step.",
    "langquest.wizard.connectionsLoading": "Looking up your LangQuest organizations…",
    "langquest.wizard.orgTitle": "Which LangQuest organization?",
    "langquest.wizard.orgHint": "Organizations your account is connected to. Pick one, or connect another.",
    "langquest.wizard.connectAnother": "Connect another organization",
    "langquest.wizard.connectTitle": "Connect a LangQuest organization",
    "langquest.wizard.connectIntro":
      "Open LangQuest Connect in a new tab, make a token for Aquilla, then paste it here. Aquilla keeps the token with your account and never shows it again.",
    "langquest.wizard.connect": "Connect",
    "langquest.wizard.connecting": "Connecting",
    "langquest.wizard.languageTitle": "Which language should this project follow?",
    "langquest.wizard.languageHint": "Its recordings come in and stay up to date.",
    "langquest.wizard.languageLoading": "Asking LangQuest what {org} shares…",
    "langquest.wizard.detailsTitle": "Name the project",
    "langquest.wizard.linkedProjects": plural({ one: "{count} linked project", other: "{count} linked projects" }, "count"),
    "langquest.wizard.reconnect": "Reconnect",
    "langquest.wizard.needsReconnect": "LangQuest no longer accepts this organization's token. Reconnect it to continue.",
    // Projects list: a linked project's badge next to its name
    "langquest.list.ariaLabel": "Follows {language} on LangQuest: {state}",
    "langquest.list.synced": "Synced",
    "langquest.list.stalled": "Sync stalled",
    "langquest.list.broken": "Sync broken, reconnect LangQuest",
    // Connection health (one word the UI acts on)
    "langquest.health.ok": "Connected",
    "langquest.health.needs_reauth": "Needs reconnecting",
    "langquest.health.expired": "Token expired",
    "langquest.health.unreachable": "Couldn't reach LangQuest",
    // Preferences → Connected organizations
    "langquest.settings.title": "Connected organizations",
    "langquest.settings.description": "LangQuest organizations your account can import from. Tokens stay on the server.",
    "langquest.settings.groupLabel": "LangQuest",
    "langquest.settings.none": "No LangQuest organization is connected yet.",
    "langquest.settings.connectedOn": "Connected {date}",
    "langquest.settings.lastChecked": "Checked {when}",
    "langquest.settings.scopes": "Scopes: {scopes}",
    "langquest.settings.check": "Check now",
    "langquest.settings.checking": "Checking",
    "langquest.settings.disconnect": "Disconnect",
    "langquest.settings.disconnectConfirmTitle": "Disconnect {org}?",
    "langquest.settings.disconnectConfirmBody":
      "Aquilla forgets this token and revokes it at LangQuest. Projects already linked keep their recordings, but stop importing once the token is gone.",
    "langquest.settings.connectNew": "Connect an organization",
    "langquest.settings.loadFailed": "Couldn't load your LangQuest connections.",
    // Access summary and capabilities
    "langquest.access.none": "No access",
    "langquest.access.published": "Approved recordings only",
    "langquest.access.readOnly": "Read only",
    "langquest.access.readWrite": "Read and write",
    "langquest.capability.readAll": "Import every version shared for review, and keep it up to date",
    "langquest.capability.readPublished": "Import approved versions only, and keep them up to date",
    "langquest.capability.release": "Publish from Aquilla: report approved versions live on a channel",
    "langquest.capability.review": "Record reviews in LangQuest",
    "langquest.capability.externalValues": "Store Aquilla's own values with the language",
    "langquest.capability.notUsed": "Aquilla does not use this yet",
    "langquest.capability.missing": "Needs the “{scope}” scope",
    // Errors
    "langquest.error.notToken": "That doesn't look like a LangQuest token. They start with lqp_.",
    "langquest.error.tokenRejected": "LangQuest didn't accept that token. It may be mistyped, revoked or expired.",
    "langquest.error.unreachable": "Couldn't reach LangQuest. Try again.",
    "langquest.error.createFailed": "Couldn't create the project. Try again.",
    "langquest.error.linkFailed": "The project was created but isn't linked to LangQuest yet. {reason}",
    // Workspace badge and panel
    "langquest.badge.label": "LangQuest · {language}",
    "langquest.badge.ariaLabel": "LangQuest link: sync and publish",
    "langquest.panel.title": "Linked to LangQuest",
    "langquest.panel.orgLanguage": "{language} in {org}",
    "langquest.panel.lastSynced": "Last synced {when}",
    "langquest.panel.neverSynced": "Not synced yet",
    "langquest.panel.lastError": "Last sync failed: {reason}",
    "langquest.panel.syncNow": "Sync now",
    "langquest.panel.syncing": "Syncing: {passages} passages read, {takes} recordings added",
    "langquest.panel.synced": "Up to date: {cells} new passages, {takes} new recordings",
    "langquest.panel.syncFailed": "Sync failed: {reason}",
    "langquest.panel.leadOnly": "Project Leads can sync this project.",
    "langquest.panel.needsToken": "LangQuest no longer accepts this link's token. Paste a new one.",
    "langquest.panel.saveToken": "Save token",
    "langquest.panel.publishTitle": "Publish approved versions",
    "langquest.panel.channelLabel": "Channel",
    "langquest.panel.channelPlaceholder": "Every Language app",
    "langquest.panel.urlLabel": "Link (optional)",
    "langquest.panel.goLive": "Mark live",
    "langquest.panel.takeDown": "Take down",
    "langquest.panel.published": "{released} reported, {unchanged} unchanged, {failed} failed",
    "langquest.panel.noRelease": "To publish from Aquilla, make a token with the Release scope.",
    "langquest.panel.unlink": "Unlink",
    "langquest.panel.unlinkConfirm":
      "Stop following LangQuest? Imported passages and recordings stay in this project, and the token is revoked at LangQuest.",
  },
  context: {
    _context: {
      description:
        "LangQuest is a separate oral Bible translation app (keep the name untranslated). A LangQuest " +
        "organization holds languages; a language holds passages, each with audio recordings. These " +
        "strings appear in two places: (1) the 'Import from LangQuest' path of the New project dialog, " +
        "where a user pastes a LangQuest access token, sees what it allows, picks a language and creates " +
        "a project that stays linked to it; (2) a small badge in the project workspace header that opens a " +
        "panel to sync the link, publish approved versions, and unlink. A 'scope' is a permission ticked " +
        "when the token was made on LangQuest's Connect page; 'channel' is wherever a recording is " +
        "published, such as a listening app.",
    },
    keys: {
      "langquest.create.entry": { description: "Button in the New project dialog that switches to the LangQuest import path.", maxLength: 32 },
      "langquest.create.tokenFor": { description: "Line naming the LangQuest organization the pasted token belongs to.", placeholders: { org: "LangQuest organization name." } },
      "langquest.create.noAccess": { description: "Option in the language picker for a language the token cannot read; it is disabled.", placeholders: { name: "LangQuest language name." } },
      "langquest.create.createdToast": { description: "Toast after the project is created and linked.", placeholders: { name: "The new project's name." } },
      "langquest.error.linkFailed": {
        description:
          "Error in the import dialog when the project was made but the LangQuest link failed; the dialog stays open and the button becomes Try linking again.",
        placeholders: { reason: "A full sentence saying why: LangQuest refused the token, or could not be reached." },
      },
      "langquest.capability.missing": {
        description: "Shown under a capability the token lacks, naming the permission to tick on LangQuest's Connect page. Keep the scope id untranslated.",
        placeholders: { scope: "A LangQuest scope id such as read or release, shown as-is." },
      },
      "langquest.badge.label": { description: "Workspace header badge on a linked project.", placeholders: { language: "LangQuest language name." }, maxLength: 40 },
      "langquest.badge.ariaLabel": { description: "Screen-reader name of the header badge button that opens the LangQuest link panel." },
      "langquest.panel.orgLanguage": {
        description: "Subtitle of the link panel.",
        placeholders: { language: "LangQuest language name.", org: "LangQuest organization name." },
      },
      "langquest.panel.lastSynced": { description: "When the project last pulled from LangQuest.", placeholders: { when: "A formatted date and time." } },
      "langquest.panel.lastError": { description: "Why the last sync failed.", placeholders: { reason: "Technical error text, often English." } },
      "langquest.panel.syncFailed": { description: "Why the sync just run failed.", placeholders: { reason: "Technical error text, often English." } },
      "langquest.panel.syncing": {
        description: "Progress line while a sync runs.",
        placeholders: { passages: "Passages read from LangQuest so far.", takes: "Recordings attached so far." },
      },
      "langquest.panel.synced": {
        description: "Result line after a sync.",
        placeholders: { cells: "Passages newly added to the project.", takes: "Recordings newly attached." },
      },
      "langquest.panel.published": {
        description: "Result of publishing to a channel.",
        placeholders: {
          released: "Passages reported live or taken down.",
          unchanged: "Passages skipped because nothing changed or nothing is approved.",
          failed: "Passages LangQuest refused.",
        },
      },
      "langquest.panel.channelPlaceholder": { description: "Example channel name in the empty Channel field; a listening app's name. Can stay untranslated." },
      "langquest.wizard.languageLoading": { description: "Loading line while the wizard asks LangQuest for an organization's languages.", placeholders: { org: "LangQuest organization name." } },
      "langquest.wizard.linkedProjects": { description: "Under an organization in the wizard's org list: how many Aquilla projects import from it.", placeholders: { count: "Number of linked projects." } },
      "langquest.list.ariaLabel": {
        description: "Screen-reader name of the LangQuest mark beside a linked project's name in the projects list.",
        placeholders: { language: "LangQuest language name.", state: "One of the langquest.list.* states, already translated." },
      },
      "langquest.settings.connectedOn": { description: "When the token was saved.", placeholders: { date: "A formatted date." } },
      "langquest.settings.lastChecked": { description: "When LangQuest last confirmed the token.", placeholders: { when: "A formatted date and time." } },
      "langquest.settings.scopes": { description: "The token's LangQuest scopes, shown as-is.", placeholders: { scopes: "Comma-joined scope ids such as read, release." } },
      "langquest.settings.disconnectConfirmTitle": { description: "Title of the confirm dialog before forgetting a connection.", placeholders: { org: "LangQuest organization name." } },
    },
  },
  surfaces: [],
})
