import { defineNamespace, plural } from "./types"

/**
 * `org` namespace — registered up front by the swarm orchestrator so parallel
 * agents fill only this file and never contend on the `messages/en.ts` barrel.
 *
 * Every key here MUST be prefixed `org.` — the namespace's name is derived
 * from its first key, not from the filename.
 */
export const org = defineNamespace({
  keys: {
    // -- OrgBreadcrumb: org-switcher trail above every org/project route --
    "org.breadcrumb.allOrganizations": "All organizations",
    "org.breadcrumb.organizationFallback": "Organization",

    // -- OrgSwitcher: sidebar dropdown that swaps the active org --
    "org.switcher.workspaceFallback": "Workspace",
    "org.switcher.triggerAriaLabel": "Organization switcher: {org}",
    "org.switcher.searchPlaceholder": "Find an organization…",
    "org.switcher.searchAriaLabel": "Find an organization",
    "org.switcher.clearSearchAriaLabel": "Clear search",
    "org.switcher.noOrganizationsFound": "No organizations found.",
    "org.switcher.allProjects": "All projects",
    "org.switcher.create": "Create",

    // -- LaneChips: per-lane progress chips on an OrgHome project row --
    "org.laneChips.tooltip": "{label} — {pct} translated",
    "org.laneChips.ariaLabel": "{label}: {pct} translated",

    // -- OrgHome: org dashboard (org list, project portfolio, signed-out/empty states) --
    "org.orgHome.signedOut.heading": "Sign in to see your workspace",
    "org.orgHome.signedOut.description":
      "Your session has ended or you are not signed in. Sign in to access your projects and translation data.",
    "org.orgHome.loadingDashboard": "Loading dashboard",
    "org.orgHome.selectOrgToCreateProject": "Select an organization to create a project",

    "org.orgHome.pendingInvitations.heading": "Pending invitations",
    "org.orgHome.pendingInvitations.invitedByAs": "Invited by {username} as",
    "org.orgHome.pendingInvitations.expiresOn": "expires {date}",
    "org.orgHome.pendingInvitations.reviewAccept": "Review & accept",

    "org.orgHome.organizations": "Organizations",
    "org.orgHome.avgTranslated": "Avg translated",
    "org.orgHome.avgValidated": "Avg validated",
    "org.orgHome.avgAudio": "Avg audio",
    "org.orgHome.stalled": "Stalled",
    "org.orgHome.overdue": "Overdue",
    "org.orgHome.dueSoon": "Due soon",
    "org.orgHome.dueDate": "Due {date}",
    "org.orgHome.pctTranslated": "{pct}% translated",
    "org.orgHome.pctValidated": "{pct}% validated",
    "org.orgHome.noProjectsYet": "No projects yet.",

    "org.orgHome.organizationsPanel.countFraction": "{shown} of {total}",
    "org.orgHome.organizationsPanel.filterPlaceholder": "Filter organizations…",
    "org.orgHome.organizationsPanel.filterAria": "Filter organizations by name",
    "org.orgHome.organizationsPanel.noOrganizationsYet": "No organizations yet.",
    "org.orgHome.organizationsPanel.noMatchingOrganizations": "No matching organizations.",
    "org.orgHome.organizationsPanel.projectCount": plural({ one: "{count} project", other: "{count} projects" }),

    "org.orgHome.projectsPanel.filterPlaceholder": "Filter projects…",
    "org.orgHome.projectsPanel.filterAria": "Filter projects by name",
    "org.orgHome.projectsPanel.clearFilterAria": "Clear project filter",
    "org.orgHome.projectsPanel.statusLabel": "Status",
    "org.orgHome.projectsPanel.statusFilterAria": "Project status filter",
    "org.orgHome.projectsPanel.sortByLabel": "Sort by",
    "org.orgHome.projectsPanel.sortProjectsAria": "Sort projects",
    "org.orgHome.projectsPanel.noMatchingProjects": "No matching projects.",

    "org.orgHome.statusFilter.all": "All",

    "org.orgHome.emptyTitle.stalled": "No stalled projects.",
    "org.orgHome.emptyTitle.attention": "No projects need attention.",
    "org.orgHome.emptyTitle.overdue": "No overdue projects.",

    "org.orgHome.readyTitle": "Your organization is ready",
    "org.orgHome.readyDescription":
      "Start a translation project, or bring your team in first — Aquilla is built for people working together.",
    "org.orgHome.inviteYourTeam": "Invite your team",

    "org.orgHome.workloadVisibilityDescription":
      "Who can see each teammate's assignment progress on this org's overview.",
    "org.orgHome.usageVisibilityDescription": "Who can see each teammate's usage on this org's overview.",

    "org.orgHome.lens.recentLabel": "Recently updated",
    "org.orgHome.lens.recentDescription": "Latest project activity across all organizations",
    "org.orgHome.lens.recentEmpty": "No recently updated projects yet.",
    "org.orgHome.lens.attentionDescription": "Highest-priority projects by deadline, activity, and progress",
    "org.orgHome.lens.attentionEmpty": "No projects need attention yet.",
    "org.orgHome.lens.leastTranslatedLabel": "Least translated",
    "org.orgHome.lens.leastTranslatedDescription": "Projects with the lowest translation progress",
    "org.orgHome.lens.mostProgressLabel": "Most progress",
    "org.orgHome.lens.mostProgressDescription": "Projects with the highest translation progress",
    "org.orgHome.lens.nameDescription": "Projects sorted alphabetically",
    "org.orgHome.lens.pmLabel": "Project manager",
    "org.orgHome.lens.pmDescription": "Projects grouped by their designated project manager",

    "org.orgHome.table.projectHeader": "Project",
    "org.orgHome.table.orgHeader": "Org",
    "org.orgHome.table.languageHeader": "Language",
    "org.orgHome.table.translatedHeaderLabel": "Translated",
    "org.orgHome.table.translatedHeaderDescription":
      "Translated: percentage of cells with target-language content filled in.",
    "org.orgHome.table.validatedHeaderLabel": "Validated",
    "org.orgHome.table.validatedHeaderDescription":
      "Validated: percentage of cells marked validated by a reviewer.",
    "org.orgHome.table.audioHeaderLabel": "Has audio",
    "org.orgHome.table.audioHeaderDescription":
      "Audio: percentage of cells with at least one recording attached.",
    "org.orgHome.table.sourceTargetLanguageAria": "Source and target language",
    "org.orgHome.table.audioPctAria": "{pct}% audio",

    // -- GuestOrgHome: overview for a project-only guest viewing an org they don't belong to --
    "org.guestOrgHome.orgFallbackWithId": "Org #{id}",
    "org.guestOrgHome.description":
      "Projects in {orgName} shared with you. You’re a guest here — you have access to these projects, but not to the organization itself.",
    "org.guestOrgHome.loading": "Loading…",
    "org.guestOrgHome.emptyTitle": "Nothing shared with you from {orgName} yet.",
    "org.guestOrgHome.emptyDescription":
      "When someone invites you to a project in this organization, it shows up here.",
    "org.guestOrgHome.newBadge": "New",

    // -- ProjectMembersPage (AQU-180): per-project Members page --
    "org.membersPage.inviteLinkTab": "Invite link",
    "org.membersPage.lockedHintOrgAccess": "Access via org membership — remove from org to revoke",
    "org.membersPage.lockedHintCreator": "Project creator",
    "org.membersPage.removeDirectAccessTooltip":
      "Removes {username}'s direct project access. Access via org, team, or creator status is unaffected.",
    "org.membersPage.remove": "Remove",
    "org.membersPage.revokeAllTooltip":
      "Review every access path this member holds (direct, org, team), then revoke with typed confirmation.",
    "org.membersPage.revokeAll": "Revoke all",
    "org.membersPage.rosterHiddenTitle": "Roster hidden",
    "org.membersPage.rosterHiddenBody":
      "This organization has restricted who can view the member list. Ask an owner or maintainer if you need access.",
    "org.membersPage.projectMembersHeading": "Project members",
    "org.membersPage.currentMembersHeading": "Current members",
    "org.membersPage.rosterHint":
      "Everyone who currently has access to this project. Each row shows how they got it — direct invite, org membership, or team.",
    "org.membersPage.noMembersYet": "No members yet.",
    "org.membersPage.noDirectMembers": "No one has been added directly to this project yet.",
    "org.membersPage.orgAccessHeading": "Organization members with access",
    "org.membersPage.orgAccessSummary": plural({
      one: "{count} person has access through their organization role — they were not added to this project directly. Remove them from the org to revoke.",
      other: "{count} people have access through their organization role — they were not added to this project directly. Remove them from the org to revoke.",
    }),
    "org.membersPage.addMemberHeading": "Add member",
    "org.membersPage.allOrgMembersAdded": "All org members are already on this project.",
    "org.membersPage.addMembersAction": "add members to this project",
    "org.membersPage.requiredRoleMaintainerOrHigher": "Maintainer or higher",
    "org.membersPage.removeMemberTitle": "Remove member",
    "org.membersPage.removeMemberDescription":
      "Remove {username}'s direct {role} access to this project? Any access via org, team, or creator status is unaffected — use \"Revoke all\" to review every path.",
    "org.membersPage.accessRevokedTitle": "Access revoked",
    "org.membersPage.directGrantRemoved": "Direct grant for {username} has been removed.",
    "org.membersPage.noDirectGrantToRemove": "{username} had no direct grant to remove.",
    "org.membersPage.accessStillGrantedVia": "Access still granted via:",
    "org.membersPage.done": "Done",
    "org.membersPage.revokeAllAccessTitle": "Revoke all access",
    "org.membersPage.revokeAllExplanation":
      "This will remove {username}'s direct membership grant from this project. Any access they have via org, group, or creator status will remain.",
    "org.membersPage.currentGrantPathsFor": "Current grant paths for {username}:",
    "org.membersPage.typeToConfirm": "Type {username} to confirm",
    "org.membersPage.revoking": "Revoking…",
    "org.membersPage.revokeAccess": "Revoke access",
    "org.membersPage.willBeRemoved": "will be removed",
    "org.membersPage.staysGranted": "stays",
    "org.membersPage.sourceDirectInvite": "direct invite",
    "org.membersPage.sourceViaTeam": "via team",
    "org.membersPage.sourceViaOrg": "via org",
    "org.membersPage.sourceProjectCreator": "project creator",
    "org.membersPage.changeRoleAria": "Change role",
    "org.membersPage.inviteLinkReadyHeading": "Invite link ready",
    "org.membersPage.inviteLinkReadyBody":
      "Send this link to the recipient. Anyone with the link can join.",
    "org.membersPage.copyUrl": "Copy URL",
    "org.membersPage.inviteRecipientNote":
      "The recipient signs in (or signs up) and is added as {role}. To revoke later, use the Members tab to remove them.",
    "org.membersPage.memberFallback": "a member",
    "org.membersPage.createAnotherLink": "Create another link",
    "org.membersPage.createInviteLink": "Create invite link",
    "org.membersPage.roleLabel": "Role",
    "org.membersPage.signInToCreateLinkHint": "Sign in to create an invite link",
    "org.membersPage.recipientEmailLabel": "Recipient email (optional)",
    "org.membersPage.invalidEmailError":
      "Enter a valid email address, or leave blank for an open link.",
    "org.membersPage.signInRequiredError": "Sign in to create an invite link.",
    "org.membersPage.createInviteFailedError":
      "Couldn't create invite. You may not have permission, or the server is unreachable.",
    "org.membersPage.emailPrefillHint": "The join page prefills sign-up with this email.",
    "org.membersPage.openLinkHint": "Leave blank for an open link anyone signed in can redeem.",
    "org.membersPage.linkExpiresLabel": "Link expires",
    "org.membersPage.expiry1Day": "1 day",
    "org.membersPage.expiry7DaysDefault": "7 days (default)",
    "org.membersPage.expiry30Days": "30 days",
    "org.membersPage.expiryNone": "No expiry",
    "org.membersPage.creating": "Creating…",
  },
  context: {
    _context: {
      description:
        "Organizations, teams, members and invitations — the permanent chrome above a project: the org switcher, breadcrumb trail, member and team management, invite flows and permission surfaces. Most of these strings sit in a narrow header or sidebar that is on screen on every route, so they compete for horizontal space with the project's own content.",
    },
    keys: {
      "org.switcher.triggerAriaLabel": {
        description:
          "Accessible name for the sidebar button that opens the org switcher dropdown. {org} is the currently selected organization's name (or 'All organizations'/'Workspace').",
        placeholders: { org: "Name of the currently active organization, or the fallback label if unnamed." },
      },
      "org.switcher.searchAriaLabel": {
        description:
          "Accessible name for the org-switcher's search input. The visible placeholder for the same field ends in an ellipsis; this accessible name must not, per the catalog's ellipsis convention for screen readers.",
      },
      "org.switcher.clearSearchAriaLabel": {
        description: "Accessible name for the small × button that clears the org-switcher search field.",
      },
      "org.laneChips.tooltip": {
        description:
          "Tooltip on a per-lane progress chip on the org project table (OrgHome). {label} is the lane's display name (a target language or a lane tag); {pct} is an already-locale-formatted, bidi-isolated percentage string like '31%' — do not add another '%' sign.",
        placeholders: {
          label: "Lane display name (target language or lane tag) — not translated, may be a language name.",
          pct: "Pre-formatted percentage string (e.g. '31%'), already locale-aware and bidi-isolated.",
        },
      },
      "org.laneChips.ariaLabel": {
        description:
          "Accessible name for a per-lane progress chip, read by screen readers in place of the chip's compact visual layout. Same {label}/{pct} semantics as org.laneChips.tooltip.",
        placeholders: {
          label: "Lane display name (target language or lane tag) — not translated, may be a language name.",
          pct: "Pre-formatted percentage string (e.g. '31%'), already locale-aware and bidi-isolated.",
        },
      },
      "org.orgHome.pendingInvitations.invitedByAs": {
        description:
          "Text before the role badge in a Pending invitations row on OrgHome: '{username} as <role badge>'. {username} is the inviter's username, rendered verbatim.",
        placeholders: { username: "Username of the person who sent the invite — not translated." },
      },
      "org.orgHome.pendingInvitations.expiresOn": {
        description:
          "Trailing clause on a Pending invitations row, shown only when the invite has an expiry: ' · expires {date}'. {date} is already locale-formatted.",
        placeholders: { date: "Already locale-formatted expiry date string." },
      },
      "org.orgHome.dueDate": {
        description: "Second line of the project-row deadline tooltip on OrgHome, naming the exact due date.",
        placeholders: { date: "Already-formatted deadline date (e.g. 'Jan 1, 2020')." },
      },
      "org.orgHome.pctTranslated": {
        description:
          "Percentage-translated figure on OrgHome — used both as the org-card summary line ('{pct}% translated') and as the accessible name for a project row's translated-percent cell.",
        placeholders: { pct: "Whole-number translated percentage, e.g. 40." },
      },
      "org.orgHome.pctValidated": {
        description:
          "Percentage-validated figure on OrgHome — used both as the org-card summary line ('{pct}% validated') and as the accessible name for a project row's validated-percent cell.",
        placeholders: { pct: "Whole-number validated percentage, e.g. 20." },
      },
      "org.orgHome.organizationsPanel.countFraction": {
        description:
          "Subheading under 'Organizations' on the all-orgs dashboard, showing how many of the caller's organizations match the current filter: '{shown} of {total}'.",
        placeholders: {
          shown: "Count of organizations currently visible after filtering.",
          total: "Total count of organizations the caller belongs to.",
        },
      },
      "org.orgHome.organizationsPanel.projectCount": {
        description:
          "Project count shown under an organization's name in the all-orgs org list (e.g. '3 projects').",
        placeholders: {
          count: "How many projects the organization contains; also selects the plural form.",
        },
      },
      "org.orgHome.organizationsPanel.filterAria": {
        description:
          "Accessible name for the search input that filters the all-orgs organization list by name. The visible placeholder for the same field ends in an ellipsis; this accessible name must not.",
      },
      "org.orgHome.projectsPanel.filterAria": {
        description:
          "Accessible name for the search input that filters the project list by name (and, on the all-orgs view, PM username). The visible placeholder for the same field ends in an ellipsis; this accessible name must not.",
      },
      "org.orgHome.projectsPanel.clearFilterAria": {
        description: "Accessible name for the small × button that clears the project-list search field.",
      },
      "org.orgHome.projectsPanel.statusFilterAria": {
        description:
          "Accessible name for the project status filter control (the All / Stalled / Overdue / Needs attention segmented tabs) on OrgHome.",
      },
      "org.orgHome.projectsPanel.sortProjectsAria": {
        description: "Accessible name for the 'Sort by' project-lens select control on OrgHome.",
      },
      "org.orgHome.table.sourceTargetLanguageAria": {
        description:
          "Accessible name for the source→target language pair shown beneath a project's name in the project table row.",
      },
      "org.orgHome.table.audioPctAria": {
        description: "Accessible name for a project row's 'has audio' percent cell in the project table.",
        placeholders: { pct: "Whole-number audio-coverage percentage, e.g. 50." },
      },
      "org.guestOrgHome.orgFallbackWithId": {
        description:
          "Heading fallback on GuestOrgHome when the guest org's name hasn't loaded yet but its id is known.",
        placeholders: { id: "Numeric id of the guest organization." },
      },
      "org.guestOrgHome.description": {
        description:
          "Subheading on GuestOrgHome explaining the caller's guest access: they can see this org's shared projects but aren't a member of the organization itself.",
        placeholders: { orgName: "Display name of the guest organization — not translated." },
      },
      "org.guestOrgHome.emptyTitle": {
        description: "Empty-state title on GuestOrgHome when no projects in the guest org are shared with the caller.",
        placeholders: { orgName: "Display name of the guest organization — not translated." },
      },
      "org.membersPage.removeDirectAccessTooltip": {
        description:
          "Tooltip on a member row's Remove button, explaining exactly what removing a direct grant does and doesn't affect.",
        placeholders: { username: "The member's username — not translated." },
      },
      "org.membersPage.orgAccessSummary": {
        description:
          "Summary line above the org-access-only member section, explaining why these people aren't listed as direct project members.",
        placeholders: { count: "Number of members who hold access only via their organization role." },
      },
      "org.membersPage.removeMemberDescription": {
        description: "Confirmation-dialog body when removing a member's direct project grant.",
        placeholders: {
          username: "The member's username — not translated.",
          role: "The member's current role display name (e.g. 'Maintainer'), already localized.",
        },
      },
      "org.membersPage.directGrantRemoved": {
        description:
          "Revoke-all result message: the member's direct grant was removed. Rendered via RichMessage with {username} in bold.",
        placeholders: { username: "The member's username — not translated." },
      },
      "org.membersPage.noDirectGrantToRemove": {
        description:
          "Revoke-all result message when the member had no direct grant to begin with. Rendered via RichMessage with {username} in bold.",
        placeholders: { username: "The member's username — not translated." },
      },
      "org.membersPage.revokeAllExplanation": {
        description:
          "Explains the scope of the revoke-all action above the typed-confirmation input. Rendered via RichMessage with {username} in bold.",
        placeholders: { username: "The member's username — not translated." },
      },
      "org.membersPage.currentGrantPathsFor": {
        description: "Heading above the list of grant paths (direct/org/team/creator) in the revoke-all dialog.",
        placeholders: { username: "The member's username — not translated." },
      },
      "org.membersPage.typeToConfirm": {
        description:
          "Instruction above the typed-confirmation input for revoke-all. Rendered via RichMessage with {username} in bold.",
        placeholders: { username: "The exact username the caller must type to confirm — not translated." },
      },
      "org.membersPage.changeRoleAria": {
        description:
          "Accessible name for a member row's role-change select trigger. The visible content is only the current role's name, so this is the only place a screen reader is told what the control does.",
      },
      "org.membersPage.inviteRecipientNote": {
        description:
          "Fine print under a freshly issued invite link, naming the role the recipient will join as.",
        placeholders: { role: "The invite's role display name (e.g. 'Contributor'), already localized, or a generic fallback." },
      },
    },
  },
  surfaces: [],
})
