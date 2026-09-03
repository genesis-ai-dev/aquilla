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
    // AQU-882/AQU-883: retry affordances for the two independent load failures
    // the switcher can show — the member-org list, and the project directory
    // that backs guest orgs.
    "org.switcher.retryOrganizationsAriaLabel": "Retry loading organizations",
    "org.switcher.retrySharedOrganizationsAriaLabel": "Retry loading shared organizations",
    "org.switcher.couldNotLoadSharedOrganizations": "Couldn’t load shared organizations",

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
    // AQU-883: the project directory backs shared/guest projects; its failure used to
    // be indistinguishable from an empty list, so it gets its own announced state.
    "org.orgHome.projectDirectoryError.title": "Couldn’t load your project directory",
    "org.orgHome.projectDirectoryError.description":
      "Projects shared with you and guest organizations may be missing from this view.",
    "org.orgHome.noProjectsYet": "No projects yet.",
    // AQU-882: the all-organizations route's own org-list load failure —
    // distinct from projectDirectoryError above, which is the accessible-
    // projects/guest-org feed.
    "org.orgHome.allOrgsError.title": "Couldn’t load your organizations",
    // AQU-864: no org in scope at all — offer the only thing that moves the
    // caller forward, creating one. "Create organization" button reuses
    // `org.createDialog.title` (identical text).
    "org.orgHome.noOrgYet.title": "You're not part of an organization yet",
    "org.orgHome.noOrgYet.description":
      "Create one to start a translation project, or ask a teammate to invite you to theirs.",

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
    "org.orgHome.originFilter.aria": "Filter projects by origin",
    "org.orgHome.projectsPanel.sortByLabel": "Sort by",
    "org.orgHome.projectsPanel.sortAria": "Project sort",
    "org.orgHome.projectsPanel.sortProjectsAria": "Sort projects",
    "org.orgHome.projectsPanel.noMatchingProjects": "No matching projects.",

    "org.orgHome.statusFilter.all": "All",
    "org.orgHome.statusFilter.shared": "Shared",

    "org.orgHome.emptyTitle.stalled": "No stalled projects.",
    "org.orgHome.emptyTitle.attention": "No projects need attention.",
    "org.orgHome.emptyTitle.overdue": "No overdue projects.",

    // Invite-cohort copy; the Projects table no longer uses these. Invite lives
    // on Overview via OrgSetupChecklist.
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
    "org.orgHome.lens.pmDescription": "Projects grouped by their designated project manager",

    // "Org" column heading → common.org (identical text)
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

    // -- Guest org projects page: same table as a member org, guest copy --
    "org.guestOrgHome.orgFallbackWithId": "Org #{id}",
    "org.guestOrgHome.description":
      "Projects in {orgName} shared with you. You’re a guest here — you have access to these projects, but not to the organization itself.",
    "org.guestOrgHome.emptyTitle": "Nothing shared with you from {orgName} yet.",
    "org.guestOrgHome.emptyDescription":
      "When someone invites you to a project in this organization, it shows up here.",
    "org.guestOrgHome.newBadge": "New",

    // -- ProjectMembersPage (AQU-180): per-project Members page --
    "org.membersPage.loadingMembers": "Loading members",
    // "Invite link" tab → projectSettings.share.tabInviteLink (identical text)
    "org.membersPage.lockedHintOrgAccess": "Access via org membership — remove from org to revoke",
    // "Project creator" tooltip → projectSettings.share.lockedHintCreator (identical text; see
    // org.membersPage.sourceProjectCreator's duplicate-exceptions.ts entry for the lowercase
    // badge-fragment sibling that stays distinct)
    "org.membersPage.removeDirectAccessTooltip":
      "Removes {username}'s direct project access. Access via org, team, or creator status is unaffected.",
    "org.membersPage.remove": "Remove",
    "org.membersPage.revokeAllTooltip":
      "Review every access path this member holds (direct, org, team), then revoke with typed confirmation.",
    "org.membersPage.revokeAll": "Revoke all",
    "org.membersPage.rosterHiddenTitle": "Roster hidden",
    "org.membersPage.rosterHiddenBody":
      "This organization has restricted who can view the member list. Ask an owner or maintainer if you need access.",
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
    "org.membersPage.removeMemberTitle": "Remove member",
    "org.membersPage.removeMemberDescription":
      "Remove {username}'s direct {role} access to this project? Any access via org, team, or creator status is unaffected — use \"Revoke all\" to review every path.",
    "org.membersPage.accessRevokedTitle": "Access revoked",
    "org.membersPage.directGrantRemoved": "Direct grant for {username} has been removed.",
    "org.membersPage.noDirectGrantToRemove": "{username} had no direct grant to remove.",
    "org.membersPage.accessStillGrantedVia": "Access still granted via:",
    // "Done" → common.done (identical text)
    "org.membersPage.revokeAllAccessTitle": "Revoke all access",
    "org.membersPage.revokeAllExplanation":
      "This will remove {username}'s direct membership grant from this project. Any access they have via org, group, or creator status will remain.",
    "org.membersPage.currentGrantPathsFor": "Current grant paths for {username}:",
    "org.membersPage.typeToConfirm": "Type {username} to confirm",
    // "Revoking…" → common.revoking (identical text)
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
    // "Copy URL" → projectSettings.share.copyUrlLabel (identical text)
    "org.membersPage.inviteRecipientNote":
      "The recipient signs in (or signs up) and is added as {role}. To revoke later, use the Members tab to remove them.",
    // "a member" fallback → projectSettings.share.recipientJoinsAsFallbackRole (identical text)
    // "Create another link" → projectSettings.share.createAnotherLinkButton (identical text)
    // "Create invite link" → projectSettings.share.createInviteLinkButton (identical text)
    // "Role" field label → common.roleLabel (identical text)
    // "Sign in to create an invite link" hint → projectSettings.share.signInToCreateLink (identical text)
    "org.membersPage.recipientEmailLabel": "Recipient email (optional)",
    // invalid-email error → projectSettings.share.inviteEmailInvalid (identical text)
    // sign-in-required error → projectSettings.share.signInToInvite (identical text)
    // create-invite-failed error → projectSettings.share.createInviteFailed (identical text)
    "org.membersPage.emailPrefillHint": "The join page prefills sign-up with this email.",
    // open-link hint → projectSettings.share.openLinkNote (identical text)
    // "Link expires" label → projectSettings.share.linkExpiresLabel (identical text)
    // "1 day" expiry option → projectSettings.share.expiryOneDay (identical text)
    "org.membersPage.expiry7DaysDefault": "7 days (default)",
    // "30 days" expiry option → common.thirtyDays (identical text)
    // "No expiry" expiry option → common.noExpiry (identical text)
    // -- TeamsList: org's list of teams --
    "org.teamsList.pageDescription": "Group members and grant project access together.",
    "org.teamsList.newTeamButton": "New team",
    "org.teamsList.searchPlaceholder": "Search teams…",
    "org.teamsList.sortByAriaLabel": "Sort teams by",
    "org.teamsList.sortNameLabel": "Name (A–Z)",
    "org.teamsList.sortMembersLabel": "Members (most first)",
    "org.teamsList.sortProjectsLabel": "Projects (most first)",
    "org.teamsList.visibilityFilterAriaLabel": "Filter teams by visibility",
    "org.teamsList.visibilityInternalLabel": "Internal only",
    "org.teamsList.visibilityPublicLabel": "Public only",
    "org.teamsList.selectOrgTitle": "Select an organization",
    "org.teamsList.selectOrgDescription":
      "Teams are managed within a single organization. Choose one from the switcher to continue.",
    "org.teamsList.noTeamsTitle": "No teams in this org yet.",
    "org.teamsList.noTeamsAdminDescription":
      "Create a team to group members and grant project access together.",
    "org.teamsList.noTeamsNonAdminDescription":
      "An org admin can create teams to group members and grant project access together.",
    "org.teamsList.noTeamsMatchQuery": "No teams match “{query}”",
    "org.teamsList.noPublicTeams": "No public teams in this organization",
    "org.teamsList.noInternalTeams": "No internal teams in this organization",
    "org.teamsList.noTeamsMatchFilters": "No teams match your filters",
    "org.teamsList.publicBadge": "Public",
    "org.teamsList.memberBadge": "Member",
    "org.teamsList.memberCount": plural({ one: "{count} member", other: "{count} members" }),
    "org.teamsList.createErrorFallback": "Couldn't create team.",

    // -- Shared team-form fields (TeamsList create dialog + TeamDetail edit dialog) --
    "org.teamForm.nameLabel": "Team name",
    // "Description (optional)" → common.descriptionOptional (identical text)

    // -- TeamDetail: a single team's page --
    "org.teamDetail.notFoundTitle": "Team not found.",
    "org.teamDetail.notFoundDescription":
      "This team may have been deleted, or you may not have access to it.",
    "org.teamDetail.deleteTeamButton": "Delete team",
    "org.teamDetail.editDialogTitle": "Edit team",
    "org.teamDetail.deleteConfirmTitle": "Delete '{name}'?",
    "org.teamDetail.deleteConfirmBody": "This removes the team and all its grants.",
    "org.teamDetail.deletingButton": "Deleting…",
    "org.teamDetail.accessLevelDefinitionsAriaLabel": "Access level definitions",
    "org.teamDetail.addMemberButton": "Add member",
    "org.teamDetail.addMembersDialogTitle": "Add members to '{name}'",
    "org.teamDetail.removeAriaLabel": "Remove {name}",
    "org.teamDetail.allMembersAddedNotice": "All org members are already in this team.",
    "org.teamDetail.addErrorPrefix": "Couldn't add: {error}",
    "org.teamDetail.couldntBeAddedFallback": "couldn't be added",
    // "Adding…" → common.adding (identical text)
    "org.teamDetail.noMembersTitle": "No members.",
    "org.teamDetail.noMembersAdminDescription":
      "Add org members to this team to grant them shared project access.",
    "org.teamDetail.roleForAriaLabel": "Role for {name}",
    "org.teamDetail.orgLevelRoleAriaLabel": "Org-level role: {role}",
    "org.teamDetail.removeMaintainersOnlyAriaLabel": "Remove {username} — maintainers only",
    "org.teamDetail.removeRequiresMaintainerTooltip":
      "Only maintainers and org owners can remove members from a team. Ask a maintainer to remove someone.",
    "org.teamDetail.roleDescriptionViewer":
      "Viewer (100) — read-only access. No edit or management actions. Org membership at this level does not open projects until the person is added to a project or team.",
    "org.teamDetail.roleDescriptionCommenter":
      "Commenter (200) — can read and leave comments. Cannot edit content.",
    "org.teamDetail.roleDescriptionReviewer":
      "Reviewer (300) — can read, comment, and review. Cannot make direct edits.",
    "org.teamDetail.roleDescriptionContributor":
      "Contributor (400) — can edit project content. Maximum level grantable via share link.",
    "org.teamDetail.roleDescriptionProjectLead":
      "Project Lead (500) — can add members to projects, mint share-link invites, and lead project work.",
    "org.teamDetail.roleDescriptionMaintainer":
      "Maintainer (600) — can create/manage teams, rename the org, set project deadlines, and remove project members.",
    "org.teamDetail.roleDescriptionOwner":
      "Owner (700) — full control: add/remove org members, archive/restore projects, and all maintainer actions.",
    "org.teamDetail.lockedOrgRoleUnknownDescription": "This member's org-level role is unknown.",
    "org.teamDetail.lockedOrgRoleTooltip":
      "{description} This permission is set at the org level and can only be changed by an org owner.",
    "org.teamDetail.attachProjectButton": "Attach project",
    "org.teamDetail.projectToAttachAriaLabel": "Project to attach",
    "org.teamDetail.grantedRoleAriaLabel": "Granted role",
    "org.teamDetail.noProjectsTitle": "No projects.",
    "org.teamDetail.noProjectsAdminDescription":
      "Attach a project to grant this team access at a chosen role.",
    "org.teamDetail.detachButton": "Detach",
    "org.teamDetail.detachAriaLabel": "Detach {name}",
    "org.teamDetail.searchMembersPlaceholder": "Search members...",
    "org.teamDetail.selectedCount": plural({ one: "{count} selected", other: "{count} selected" }),
    "org.teamDetail.membersToAddAriaLabel": "Members to add",
    "org.teamDetail.searchOrgMembersPlaceholder": "Search org members...",
    "org.teamDetail.searchOrgMembersAriaLabel": "Search org members",
    "org.teamDetail.noMembersMatch": "No available members match.",
    "org.teamDetail.orgMembersGroupAriaLabel": "Org members",
    "org.teamDetail.saveTeamErrorFallback": "Couldn't save team.",
    "org.teamDetail.addMembersErrorFallback": "Couldn't add members.",

    // -- MemberAccessPanel: per-project access row for an org member --
    "org.memberAccessPanel.projectsWithAccessCount": plural({
      one: "{count} project with explicit access",
      other: "{count} projects with explicit access",
    }),
    "org.memberAccessPanel.orgRoleOnlyNote": "org-role only; no project overrides",
    "org.memberAccessPanel.orgRoleLabel": "Org role:",
    "org.memberAccessPanel.orgRoleAppliesNote": "— can see every project in this org.",
    "org.memberAccessPanel.orgRoleNoProjectAccessNote":
      "— does not grant project access. Add them to a project or team.",
    "org.memberAccessPanel.noOrgRole": "No org-wide role.",
    "org.memberAccessPanel.noGrantsNote": "No direct, team, or creator grants on any project.",
    "org.memberAccessPanel.resolvedLabel": "resolved:",
    "org.memberAccessPanel.directLabel": "direct:",
    "org.memberAccessPanel.teamGrantLabel": "team {name}:",
    "org.memberAccessPanel.orgGrantLabel": "org:",
    "org.memberAccessPanel.creatorGrantLabel": "creator",
    "org.memberAccessPanel.revokeButton": "Revoke direct grant",
    "org.memberAccessPanel.viaTeamLabel": "team \"{name}\"",
    "org.memberAccessPanel.viaOrgRoleLabel": "org role",
    "org.memberAccessPanel.alsoViaNote": "Also via {paths} — manage in Teams / Members.",

    // -- MemberActivityPanel: a member's recent activity panel --
    "org.memberActivityPanel.kindTargetCellCreate": "Created a translation",
    "org.memberActivityPanel.kindTargetCellCommit": "Edited a translation",
    "org.memberActivityPanel.kindTargetCellDelete": "Deleted a translation",
    "org.memberActivityPanel.kindSourceCellCreate": "Created a source cell",
    "org.memberActivityPanel.kindSourceCellCommit": "Edited a source cell",
    "org.memberActivityPanel.kindCellValidate": "Validated a cell",
    "org.memberActivityPanel.kindCellUnvalidate": "Un-validated a cell",
    "org.memberActivityPanel.kindCellWaive": "Waived a QA flag",
    "org.memberActivityPanel.kindCellUnwaive": "Un-waived a QA flag",
    "org.memberActivityPanel.kindCommentCreate": "Left a comment",
    "org.memberActivityPanel.kindCommentEdit": "Edited a comment",
    "org.memberActivityPanel.kindCommentResolve": "Resolved a comment",
    "org.memberActivityPanel.kindCellBacktranslationSet": "Set a back-translation",
    "org.memberActivityPanel.kindCellAudioAttach": "Attached audio",
    "org.memberActivityPanel.kindCellAudioSelect": "Selected an audio take",
    "org.memberActivityPanel.kindCellRetime": "Retimed a cell",
    "org.memberActivityPanel.heading": "Activity — {username}",
    "org.memberActivityPanel.closeAriaLabel": "Close member activity",
    "org.memberActivityPanel.loadingActivity": "Loading activity…",
    "org.memberActivityPanel.loadErrorFor": "Couldn't load activity for {username}.",
    "org.memberActivityPanel.filesWorkedOnHeading": "Files worked on",
    "org.memberActivityPanel.noTrackedEdits": "No tracked edits yet.",
    "org.memberActivityPanel.recentActionsHeading": "Recent actions",
    "org.memberActivityPanel.noRecentActions": "No recent actions.",

    // -- ProjectOverview: per-project overview page --
    "org.projectOverview.loadingProjectDetails": "Loading project details",
    "org.projectOverview.unreachableMessage":
      "Can't reach the server — this project may still be available.",
    "org.projectOverview.verseProgressUnavailable": "Verse progress unavailable. Retry",
    "org.projectOverview.chapterProgressUnavailable": "Progress unavailable. Retry",
    "org.projectOverview.signInMessage": "Sign in to open this project from the cloud.",
    "org.projectOverview.inactiveBadge": "Inactive",
    // "Restore" → common.restore (identical text)
    "org.projectOverview.moreActionsAria": "More actions",
    "org.projectOverview.downloadDeliverable": "Download deliverable",
    "org.projectOverview.markAsActive": "Mark as Active",
    "org.projectOverview.markAsInactive": "Mark as Inactive",
    "org.projectOverview.archive": "Archive",
    "org.projectOverview.customizeStatsAria": "Customize stats",
    // "Customize" → common.customize (identical text)
    "org.projectOverview.showStats": "Show stats",
    "org.projectOverview.aiDrafted": "AI Drafted",
    "org.projectOverview.aiDraftedTooltip":
      "Cells drafted by AI (via 'Translate all') that have not yet been human-edited or validated. A human edit or validation will move them into the Translated or Validated counts. Only cells committed after this marker was introduced are tracked — earlier AI commits are indistinguishable from human edits.",
    "org.projectOverview.hasAudioTooltip":
      "Percentage of cells that have at least one audio recording attached. This is coverage, not validation — see 'Audio Validated' for review status.",
    "org.projectOverview.audioValidated": "Audio Validated",
    "org.projectOverview.audioValidatedTooltip":
      "Not tracked yet — the server does not record whether a validation applies to text or audio content (see AQU-490).",
    "org.projectOverview.crossLaneTooltip": "Cross-language stat — not broken down per language.",
    "org.projectOverview.cellsSuffix": "cells",
    "org.projectOverview.laneDefaultFallback": "Default",
    "org.projectOverview.legendTranslated": "translated",
    "org.projectOverview.filesHeadingTruncated": "Files (top {cap} of {total})",
    "org.projectOverview.filesHeadingCount": "Files ({count})",
    "org.projectOverview.filesListAria": "File list",
    "org.projectOverview.copyCsvTooltip": "Copy the file list below as CSV",
    "org.projectOverview.copyCsv": "Copy CSV",
    "org.projectOverview.downloadCsvTooltip": "Download the file list below as a .csv file",
    "org.projectOverview.downloadCsv": "Download CSV",
    "org.projectOverview.copyCsvFailed": "Couldn't copy to clipboard.",
    "org.projectOverview.filterFilesPlaceholder": "Filter files by name…",
    "org.projectOverview.filterFilesAria": "Filter files by name",
    "org.projectOverview.sortFilesByAria": "Sort files by",
    "org.projectOverview.noFilesMatch": "No files match “{query}”.",
    "org.projectOverview.columnFilled": "Filled",
    "org.projectOverview.columnApproved": "Approved",
    "org.projectOverview.columnTotal": "Total",
    "org.projectOverview.columnWords": "Words",
    "org.projectOverview.expandFileAria": "Expand {fileName}",
    "org.projectOverview.collapseFileAria": "Collapse {fileName}",
    "org.projectOverview.fileStatsTooltip": "Cells filled / cells approved / total cells · word count",
    "org.projectOverview.fileStatsAria":
      "{filled} filled, {approved} approved, {total} total cells, {words} words",
    "org.projectOverview.moreFilesShowAll": plural({
      one: "+{count} more file — show all",
      other: "+{count} more files — show all",
    }),
    "org.projectOverview.showFewer": "Show fewer",
    "org.projectOverview.deadlineHeading": "Deadline",
    "org.projectOverview.noDeadlineSet": "No deadline set",
    "org.projectOverview.change": "Change",
    "org.projectOverview.setDeadline": "Set deadline",
    "org.projectOverview.changeDeadlineDialogTitle": "Change project deadline",
    "org.projectOverview.setDeadlineDialogTitle": "Set project deadline",
    "org.projectOverview.deadlineDialogDescription":
      "The deadline is inclusive through the end of that day anywhere on Earth.",
    "org.projectOverview.deadlineDateLabel": "Deadline date",
    "org.projectOverview.deadlineDatePlaceholder": "July 03, 2026",
    "org.projectOverview.projectManagerHeading": "Project manager",
    "org.projectOverview.unassigned": "Unassigned",
    "org.projectOverview.changeProjectManagerDialogTitle": "Change project manager",
    "org.projectOverview.assignProjectManagerDialogTitle": "Assign project manager",
    "org.projectOverview.pmDialogDescription":
      "The project manager is responsible for this project. They must be a member of the project.",
    "org.projectOverview.selectMemberPlaceholder": "Select a member",
    "org.projectOverview.teamVisibilityDescription":
      "Who can see each teammate's assignment progress on this project.",
    "org.projectOverview.noOpenAssignments": "No open assignments in this project yet.",
    "org.projectOverview.openAssignmentsStat": "{count} open · {percent}",
    "org.projectOverview.viewActivityAria": "View activity for {username}",
    "org.projectOverview.hide": "Hide",
    "org.projectOverview.noFilesToExport": "This project has no files to export yet.",
    "org.projectOverview.archiveForbidden": "Only owners can archive a project.",
    "org.projectOverview.restoreForbidden": "Only owners can restore a project.",
    "org.projectOverview.loadingVerses": "Loading verses…",
    "org.projectOverview.versesAria": "{chapter} verses",
    "org.projectOverview.loadingChapterBreakdown": "Loading breakdown…",
    "org.projectOverview.chaptersAria": "{book} chapters",
    "org.projectOverview.noChapterStructure": "No section breakdown available for this file.",
    "org.projectOverview.sectionBreakdownAria": "Section breakdown",
    "org.projectOverview.chapterBreakdownAria": "Chapter breakdown",
    "org.projectOverview.audioRecordedSummary": "{minutes} min recorded · {percent} of cells have audio",

    // -- hooks/useProjectLifecycle: freeze/reactivate toggle re-entrancy guard --
    "org.projectLifecycle.toggleInProgressError": "A freeze/reactivate toggle is already in progress.",

    // -- lib/sync/org-settings.ts AND lib/sync/project-settings.ts: shared
    // fallback for a 409 response whose body is missing the expected
    // latest-state payload, so the caller can't offer the usual
    // reload-and-merge conflict flow. Both files reuse this one key so its
    // text never needs to exist twice in the catalog. --
    "org.sync.versionConflictError": "This was changed by someone else — reload and try again.",

    // -- lib/permissions/denial.ts (actionGateProps): generic disabled-button
    // tooltip. Currently unused by any call site (only denialMessage(), the
    // richer sibling helper, is wired into the UI today) — keyed now so it's
    // ready and never drifts from the catalog the moment something adopts it. --
    "org.actionGate.deniedTooltip": "Requires at least {minRole} access",

    // -- lib/frontier/roles.ts: per-role capability blurb (ROLE_INFO), shown
    // under the role name in RoleSelect (AD-6/AQU-138), ProjectSettings/
    // MembersSection, StaffLanePopover, and — composed with the role name and
    // level via roleHelpText() — TeamDetail/OrgMembersTable's locked-role
    // tooltip. Distinct from the shorter common.role.*Description blurbs used
    // by MembersMatrixCellEditor/ProjectMembersPage/SharePanel — both are
    // real, separately-live UI copy; see the ROLE_INFO doc comment. --
    "org.role.descriptionViewer": "Read-only access. No edit or management actions.",
    "org.role.descriptionCommenter": "Can read and leave comments. Cannot edit content.",
    "org.role.descriptionReviewer": "Can read, comment, and review. Cannot make direct edits.",
    "org.role.descriptionContributor": "Can edit project content. Maximum level grantable via share link.",
    "org.role.descriptionProjectLead":
      "Can add members to projects, mint share-link invites, and lead project work.",
    "org.role.descriptionMaintainer":
      "Can create/manage teams, rename the org, set project deadlines, and remove project members.",
    "org.role.descriptionOwner":
      "Full control: add/remove org members, archive/restore projects, and all maintainer actions.",

    // -- OrgSidebar: left nav for org-scoped routes --
    "org.orgSidebar.archived": "Archived",
    "org.orgSidebar.admin": "Admin",

    // -- hooks/useOrgSettings: patch()/requestPromotion() error fallback when
    // called with no signed-in session or no resolved org id (guards a race
    // at mount, not a normal user-reachable path) --
    "org.orgSettings.noSessionError": "No session or organization — sign in and try again.",

    // -- OrgSettingsExport: who may export a project's deliverables --
    "org.exportSettings.deliverablesGroupLabel": "Deliverables",
    "org.exportSettings.whoCanExportLabel": "Who can export",
    "org.exportSettings.whoCanExportDescription":
      "Lower the floor to let translators export their own work; raise it to " +
      "keep deliverables with leads. Client-side formats (CSV, TSV) operate on " +
      "already-loaded cells and can't be enforced here.",
    "org.exportSettings.ownersOnlyPolicyNote": "Only org owners can change the export permission policy.",
    "org.exportSettings.roleOptionPlain": "{role} ({level})",
    "org.exportSettings.roleOptionViewer": "{role} ({level}) — anyone with project access",
    "org.exportSettings.roleOptionMaintainer": "{role} ({level}) — default",
    "org.exportSettings.roleOptionOwner": "{role} ({level}) — most restrictive",
    "org.exportSettings.saveFailedFallback": "Couldn't save the export permission.",

    // -- AddLanguagePopover: "+ Language" quick action on an OrgHome project row --
    "org.addLanguagePopover.triggerLabel": "Language",
    "org.addLanguagePopover.triggerAriaLabel": "Add a target language lane",
    "org.addLanguagePopover.heading": "Add a target language",
    "org.addLanguagePopover.description":
      "Registers a new lane on this project. Manage or remove lanes in project settings.",
    "org.addLanguagePopover.loadingLanguages": "Loading languages…",
    // "e.g. fr-CA" placeholder → projectSettings.create.extraLanguagesPlaceholder (identical text)
    "org.addLanguagePopover.inputAriaLabel": "New target language tag",
    // "Enter a language tag." → projectSettings.create.extraLanguagesEmptyError (identical text)
    // too-long error → projectSettings.create.extraLanguagesTooLongError (identical text)
    // already-default error → projectSettings.languages.alreadyDefaultError (identical text)
    // lane-already-exists error → projectSettings.languages.alreadyExistsError (identical text)
    "org.addLanguagePopover.loadError": "Couldn't load this project's languages. Try again.",
    "org.addLanguagePopover.conflictError": "Languages changed elsewhere. Reloaded — try adding again.",
    "org.addLanguagePopover.forbiddenError": "You don't have permission to add languages to this project.",
    // generic save-failed error → projectSettings.languages.savingFailedGeneric (identical text)

    // -- CreditsPanel: org credits/usage panel --

    // -- OrgSetupChecklist: org onboarding checklist --
    "org.setupChecklist.heading": "Get your organization started",
    "org.setupChecklist.dismissAriaLabel": "Dismiss checklist",
    "org.setupChecklist.progress": "{done} of {total} complete",
    // "Create your first project" step → onboarding.step.project.heading (identical text)
    "org.setupChecklist.inviteTeammateStep": "Invite a teammate to your organization",
    "org.setupChecklist.inviteButton": "Invite",

    // -- OrgCreateDialog: create-org dialog --
    "org.createDialog.title": "Create organization",
    "org.createDialog.description": "Give your team a workspace for projects, members, and settings.",
    "org.createDialog.nameLabel": "Organization name",
    "org.createDialog.namePlaceholder": "Acme Bible Translation",
    // "Creating…" busy label → common.creating (identical text)
    "org.createDialog.genericError": "Couldn't create your organization.",
    "org.createDialog.nameRequiredError": "Organization name is required",

    // -- OrgRenameDialog: rename-org dialog --
    "org.renameDialog.title": "Rename organization",
    "org.renameDialog.description":
      "This name is shown across the workspace — in the sidebar, settings, and member lists.",
    "org.renameDialog.genericError": "Couldn't rename your organization.",

    // -- OrgRouteGate: route guard for /orgs/:orgId/... --
    "org.routeGate.errorTitle": "Couldn’t load organizations",
    "org.routeGate.invalidTitle": "Invalid organization",
    "org.routeGate.missingTitle": "Organization not found",
    "org.routeGate.invalidBody": "That organization URL isn’t valid.",
    "org.routeGate.missingBody": "You don’t have access to organization #{orgId}, or it doesn’t exist.",
    "org.routeGate.errorFallbackBody": "Something went wrong loading your organizations.",
    "org.routeGate.loading": "Loading organization",

    // -- OrgInviteByEmail: owner-only invite-by-email form --
    "org.inviteByEmail.emailLabel": "Invitee email",
    "org.inviteByEmail.emailPlaceholder": "teammate@example.com (optional)",
    "org.inviteByEmail.roleLabel": "Org role",
    "org.inviteByEmail.submit": "Send invite",
    "org.inviteByEmail.invalidEmailError": "Enter a valid email, or leave blank for an open link.",
    "org.inviteByEmail.notSignedInError": "Sign in to invite teammates.",
    "org.inviteByEmail.sentToEmail": "Invitation sent to {email}.",
    "org.inviteByEmail.linkCreated": "Invite link created — share it below.",
    "org.inviteByEmail.createError":
      "Couldn't create the invite. You may not have permission, or the server is unreachable.",
    // "Copy" button → common.copy (identical text)

    // -- ExternalCollaboratorsSection: org-level external-collaborator governance list --
    "org.externalCollaborators.title": "External collaborators",
    "org.externalCollaborators.description":
      "People outside this organization with access to specific projects (via invite links, direct adds, or teams). Revoking removes their access to that project only.",
    "org.externalCollaborators.badge": "external",
    "org.externalCollaborators.revokeAriaLabel": "Revoke {username}'s access to {project}",
    "org.externalCollaborators.viaTeamTooltip":
      "Access via a team: detach the team or remove them from it to revoke",
    "org.externalCollaborators.viaSourceLabel": "via {source}",

    // -- MembersPage (AQU-538): org-level Members page. `org.membersPage.*` is
    // already used by ProjectMembersPage (per-project), so this org-level page
    // is scoped under `org.membersPage.orgPage.*` to avoid name collisions.
    // AQU-511/AQU-832 dedupe: several strings below that duplicated a sibling
    // per-project `org.membersPage.*` key (or `editor.navTitle.members`, the
    // page-title owner per docs/swarm/TRACES.md's `derivetitle-parallel-source`
    // note) were NOT a deliberate exception — they were removed and their call
    // sites now reuse the existing key directly. --
    "org.membersPage.orgPage.description": "People in this organization and their access.",
    "org.membersPage.orgPage.loadErrorTitle": "Couldn't load your organization",
    "org.membersPage.orgPage.loadErrorHint":
      "Common causes: the Frontier worker is unreachable, your session expired, or the request timed out. Check your network and try again.",
    "org.membersPage.orgPage.signInTitle": "Sign in to manage members",
    "org.membersPage.orgPage.selectOrgDescription":
      "Member access is managed within a single organization. Choose one from the switcher to continue.",
    "org.membersPage.orgPage.signInDescription":
      "Member access requires a Frontier session. Sign in from the dashboard and come back to this page.",
    "org.membersPage.orgPage.pageDescriptionPrefix": "People in",
    "org.membersPage.orgPage.pageDescriptionSuffix":
      ". Org-level roles apply across every project; per-project access can be granted separately via the Add-to-projects flow.",
    "org.membersPage.orgPage.addToProjectsTooltip":
      "Add someone to specific projects without granting org-wide access.",
    "org.membersPage.orgPage.addToProjectsButton": "Add to projects",
    "org.membersPage.orgPage.tabsAriaLabel": "Members views",
    "org.membersPage.orgPage.roster": "Roster",
    "org.membersPage.orgPage.matrixTab": "Matrix",
    "org.membersPage.orgPage.inviteSectionTitle": "Invite a teammate by email",
    "org.membersPage.orgPage.inviteSectionDescription":
      "Bring someone new into this organization. They don't need an Aquilla account yet — they'll be guided to create one when they accept.",
    "org.membersPage.orgPage.loadingMembers": "Loading members…",
    "org.membersPage.orgPage.rosterSectionDescription":
      "Org members and their org-wide role. Add by username, change a role, or remove someone.",
    "org.membersPage.orgPage.projectAccessTitle": "Project access",
    "org.membersPage.orgPage.projectAccessDescription": "Expand a member to see their per-project roles.",
    "org.membersPage.orgPage.matrixHint":
      "Every member × every project you can see, at a glance. Click a cell to change a role; hover a row to load its lane scopes.",
    "org.membersPage.orgPage.pendingInvitesDescription":
      "Share-link invitations that haven't been redeemed yet. Revoke to cancel.",
    "org.membersPage.orgPage.invitedByLabel": "by {username}",
    "org.membersPage.orgPage.unknownInviter": "unknown",
    "org.membersPage.orgPage.expiresInDays": plural({
      one: "expires in {count} day",
      other: "expires in {count} days",
    }),
    "org.membersPage.orgPage.expiresInHours": plural({
      one: "expires in {count} hour",
      other: "expires in {count} hours",
    }),
    "org.membersPage.orgPage.expiresInMinutes": plural({
      one: "expires in {count} minute",
      other: "expires in {count} minutes",
    }),
    "org.membersPage.orgPage.expired": "expired",
    "org.membersPage.orgPage.noExpiry": "no expiry",
    "org.membersPage.orgPage.expiresRelativePrefix": "expires {relative}",
    "org.membersPage.orgPage.revokeInviteTooltip": "Revoke invitation",
    "org.membersPage.orgPage.revokeInviteAriaLabel": "Revoke invitation to {project}",
    "org.membersPage.orgPage.targetedInviteTooltip":
      "Targeted invite: sign-up form will be prefilled with this email",
    // "open link" connector → projectSettings.share.openLinkConnector (identical text)
    "org.membersPage.orgPage.openLinkTooltip": "Open link: anyone holding the URL can redeem",
    "org.membersPage.orgPage.orgOwnerHint": "Org owner",

    // -- Shared: DataTableRowActionsButton accessible name, the "Actions for
    // X" phrasing (distinct from the "More actions for X" phrasing
    // org.orgProjectsDataTable.moreActionsAriaLabel uses for a different set
    // of tables) — reused verbatim by OrgMembersTable, TeamDetail (member AND
    // project rows), and OverviewLaneTable so the four never drift. --
    "org.rowActionsAriaLabel": "Actions for {name}",

    // -- OrgMembersTable: org roster table and member-management dialogs --
    "org.membersPage.orgTable.changeRoleDescription":
      "Maintainer and Owner can see every project in the organization. Contributor and below cannot see projects until added to a project or team.",
    "org.membersPage.orgTable.addMemberTitle": "Add a member",
    "org.membersPage.orgTable.addMemberDescription":
      "Add someone to this organization, or invite them by email if they don't have an account yet.",
    "org.membersPage.orgTable.projectAccessNote":
      "Contributor, Project lead, and Viewer join the organization but cannot see or open projects until they are added to a specific project or team. Only Maintainer and Owner can see every project.",
    "org.membersPage.orgTable.addMethodAriaLabel": "Add member method",
    "org.membersPage.orgTable.addMembersTab": "Add members",
    "org.membersPage.orgTable.inviteByEmailTab": "Invite by email",
    "org.membersPage.orgTable.noMembersTitle": "No members in this org yet.",
    "org.membersPage.orgTable.noSearchMatch": "No members match this search.",
    "org.membersPage.orgTable.removeFromOrg": "Remove from org",
    "org.membersPage.orgTable.copyEmailAriaLabel": "Copy {email}",
    "org.membersPage.orgTable.projectAccessAriaLabel": "Project access for {username}",
    "org.membersPage.orgTable.removeOwnersOnlyAriaLabel": "Remove {username} — owners only",

    // -- Org settings: consolidated security and permission-floor controls --
    "org.settingsSecurity.groupLabel": "Permissions",
    "org.settingsSecurity.groupDescription":
      "Who can export deliverables, claim work, and manage terminology.",

    // -- ProjectsList: org-wide "all projects" list --
    "org.projectsList.signedOutTitle": "Sign in to see your projects",
    "org.projectsList.signedOutBody":
      "Your session has ended or you are not signed in. Sign in to access your projects.",
    "org.projectsList.unreachableBanner": "Can't reach the server — project list unavailable.",
    "org.projectsList.noFilterMatch": "No projects match your filter.",
    "org.projectsList.noOrgProjectsYet": "No projects in this org yet.",
    "org.projectsList.noOrgLabel": "No org",
    "org.projectsList.externalOrgLabel": "External org",
    "org.projectsList.sharedWithYouDescription": "Projects from organizations outside the current scope.",
    "org.projectsList.shownOfTotal": "{visible} shown of {total}",
    "org.projectsList.lensGroupAriaLabel": "Project list view",
    "org.projectsList.viewLabel": "View",
    "org.projectsList.loadingLabel": "Loading projects",

    // -- OrgProjectsDataTable: org projects data table --
    "org.orgProjectsDataTable.pmColumn": "PM",
    "org.orgProjectsDataTable.updatedColumn": "Updated",
    "org.orgProjectsDataTable.actionsColumnSrOnly": "Project actions",
    "org.orgProjectsDataTable.moreActionsAriaLabel": "More actions for {name}",

    // -- OverviewLaneTable: per-project lane table on the project overview --
    "org.overviewLaneTable.peopleColumn": "People",
    "org.overviewLaneTable.lastActivityColumn": "Last activity",
    "org.overviewLaneTable.actionsColumn": "Actions",
    "org.overviewLaneTable.noActivityYet": "No activity yet",
    "org.overviewLaneTable.openAction": "Open",
    "org.overviewLaneTable.staffAction": "Staff…",
    "org.overviewLaneTable.addLanguageAction": "Add language",

    // -- ProjectLaneSubRows: expanded per-lane detail for an OrgHome project row --
    "org.projectLaneSubRows.noActivity": "No activity",

    // -- ArchivedProjects --
    "org.archivedProjects.selectOrgDescription":
      "Archived projects are managed within a single organization.",
    "org.archivedProjects.emptyTitle": "No archived projects.",
    "org.archivedProjects.loadingLabel": "Loading archived projects",

    // -- SharedProjectsPage: dedicated "shared with you" home --
    "org.sharedProjectsPage.scopedDescription": "Projects in {org} shared with you.",
    "org.sharedProjectsPage.unscopedDescription":
      "Projects shared with you from organizations you’re not a member of, gathered in one place.",
    "org.sharedProjectsPage.emptyUnscopedTitle": "Nothing shared with you yet.",
    "org.sharedProjectsPage.emptyDescription":
      "When someone invites you to a project in another organization, it shows up here.",

    // -- AssignWork: manager assign-a-scope-to-a-member affordance --
    // AQU-511/AQU-832 dedupe: title/submit/selectMemberPlaceholder/deadlineLabel/
    // youSuffix/the two error sentences/chaptersLabel all re-minted an existing
    // dialog.assign.* or editor.milestone.vocab.* key — call sites now reuse
    // those directly instead of duplicating them here.
    "org.assignWork.assignButtonLabel": "Assign…",
    "org.assignWork.chooseAssignee": "Choose an assignee.",
    "org.assignWork.chooseFile": "Choose a file.",
    "org.assignWork.assigneeLabel": "Assignee",
    "org.assignWork.bookLabel": "Book",
    "org.assignWork.wholeBookNoChapters": "Whole book — this file has no chapters to narrow to.",
    "org.assignWork.wholeBookNoneChecked": "Whole book (none checked)",
    "org.assignWork.chaptersSelectedCount": plural({
      one: "{count} chapter selected",
      other: "{count} chapters selected",
    }),
    "org.assignWork.clearAllChapters": "Clear all",
    "org.assignWork.selfAssignNote": "Self-assignment is on — you can claim this work for yourself.",

    // -- AssignedToMe: assignee's open-assignments inbox --
    "org.assignedToMe.selectOrgDescription": "Assignments are scoped to a single organization.",
    "org.assignedToMe.emptyTitle": "You have no open assignments.",
    "org.assignedToMe.loadingLabel": "Loading assignments",
    "org.assignedToMe.cellsProgress": "{done}/{total} cells · {pct}%",

    // -- SectionVisibilityBadge: "who can see this section" affordance --
    "org.sectionVisibilityBadge.floorEveryone": "Everyone can see this",
    "org.sectionVisibilityBadge.floorContributor": "Contributors & up can see this",
    "org.sectionVisibilityBadge.floorProjectLead": "Project leads & up can see this",
    "org.sectionVisibilityBadge.floorMaintainer": "Only maintainers & owners can see this",
    "org.sectionVisibilityBadge.floorOwner": "Only owners can see this",
    "org.sectionVisibilityBadge.rolePickerEveryone": "Everyone with access",
    "org.sectionVisibilityBadge.rolePickerContributor": "Contributors and up",
    "org.sectionVisibilityBadge.rolePickerProjectLead": "Project leads and up",
    "org.sectionVisibilityBadge.rolePickerMaintainer": "Maintainers and owners",
    "org.sectionVisibilityBadge.rolePickerOwner": "Owners only",
    "org.sectionVisibilityBadge.changeVisibilityAriaLabel": "{label}. Change section visibility",
    "org.sectionVisibilityBadge.whoCanSeeLabel": "Who can see this section",

    // -- WorkloadRollup: org Overview team-workload manager rollup --
    "org.workloadRollup.title": "Team workload",
    "org.workloadRollup.removeTooltip": "Remove this assignment",
    "org.workloadRollup.removeAriaLabel": "Remove assignment: {scope} ({user})",
    "org.workloadRollup.unknownUser": "User {id}",
    "org.workloadRollup.removeErrorGeneric":
      "Can't remove this assignment — it has no resolved cells to route through.",

    // -- UsageRollup: org Overview per-member usage manager rollup --
    "org.usageRollup.title": "Team usage",
    "org.usageRollup.audioSecondsOnly": "{seconds} s audio",
    "org.usageRollup.audioMinutesSeconds": "{minutes} min {seconds} s audio",
    "org.usageRollup.audioMinutesOnly": "{minutes} min audio",
    "org.usageRollup.aiRequestCount": plural({ one: "{count} AI request", other: "{count} AI requests" }),

    // -- AccessModelLegend: collapsible legend explaining the four grant paths --
    "org.accessModelLegend.heading": "Access model legend",
    "org.accessModelLegend.badgeColumn": "Badge",
    "org.accessModelLegend.pathColumn": "Grant path",
    "org.accessModelLegend.meaningColumn": "Meaning",
    "org.accessModelLegend.maxWinsHeading": "Effective role = max-wins",
    "org.accessModelLegend.maxWinsDescription":
      "A person's effective role on a project is the highest role they hold across all contributing paths. Adding a lower grant never reduces access. To fully remove someone, all contributing grant paths must be cleared.",
    "org.accessModelLegend.direct.label": "Direct",
    "org.accessModelLegend.direct.description":
      "A role granted explicitly to this person on this project only. The most specific path — adding or removing it affects only this project.",
    "org.accessModelLegend.viaGroup.label": "Via group",
    "org.accessModelLegend.viaGroup.description":
      "A role inherited because a group this person belongs to has access to this project. Edit the group's membership to change or remove this grant.",
    "org.accessModelLegend.orgWide.label": "Org-wide",
    "org.accessModelLegend.orgWide.description":
      "A Maintainer or Owner org role that applies to every project in this org. Contributor and below do not get project access from org membership — add them to a project or team instead.",
    "org.accessModelLegend.creator.label": "Creator",
    "org.accessModelLegend.creator.description":
      "Owner role is permanent until project ownership is transferred. Manage in the project's Settings → Share.",

    // -- JoinOrgPage: org-invite landing page (/join-org/:token) --
    "org.joinOrgPage.organizationLine": "Organization: {name}",
    "org.joinOrgPage.unnamedOrgFallback": "Unnamed organization",
    // "Loading invitation details…" → auth.join.loadingDetails (identical text)
    "org.joinOrgPage.genericInviteFallback":
      "You've been invited to join an organization on Aquilla.",
    // "Invalid invite link" → auth.join.invalidInviteLink (identical text)
    // "Go home" → error.notFound.goHome (identical text)
    "org.joinOrgPage.cantJoinTitle": "Can't join",
    "org.joinOrgPage.youreInTitle": "You're in",
    "org.joinOrgPage.joinedRedirect": "Joined {org}. Taking you there…",
    "org.joinOrgPage.fallbackOrgName": "the organization",
    // Role-line sentences below deliberately keep the source's lowercase
    // "you'll join as" (not auth.join.roleLineSingle's capitalized "You'll") —
    // this page always opens the clause mid-sentence-register, even with no
    // "Invited by" prefix, so the English text must not change to match; see
    // the duplicate-exceptions.ts entries for these two keys. The inviter
    // variants are byte-identical to auth.join.roleLineSingleInviter(Email)
    // (both open with "Invited by …", so the case question doesn't arise) —
    // call sites reuse those two directly instead of duplicating them here.
    "org.joinOrgPage.roleLine": "you'll join as {role}.",
    "org.joinOrgPage.roleLineEmail": "you'll join as {role} — invitation sent to {email}.",

    // -- MemberAccessDrillDown: per-member project-access breakdown panel --
    "org.memberAccessDrillDown.heading": "Project access breakdown",
    // "Close" → common.close (identical text)
    "org.memberAccessDrillDown.loadingAccess": "Loading access…",
    "org.memberAccessDrillDown.orgLevelBaseline": "Org-level baseline",
    "org.memberAccessDrillDown.projectsAccessibleCount": plural({
      one: "{count} project accessible",
      other: "{count} projects accessible",
    }),
    "org.memberAccessDrillDown.noAccessEmptyTitle": "{username} has no access to any project in this org.",
    "org.memberAccessDrillDown.pathDirect": "direct · {role}",
    "org.memberAccessDrillDown.pathGroup": "group \"{group}\" · {role}",
    "org.memberAccessDrillDown.pathOrgLevel": "org-level · {role}",

    // -- MemberLaneScopeEditor: freeform lane/file scope editor popover (matrix) --
    "org.memberLaneScopeEditor.editScopesAriaLabel": "Edit {username}'s lane scopes on this project",
    "org.memberLaneScopeEditor.scopesHeading": "{username}'s scopes",
    "org.memberLaneScopeEditor.unscopedFullAccess": "Unscoped — full access",
    "org.memberLaneScopeEditor.laneCodePlaceholder": "Lane code (e.g. es)",
    "org.memberLaneScopeEditor.newLaneCodeAriaLabel": "New lane code",
    // "Add" → common.add (identical text)
    "org.memberLaneScopeEditor.saveScopesButton": "Save scopes",

    // -- MemberMultiAddRow: shared staged-multi-add affordance (AQU-734) --
    "org.memberMultiAddRow.peopleToAddAriaLabel": "People to add",
    // "Role" aria-label → common.roleLabel (identical text)

    // -- MembersMatrixCellEditor: inline per-cell role editor in the members × projects matrix --
    "org.membersMatrixCellEditor.alsoHasAccessAriaLabel": "Also has access via other paths",
    "org.membersMatrixCellEditor.alsoHasAccessVia": "Also has access via:",
    "org.membersMatrixCellEditor.currentBadge": "current",
    // "Saving…" → common.saving (identical text)
    "org.membersMatrixCellEditor.removeFromProject": "Remove from project",
    "org.membersMatrixCellEditor.creatorGrantHeading": "Creator grant",
    "org.membersMatrixCellEditor.creatorGrantDescription":
      "This person created the project. Their Owner role is permanent until project ownership is transferred. The effective role here is Owner (max-wins). Manage in the project's Settings → Share.",
    "org.membersMatrixCellEditor.viaGroupHeading": "Effective role: via group (max-wins)",
    "org.membersMatrixCellEditor.viaGroupDescription":
      "This role comes from a group attached to this project. Edit the group's membership to change or remove this grant. To override for this project only, add a direct grant below.",
    "org.membersMatrixCellEditor.orgWideHeading": "Effective role: org-wide (max-wins)",
    "org.membersMatrixCellEditor.orgWideDescription":
      "This Maintainer or Owner org role applies to every project. A direct project grant added here will supersede the org-wide grant for this project only (max-wins still applies — only a higher direct role changes the effective role).",
    "org.membersMatrixCellEditor.setExceptionLabel": "Set a project-level exception (direct grant)…",
    "org.membersMatrixCellEditor.addToProjectAriaLabel": "Add {username} to project",
    // "Add {username}" popover title → workspace.typeahead.addUser (identical text)
    "org.membersMatrixCellEditor.editRoleAriaLabel": "Edit {username}'s role on this project",
    "org.membersMatrixCellEditor.editPopoverTitle": "Edit {username}",

    // -- MembersMatrixView: members × projects scan view with inline cell editing --
    "org.membersMatrixView.buildingMatrix": "Building portfolio matrix…",
    "org.membersMatrixView.memberColumnHeader": "Member",
    "org.membersMatrixView.howAccessResolvedAriaLabel": "How access is resolved",
    "org.membersMatrixView.accessResolutionExplanation":
      "Every member's access is the highest role they hold across up to four paths: a direct project grant, any group attached to this project, a Maintainer+ org role, or creator status. Adding a lower grant never reduces access — to fully remove someone, all contributing paths must be cleared.",
    "org.membersMatrixView.soleOwnerWarning": "Sole Owner: losing this person locks the project",
    "org.membersMatrixView.orgInheritedTooltip":
      "Access on every project comes from a Maintainer or Owner org role; no per-project overrides.",

    // -- MembersPanel: shared roster list (per-project and org membership) --
    // "via org" badge → org.membersPage.sourceViaOrg (identical text)
    "org.membersPanel.sourceViaGroup": "via group",
    // "creator" badge → org.memberAccessPanel.creatorGrantLabel (identical text)
    // "Change role" aria-label → org.membersPage.changeRoleAria (identical text)
    "org.membersPanel.scopesToggleLabel": "Scopes",
    "org.membersPanel.leaveEmptyForFullAccess": "Leave empty for full access.",
    "org.membersPanel.lanesLegend": "Lanes",
    "org.membersPanel.laneCheckboxAriaLabel": "Lane {lane}",
    // "Files" fieldset legend → nav.dock.filesTab (identical text)
    // File checkbox aria-label → comments.scope.file (identical "File {file}" text)

    // -- MultiProjectInviteDialog: unified add-to-projects dialog (AQU-322) --
    // "Add to projects" dialog title AND button → org.membersPage.orgPage.addToProjectsButton (identical text)
    "org.multiProjectInviteDialog.recipientLabel": "Recipient",
    "org.multiProjectInviteDialog.emailModeHint":
      "They'll receive one email per selected project with a single-use invite link.",
    "org.multiProjectInviteDialog.projectsFieldLabel": "Projects",
    "org.multiProjectInviteDialog.selectProjectAriaLabel": "Select {name}",
    "org.multiProjectInviteDialog.noProjectsAvailable":
      "No projects available — create one first or check back when sync completes.",
    "org.multiProjectInviteDialog.projectsSelectedCount": plural({
      one: "{count} project selected",
      other: "{count} projects selected",
    }),
    "org.multiProjectInviteDialog.rolesSuffix": " — roles: {roles}",
    "org.multiProjectInviteDialog.sendInvitesButton": "Send invites",

    // -- RemoveOrgMemberDialog: confirm-and-optionally-cascade org removal --
    "org.removeOrgMemberDialog.title": "Remove {username} from {orgName}?",
    "org.removeOrgMemberDialog.warningBody":
      "{username} will lose org-wide access. They will still keep access to any projects they were added to individually unless you also remove them below.",
    "org.removeOrgMemberDialog.loadingProjects": "Loading projects…",
    "org.removeOrgMemberDialog.noDirectMemberships": "No direct project memberships in this org.",
    // "Cancel" → common.cancel (identical text)

    // -- StaffLanePopover: one-gesture staffing control (AQU-538 §3.4) --
    "org.staffLanePopover.staffLaneHeading": "Staff {lane}",
    "org.staffLanePopover.orgMemberPhrase": "org member",
    "org.staffLanePopover.addOrgMemberDescription": "Add an {member} to this project, scoped to this lane.",
    "org.staffLanePopover.searchPlaceholder": "Search your organization",
    // "Search org members" aria-label → org.teamDetail.searchOrgMembersAriaLabel (identical text)
    "org.staffLanePopover.searchScopeNote":
      "Searches your organization only. Adding someone from outside it?",
    "org.staffLanePopover.inviteToProjectLink": "Invite them to the project",
    // "Change" → org.projectOverview.change (identical text)
    // "Role" aria-label → common.roleLabel (identical text)
    "org.staffLanePopover.addToLaneButton": "Add to {lane}",
    "org.staffLanePopover.broaderAccessNote": "Need broader access? Leads see all languages.",
    "org.staffLanePopover.addAsLeadButton": "Add as lead (unscoped)",

    // -- ArchivedProjects: org-level archived-projects / recently-deleted-files admin page --
    // "Project" header → common.project (identical text)
    // "Archived" header + tooltip label → org.orgSidebar.archived (identical text)
    // "Files" header → nav.dock.filesTab (identical text)
    // "Actions" sr-only header (both tables) → org.overviewLaneTable.actionsColumn (identical text)
    // "File" header → common.file (identical text)
    "org.archivedProjects.deletedColumnLabel": "Deleted",
    "org.archivedProjects.viewsAriaLabel": "Archived views",
    // "Projects" tab → nav.projects (identical text)
    // "Recently deleted" tab → nav.sidebarSection.trash (identical text)
    // "Select an organization" → org.teamsList.selectOrgTitle (identical text)
    // "Restore" menu item (both tables) → common.restore (identical text)
    "org.archivedProjects.emptyDescription":
      "When you archive a project, it shows up here until you restore it.",
    "org.archivedProjects.noSearchMatch": "No archived projects match your search.",
    // "Clear" → common.clear (identical text)
    "org.archivedProjects.loadingDeletedFilesLabel": "Loading recently deleted files",
    // "No recently deleted files." → workspace.trash.empty. Both this table's
    // empty state and the project trash dialog say the same thing about the same
    // kind of list; the scopes differ (org-wide vs one project) but the sentence
    // does not, so a translator is asked for it once.
    "org.archivedProjects.noDeletedFilesDescription":
      "When you delete a file from a project, it shows up here until you restore it.",
    "org.archivedProjects.noDeletedFilesSearchMatch": "No deleted files match your search.",

    // -- AssignedToMe: assignee's open-assignments inbox table --
    "org.assignedToMe.assignmentColumnLabel": "Assignment",
    // "File" header → common.file (identical text)
    // "Project" header → common.project (identical text)
    // "Progress" header → fileDetails.progress (identical text)
    "org.assignedToMe.dueColumnLabel": "Due",
    // "Assigned to me" page title → editor.navTitle.assignedToMe (identical text)
    "org.assignedToMe.pageDescription":
      "Open work assigned to you across this organization's projects.",
    // "Select an organization" → org.teamsList.selectOrgTitle (identical text)
    "org.assignedToMe.noOpenAssignmentsDescription":
      "When a manager assigns you a book or chapter, it will show up here.",
    "org.assignedToMe.noAssignmentsMatchFilters": "No assignments match your filters",
    "org.assignedToMe.noAssignmentsMatchSearch": "No assignments match your search.",
    // "Clear" → common.clear (identical text)

    // -- MemberActivityPanel: per-member recent-activity + file-rollup panel --
    "org.memberActivityPanel.fileRollupSummary": "{cells} cells · {words} words · {timestamp}",

    // -- OrgHome: all-orgs dashboard call-site wiring (most strings here reuse
    // existing org.orgHome.* / common.* / nav.* keys already defined above —
    // see the call site for the full mapping). Only genuinely new strings: --
    "org.orgHome.pendingInvitations.description":
      "Invites sent to your email that you have not accepted yet.",
    "org.orgHome.projectsPanel.sectionDescription":
      "Projects across organizations you belong to, plus any shared with you.",
    // Distinct from org.orgHome.noProjectsYet ("No projects yet.", with a
    // period) — this is the DataTable's own inline empty-state title, which
    // the source renders without one.
    "org.orgHome.projectsPanel.emptyTitle": "No projects yet",
    "org.orgHome.organizationsPanel.sectionDescription": "Workspaces you belong to across Aquilla.",
    // Distinct from org.orgHome.organizationsPanel.noOrganizationsYet ("No
    // organizations yet.", with a period) — this is the DataTable's own
    // empty-state title, which the source renders without one.
    "org.orgHome.organizationsPanel.emptyTitle": "No organizations yet",
    // Distinct from org.orgHome.organizationsPanel.noMatchingOrganizations
    // ("No matching organizations.", with a period) — same split as above.
    "org.orgHome.organizationsPanel.searchEmptyTitle": "No matching organizations",

    // -- OrgOverview: single-org operator home (rollup tiles + recent projects) --
    "org.overview.loadingLabel": "Loading overview",
    "org.overview.needsAttentionHeading": "Needs attention",
    "org.overview.needsAttentionDescription":
      "Active projects that are overdue, due soon, or stalled.",
    "org.overview.allClearTitle": "All clear",
    "org.overview.allClearDescription":
      "No active project is overdue, due soon, or stalled right now.",
    "org.overview.projectsDescription": "Most recently updated first.",
    "org.overview.showMoreProjects": plural({
      one: "Show {count} more",
      other: "Show {count} more",
    }),
    "org.overview.emptyDescription": "Create a project to start translating.",

    // -- OrgProjectsDataTable: shared portfolio projects DataTable (page/embedded) --
    // "Project" header → common.project (identical text)
    // "Org" header → common.org (identical text)
    // "Language" header → org.orgHome.table.languageHeader (identical text)
    // "Translated" header → org.orgHome.table.translatedHeaderLabel (identical text)
    // "Validated" header → org.orgHome.table.validatedHeaderLabel (identical text)
    // "Audio" header → nav.lens.audio (identical text)
    // "Role" header → common.roleLabel (identical text)
    // "Unassigned" → org.projectOverview.unassigned (identical text)
    // "Status" header → org.orgHome.projectsPanel.statusLabel (identical text)
    // "Updated" header + tooltip label → org.orgProjectsDataTable.updatedColumn (identical text)
    // "Project actions" sr-only header → org.orgProjectsDataTable.actionsColumnSrOnly (identical text)
    // "Assign work" menu item → dialog.assign.title (identical text)
    // "Add member" menu item → org.teamDetail.addMemberButton (identical text)
    "org.orgProjectsDataTable.noSearchMatch": "No projects match your search.",
    // "Clear" → common.clear (identical text)

    // -- OrgProjectsPage: single-org projects list page --
    // "Sign in to see your projects" → org.projectsList.signedOutTitle (identical text)
    // "Sign in" → auth.login.submitDefault (identical text)
    // "Loading projects" → org.projectsList.loadingLabel (identical text)
    // "Projects" page title → nav.projects (identical text)
    "org.orgProjectsPage.pageDescription":
      "Open a project to edit, or start a new translation workspace.",
    // AQU-1044: the toolbar's four narrowing dimensions (Status, PM, Role,
    // Updated) live in one combined "Sort by" menu (ProjectSortMenu), one
    // submenu per dimension. Reused keys:
    // "Sort by" trigger → org.orgHome.projectsPanel.sortByLabel (identical text)
    // "Status" submenu → org.orgHome.projectsPanel.statusLabel (identical text)
    // "PM" submenu → org.orgProjectsDataTable.pmColumn (identical text)
    // "Role" submenu → common.roleLabel (identical text)
    // "Updated" submenu → org.orgProjectsDataTable.updatedColumn (identical text)
    // Status options → org.orgHome.statusFilter.all/stalled/overdue,
    //   org.overview.needsAttentionHeading (same keys as ProjectStatusFilter)
    // AQU-1040: designated-PM options. The PM names themselves are usernames,
    // not strings.
    "org.orgProjectsPage.pmFilter.all": "All PMs",
    // AQU-1027: identity option pinned above the named PMs. PM designation
    // (projects.pm_user_id) is a different thing from the file assignments
    // behind "Assigned to me", so this is the only surface that exposes it.
    "org.orgProjectsPage.pmFilter.mine": "Managed by me",
    "org.orgProjectsPage.pmFilter.mineEmptyTitle": "You don’t manage any projects here.",
    // AQU-1042: viewer-role options. The role option labels come from
    // common.role.* (same keys as RoleLabel).
    "org.orgProjectsPage.roleFilter.all": "All roles",
    // AQU-1043: last-edit recency options. Fixed windows, not free-form
    // dates; "any time" is the default.
    "org.orgProjectsPage.updatedFilter.any": "Updated any time",
    "org.orgProjectsPage.updatedFilter.lastDays": "Updated in last {days} days",
    // "Unassigned" PM option → org.projectOverview.unassigned (identical text)
    // "(you)" marker on the PM column's own row → editor.validation.you
    // Filtered-to-nothing empty title → org.orgHome.projectsPanel.noMatchingProjects
    // Zero-projects empty title → org.orgHome.projectsPanel.emptyTitle
    // Zero-projects empty description → org.overview.emptyDescription
    // Invite-a-teammate lives on Overview (OrgSetupChecklist), not this table.

    // -- OrgSwitcher: sidebar org-switcher combobox dropdown --
    // "Organizations" group label → org.orgHome.organizations (identical text)
    // "Couldn't load shared organizations" → org.switcher.couldNotLoadSharedOrganizations (identical text)
    // "Retry loading shared organizations" aria-label → org.switcher.retrySharedOrganizationsAriaLabel (identical text)
    // "Retry" → common.retry (identical text)
    "org.switcher.guestOrganizationsGroupLabel": "Guest organizations",
    // Role chip on guest-org rows in the switcher (not a ladder role).
    "org.switcher.guestRole": "Guest",
    // Platform-admin chip on viaPlatformAdmin rows → org.orgSidebar.admin (identical text)
    // "All projects" → org.switcher.allProjects (identical text)
    // "Retry loading organizations" aria-label → org.switcher.retryOrganizationsAriaLabel (identical text)
    // "Couldn't load organizations" → org.routeGate.errorTitle (identical text)
    // "Find an organization…" placeholder → org.switcher.searchPlaceholder (identical text)
    // "Find an organization" aria-label → org.switcher.searchAriaLabel (identical text)
    // "No organizations found." → org.switcher.noOrganizationsFound (identical text)
    // "Create" → org.switcher.create (identical text)

    // -- OverviewLaneTable: per-project lane table (AQU-538 §3.3) --
    // "Actions" sr-only header → org.overviewLaneTable.actionsColumn (identical text)
    // "Staff {label}" sr-only trigger text → org.staffLanePopover.staffLaneHeading (identical text)
    "org.overviewLaneTable.sectionDescription":
      "Progress, people, and actions for each target language on this project.",

    // -- ProjectOverview: per-project overview page (most already i18n'd) --
    "org.projectOverview.chapterAbbrevLabel": "Ch {chapter}",
    // "Project settings" aria-label → editor.navTitle.projectSettings (identical text)
    "org.projectOverview.archiveDialogTitle": "Archive project",
    "org.projectOverview.filterProgressByLanguageAriaLabel": "Filter progress by language",

    // -- TeamDetail: single team's page. Most call-site strings here reuse
    // existing org.teamDetail.* / org.teamForm.* / common.* keys already
    // defined above (they were pre-seeded for this exact file); only
    // genuinely new strings follow. --
    // "Change role" dialog titles + menu items → org.membersPage.changeRoleAria (identical text)
    "org.teamDetail.changeRoleTitleFor": "Change role for {name}",
    "org.teamDetail.projectRoleDialogDescription":
      "Team members inherit this role on the project through the team grant.",
    "org.teamDetail.teamSettingsAriaLabel": "Team settings",
    "org.teamDetail.sectionsAriaLabel": "Team sections",
    "org.teamDetail.projectsTabDescription":
      "Projects this team can access, and the role granted to members.",
    "org.teamDetail.addedColumn": "Added",
    "org.teamDetail.attachProjectDialogTitle": "Attach project to '{name}'",
    "org.teamDetail.attachProjectDialogDescription": "Grant this team access at a chosen role.",
    "org.teamDetail.selectProjectPlaceholder": "Select a project…",
    "org.teamDetail.allProjectsAttachedNotice": "All org projects are already attached to this team.",
    // "Attach" confirm button → editor.media.attach (identical text)
    "org.teamDetail.noProjectsMatchSearch": "No projects match this search.",
    "org.teamDetail.membersTabDescription":
      "People on this team inherit its project grants at their org role.",
    "org.teamDetail.selectMembersPlaceholder": "Select members…",
    "org.teamDetail.removeFromTeamButton": "Remove from team",
    // "No members match this search." → org.membersPage.orgTable.noSearchMatch (identical text)

    // -- TeamsList: org's list of teams. Most call-site strings here reuse
    // existing org.teamsList.* / org.teamForm.* / common.* / editor.navTitle.* /
    // nav.* keys already defined above; only one genuinely new string. --
    "org.teamsList.noTeamsMatchSearch": "No teams match your search.",
  },
  context: {
    _context: {
      description:
        "Organizations, teams, members and invitations — the permanent chrome above a project: the org switcher, breadcrumb trail, member and team management, invite flows and permission surfaces. Most of these strings sit in a narrow header or sidebar that is on screen on every route, so they compete for horizontal space with the project's own content.",
    },
    keys: {
      "org.overview.showMoreProjects": {
        description:
          "Last-row control on the single-organization Overview's project table that expands the ten-project preview to reveal the remaining projects inline. Count is how many rows are still hidden, not the org total.",
        placeholders: { count: "Number of projects not currently shown." },
      },
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
      "org.switcher.retryOrganizationsAriaLabel": {
        description:
          "Accessible name for the button shown in place of the org switcher when loading the caller's member organizations failed.",
      },
      "org.switcher.retrySharedOrganizationsAriaLabel": {
        description:
          "Accessible name for the retry control shown when loading the project directory that backs shared/guest organizations failed. Used both when it replaces the whole switcher (no member orgs) and on the inline retry row inside the open dropdown (member orgs still shown).",
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
          "Project count shown under an organization's name in the all-orgs org list (e.g. '3 " +
          "projects'), also reused on a TeamsList team card paired with org.teamsList.memberCount.",
        placeholders: {
          count: "How many projects are being counted; also selects the plural form.",
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
          "Accessible name for the project status filter control (All / Stalled / Overdue / Needs attention) on OrgHome.",
      },
      "org.orgProjectsPage.updatedFilter.lastDays": {
        description:
          "Option label for one of the fixed recency windows in the Updated submenu of the org Projects page's combined Sort by menu.",
        placeholders: {
          days: "Length of the recency window in days — one of the fixed buckets 7, 30 or 90.",
        },
      },
      "org.orgHome.originFilter.aria": {
        description:
          "Accessible name for the All / Shared / Org tabs that filter the all-orgs projects table by whether a project comes from an organization the caller belongs to or was shared with them. The Org tab is omitted when the caller has no organization memberships.",
      },
      "org.orgHome.projectsPanel.sortProjectsAria": {
        description: "Accessible name for the 'Sort by' project-lens select control on OrgHome.",
      },
      "org.orgHome.projectsPanel.sortAria": {
        description: "Accessible name for the wrapper around the 'Sort by' label and project-lens select on OrgHome.",
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
          "Heading fallback on the guest-org projects page when the org's name hasn't loaded yet but its id is known.",
        placeholders: { id: "Numeric id of the guest organization." },
      },
      "org.guestOrgHome.description": {
        description:
          "Subheading on the guest-org projects page explaining the caller's guest access: they can see this org's shared projects but aren't a member of the organization itself.",
        placeholders: { orgName: "Display name of the guest organization — not translated." },
      },
      "org.guestOrgHome.emptyTitle": {
        description: "Empty-state title on the guest-org projects page when no projects in the guest org are shared with the caller.",
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
      "org.teamsList.noTeamsMatchQuery": {
        description: "Empty-state title on TeamsList when a search query matches no team by name.",
        placeholders: { query: "The search text the user typed — rendered verbatim, not translated." },
      },
      "org.teamsList.sortByAriaLabel": {
        description: "Accessible name for the TeamsList sort-order select control.",
      },
      "org.teamsList.visibilityFilterAriaLabel": {
        description:
          "Accessible name for the All / Internal only / Public only segmented button group that filters TeamsList by visibility.",
      },
      "org.teamsList.memberCount": {
        description:
          "Member-count line on a team card in TeamsList (e.g. '3 members'), paired with " +
          "org.orgHome.organizationsPanel.projectCount's project count.",
        placeholders: { count: "How many members belong to the team; also selects the plural form." },
      },
      "org.teamDetail.deleteConfirmTitle": {
        description: "Title of the confirm-delete dialog for a team, naming the team about to be deleted.",
        placeholders: { name: "The team's name — not translated." },
      },
      "org.teamDetail.accessLevelDefinitionsAriaLabel": {
        description:
          "Accessible name for the small '?' help affordance next to the Members heading on TeamDetail, whose tooltip lists every access-level description.",
      },
      "org.teamDetail.addMembersDialogTitle": {
        description: "Title of the add-members dialog on TeamDetail, naming the team members are being added to.",
        placeholders: { name: "The team's name — not translated." },
      },
      "org.teamDetail.removeAriaLabel": {
        description:
          "Accessible name for a 'remove' control on TeamDetail — used both for a staged-member chip's × button and for a team member row's Remove action. {name} is whichever person's username is being removed.",
        placeholders: { name: "Username of the person the control removes — not translated." },
      },
      "org.teamDetail.addErrorPrefix": {
        description:
          "Prefix before the failure detail when adding one or more team members partially fails. {error} is a pre-built, comma-joined list of '<username> (<reason>)' entries.",
        placeholders: { error: "Comma-joined list of usernames with their per-person failure reason." },
      },
      "org.teamDetail.roleForAriaLabel": {
        description:
          "Accessible name for a role-picker select trigger on TeamDetail — used both for a team member's org-role picker and a team's per-project role picker. {name} names whichever person or project the picker is for.",
        placeholders: { name: "Username (member picker) or project name (project picker) — not translated." },
      },
      "org.teamDetail.orgLevelRoleAriaLabel": {
        description:
          "Accessible name for the read-only org-level role badge shown to non-owners on a team member row (owners see an editable picker instead).",
        placeholders: { role: "The member's role display name, already localized (or the 'Unknown' fallback)." },
      },
      "org.teamDetail.removeMaintainersOnlyAriaLabel": {
        description:
          "Accessible name for the disabled Remove affordance shown to a non-maintainer on a team member row, explaining in the name itself why it's inert.",
        placeholders: { username: "Username of the team member the disabled control would remove — not translated." },
      },
      "org.teamDetail.lockedOrgRoleTooltip": {
        description:
          "Tooltip on the read-only org-level role badge (non-owners), explaining what the role grants and that only an org owner can change it. {description} is one of the seven per-role description strings (org.teamDetail.roleDescription*), or the 'unknown role' fallback, both already localized.",
        placeholders: { description: "Already-localized role description sentence, or the 'unknown role' fallback." },
      },
      "org.teamDetail.projectToAttachAriaLabel": {
        description: "Accessible name for the project-picker select trigger in TeamDetail's attach-project row.",
      },
      "org.teamDetail.grantedRoleAriaLabel": {
        description: "Accessible name for the role-picker select trigger in TeamDetail's attach-project row.",
      },
      "org.teamDetail.detachAriaLabel": {
        description: "Accessible name for the Detach control on a team's project row.",
        placeholders: { name: "The project's name — not translated." },
      },
      "org.teamDetail.selectedCount": {
        description:
          "Trigger label for the multi-select org-member combobox once at least one person is staged (e.g. '2 selected'). Shown instead of org.teamDetail.searchMembersPlaceholder.",
        placeholders: { count: "How many people are currently staged; also selects the plural form." },
      },
      "org.teamDetail.membersToAddAriaLabel": {
        description: "Accessible name for the multi-select org-member combobox trigger in TeamDetail's add-member dialog.",
      },
      "org.teamDetail.searchOrgMembersAriaLabel": {
        description:
          "Accessible name for the org-member search input inside the add-member combobox popover. The visible placeholder for the same field ends in an ellipsis; this accessible name must not, per the catalog's ellipsis convention for screen readers.",
      },
      "org.teamDetail.orgMembersGroupAriaLabel": {
        description: "Accessible name for the checkbox list of available org members inside the add-member combobox popover.",
      },
      "org.memberAccessPanel.projectsWithAccessCount": {
        description:
          "Summary shown next to a member's name in the effective-access panel, counting projects with an explicit (direct/team/creator) grant beyond their org role.",
        placeholders: { count: "How many projects the member has explicit access to; also selects the plural form." },
      },
      "org.memberAccessPanel.orgRoleNoProjectAccessNote": {
        description:
          "Trailing clause after 'Org role: Contributor' (or Viewer / Project lead) on the member access panel (AQU-1107). Explains that this org membership does not open projects; the next sentence tells the owner to add the person to a project or team.",
      },
      "org.memberAccessPanel.teamGrantLabel": {
        description:
          "Label prefix on a per-project access badge, naming the team whose grant contributes to the resolved role. Followed by the role name (e.g. 'team Translators: Contributor').",
        placeholders: { name: "The team's name — not translated." },
      },
      "org.memberAccessPanel.viaTeamLabel": {
        description:
          "One entry in the comma-joined 'Also via …' note listing non-direct grant paths for a project, naming a contributing team.",
        placeholders: { name: "The team's name — not translated." },
      },
      "org.memberAccessPanel.alsoViaNote": {
        description:
          "Note below a project's access badges listing every non-direct grant path (team/org/creator) that still applies after a direct grant is revoked.",
        placeholders: { paths: "Comma-joined, already-localized list of contributing grant paths (e.g. 'team \"Translators\", org role')." },
      },
      "org.memberActivityPanel.heading": {
        description: "Panel heading naming which member's activity is being shown.",
        placeholders: { username: "The member's username — not translated." },
      },
      "org.memberActivityPanel.closeAriaLabel": {
        description: "Accessible name for the × button that closes the member activity panel.",
      },
      "org.memberActivityPanel.loadErrorFor": {
        description: "Error message shown when a member's activity fails to load.",
        placeholders: { username: "The member's username — not translated." },
      },
      "org.projectOverview.moreActionsAria": {
        description:
          "Accessible name for the icon-only overflow (⋯) button in the project header that opens the archive/download/lifecycle menu.",
      },
      "org.projectOverview.customizeStatsAria": {
        description:
          "Accessible name for the small 'Customize' control above the Progress card's stat tiles, which opens a menu to show/hide individual stat widgets.",
      },
      "org.projectOverview.filterFilesAria": {
        description:
          "Accessible name for the text input that filters the per-file breakdown list by file name. The visible placeholder for the same field ends in an ellipsis; this accessible name must not.",
      },
      "org.projectOverview.sortFilesByAria": {
        description: "Accessible name for the dropdown that chooses the sort order of the per-file breakdown list.",
      },
      "org.projectOverview.filesListAria": {
        description:
          "Accessible name for the list element wrapping the per-file breakdown rows, distinguishing it from other lists on the page for screen-reader navigation.",
      },
      "org.projectOverview.sectionBreakdownAria": {
        description:
          "Accessible name for the list of a file's flat section rows, shown when a file's row is expanded and its structure isn't chapter-shaped.",
      },
      "org.projectOverview.chapterBreakdownAria": {
        description:
          "Accessible name for the list of a file's book/chapter rollup rows, shown when a file's row is expanded.",
      },
      "org.projectOverview.filesHeadingTruncated": {
        description:
          "Heading over the per-file breakdown list when more files exist than the display cap, e.g. 'Files (top 12 of 16)'.",
        placeholders: {
          cap: "The maximum number of file rows shown before truncation.",
          total: "The total number of files matching the current filter.",
        },
      },
      "org.projectOverview.filesHeadingCount": {
        description:
          "Heading over the per-file breakdown list when every matching file is shown, e.g. 'Files (16)'.",
        placeholders: { count: "The number of files matching the current filter." },
      },
      "org.projectOverview.noFilesMatch": {
        description:
          "Empty state shown below the file filter/sort controls when the typed filter query matches no files.",
        placeholders: { query: "The text the user typed into the file-name filter box, echoed back verbatim." },
      },
      "org.projectOverview.expandFileAria": {
        description:
          "Accessible name for the chevron button that expands a file row to show its chapter/verse progress rollup.",
        placeholders: { fileName: "The file's display name — not translated." },
      },
      "org.projectOverview.collapseFileAria": {
        description:
          "Accessible name for the same chevron button as org.projectOverview.expandFileAria, once the row is already expanded.",
        placeholders: { fileName: "The file's display name — not translated." },
      },
      "org.projectOverview.fileStatsAria": {
        description:
          "Accessible name for a file row's compact numeric summary (filled/approved/total/words), which otherwise renders as bare tabular numbers with only a tooltip explaining them.",
        placeholders: {
          filled: "Number of cells filled in this file.",
          approved: "Number of cells approved in this file.",
          total: "Total number of cells in this file.",
          words: "Total word count in this file.",
        },
      },
      "org.projectOverview.moreFilesShowAll": {
        description: "Link below the per-file breakdown list that reveals the files hidden past the display cap.",
        placeholders: { count: "The number of additional files not currently shown." },
      },
      "org.projectOverview.openAssignmentsStat": {
        description:
          "Compact stat beside a teammate's progress bar in the Team card: how many assignments are still open, and what percent of their assigned cells are done.",
        placeholders: {
          count: "The teammate's number of open (incomplete) assignments.",
          percent:
            "The teammate's completion percentage, already formatted with a '%' sign and bidi-isolated for RTL locales.",
        },
      },
      "org.projectOverview.viewActivityAria": {
        description:
          "Accessible name for the small button on a Team-card row that expands a teammate's recent-activity detail panel.",
        placeholders: { username: "The teammate's username — not translated." },
      },
      "org.projectOverview.versesAria": {
        description:
          "Accessible name for the grid of verse cells shown when a chapter row is expanded in a file's chapter/verse rollup.",
        placeholders: { chapter: "The chapter's reference label, e.g. 'GEN 1' — not translated." },
      },
      "org.projectOverview.chaptersAria": {
        description:
          "Accessible name for the list of chapter rows shown when a book row is expanded in a file's chapter/verse rollup.",
        placeholders: { book: "The book's short code, e.g. 'GEN' — not translated." },
      },
      "org.projectOverview.audioRecordedSummary": {
        description:
          "One-line summary below the audio progress bar in the Progress card, naming the total recorded time and what share of cells have audio.",
        placeholders: {
          minutes: "Total recorded minutes, as a plain localized number.",
          percent:
            "Percentage of cells with audio, already formatted with a '%' sign and bidi-isolated for RTL locales.",
        },
      },
      "org.projectLifecycle.toggleInProgressError": {
        description:
          "Error shown if a freeze/reactivate click lands while the previous toggle for " +
          "the same project is still in flight — a fast-double-click guard, not a normal " +
          "outcome.",
      },
      "org.actionGate.deniedTooltip": {
        description:
          "Generic disabled-button tooltip from actionGateProps() — not currently wired " +
          "into any UI (see key comment). {minRole} is passed through by the caller as-is; " +
          "existing callers pass the canonical machine-readable role name (lowercase, " +
          "underscored, e.g. 'project_lead') rather than a translated display label, which " +
          "is a pre-existing gap in this helper, not something to fix here — do not " +
          "translate the substituted value.",
        placeholders: {
          minRole: "Minimum role name required for the gated action, passed through verbatim.",
        },
      },
      "org.role.descriptionViewer": {
        description:
          "Capability blurb under 'Viewer' in RoleSelect and similar role pickers — the " +
          "sentence explaining what this role can and can't do, distinct from the shorter " +
          "common.role.viewerDescription used elsewhere (see the ROLE_INFO doc comment in " +
          "src/lib/frontier/roles.ts). Also composed into roleHelpText()'s 'Viewer (100) " +
          "— …' tooltip form, lowercasing its own first letter there.",
      },
      "org.role.descriptionCommenter": {
        description: "Same shape as org.role.descriptionViewer, for the Commenter role.",
      },
      "org.role.descriptionReviewer": {
        description: "Same shape as org.role.descriptionViewer, for the Reviewer role.",
      },
      "org.role.descriptionContributor": {
        description: "Same shape as org.role.descriptionViewer, for the Contributor role.",
      },
      "org.role.descriptionProjectLead": {
        description: "Same shape as org.role.descriptionViewer, for the Project Lead role.",
      },
      "org.role.descriptionMaintainer": {
        description: "Same shape as org.role.descriptionViewer, for the Maintainer role.",
      },
      "org.role.descriptionOwner": {
        description: "Same shape as org.role.descriptionViewer, for the Owner role.",
      },
      "org.sync.versionConflictError": {
        description:
          "Fallback error for a settings-save 409 response whose body doesn't carry the " +
          "expected latest-state payload, so the normal 'reload the winning version' " +
          "conflict flow can't run — the reader's only recourse is a manual reload and " +
          "retry. Shared verbatim by the org-settings and project-settings save paths.",
      },
      "org.exportSettings.deliverablesGroupLabel": {
        description:
          "Heading of the settings group that holds the export-permission control on an organization's export settings page. A short plural noun for the finished files a team hands over to whoever commissioned the work — the exported documents themselves, not the act of exporting them.",
      },
      "org.exportSettings.whoCanExportLabel": {
        description:
          "Label for the dropdown that sets the lowest team role allowed to export files from any project in this organization, and also the name read aloud for that dropdown by screen readers. A question-shaped noun phrase with no question mark — it names the choice rather than asking one, so avoid turning it into a full question.",
      },
      "org.exportSettings.whoCanExportDescription": {
        description:
          "Explanatory paragraph under the export-permission dropdown on an organization's export settings page, addressed to the administrator making the choice. Two sentences: the first says what moving the minimum role down or up achieves, the second warns that two spreadsheet formats are produced entirely inside the reader's own browser and so cannot be blocked by this setting. The two abbreviations in brackets are file-format names and stay exactly as they are.",
      },
      "org.exportSettings.ownersOnlyPolicyNote": {
        description:
          "Sentence explaining that the export-permission dropdown is not editable by this reader, because changing it is reserved for owners of the organization. Shown as quiet helper text under the dropdown for anyone below that level, and shown again as an error message when a save is refused for the same reason. A complete sentence stating a rule, not an instruction to the reader.",
      },
      "org.exportSettings.roleOptionPlain": {
        description:
          "One entry in the export-permission dropdown, for the two roles that need no further explanation (contributor and project lead). Just the role's own name followed by its numeric level in brackets — the level is shown so administrators can see the ladder these roles sit on.",
        placeholders: {
          role: "The role's already-translated display name, resolved from common.role.* — do not translate it again here.",
          level:
            "The role's numeric level (100–700), a fixed permission code shared with the server. Keep it in Western digits and do not localize the numerals.",
        },
      },
      "org.exportSettings.roleOptionViewer": {
        description:
          "The lowest entry in the export-permission dropdown. Same shape as org.exportSettings.roleOptionPlain, with a note after the dash saying that choosing it lets everyone who can open the project export from it — i.e. the most permissive setting.",
        placeholders: {
          role: "The role's already-translated display name, resolved from common.role.* — do not translate it again here.",
          level:
            "The role's numeric level (100–700), a fixed permission code shared with the server. Keep it in Western digits and do not localize the numerals.",
        },
      },
      "org.exportSettings.roleOptionMaintainer": {
        description:
          "Entry in the export-permission dropdown for the level a new organization starts on. Same shape as org.exportSettings.roleOptionPlain, with a one-word note after the dash marking it as the value in force unless somebody changes it.",
        placeholders: {
          role: "The role's already-translated display name, resolved from common.role.* — do not translate it again here.",
          level:
            "The role's numeric level (100–700), a fixed permission code shared with the server. Keep it in Western digits and do not localize the numerals.",
        },
      },
      "org.exportSettings.roleOptionOwner": {
        description:
          "The highest entry in the export-permission dropdown. Same shape as org.exportSettings.roleOptionPlain, with a note after the dash saying this choice narrows exporting to the fewest people — the opposite end of the ladder from org.exportSettings.roleOptionViewer.",
        placeholders: {
          role: "The role's already-translated display name, resolved from common.role.* — do not translate it again here.",
          level:
            "The role's numeric level (100–700), a fixed permission code shared with the server. Keep it in Western digits and do not localize the numerals.",
        },
      },
      "org.orgSettings.noSessionError": {
        description:
          "Error result surfaced in place of a save-confirmation when useOrgSettings' " +
          "patch()/requestPromotion() is called with no signed-in session or no resolved " +
          "org id — a mount-order race, not a normal user action. Rare in practice; " +
          "callers that show it should also offer a retry.",
      },
      "org.exportSettings.saveFailedFallback": {
        description:
          "Error shown under the export-permission dropdown when saving the new setting failed and the server gave no explanation of its own — the setting is unchanged and the reader can simply try again. A complete sentence in the product's voice.",
      },
      "org.addLanguagePopover.triggerAriaLabel": {
        description:
          "Accessible name for the icon-only '+ Language' trigger button on an OrgHome project row that opens the add-language popover.",
      },
      "org.addLanguagePopover.inputAriaLabel": {
        description:
          "Accessible name for the language-tag text input inside the add-language popover (no visible form label, just a placeholder example).",
      },
      "org.setupChecklist.dismissAriaLabel": {
        description:
          "Accessible name for the small × button that permanently dismisses the org-setup checklist for this org.",
      },
      "org.setupChecklist.progress": {
        description:
          "Small status line under the checklist heading, counting completed onboarding steps out of the total (currently always 2).",
        placeholders: {
          done: "How many of the checklist's steps are complete.",
          total: "Total number of steps in the checklist.",
        },
      },
      "org.routeGate.missingBody": {
        description:
          "Body text of the not-found state shown for an org id the caller can't access or that doesn't exist.",
        placeholders: { orgId: "The numeric organization id from the URL — not translated." },
      },
      "org.inviteByEmail.sentToEmail": {
        description:
          "Success status line shown after minting a targeted org invite, naming the email it was sent to.",
        placeholders: { email: "The invitee's email address, exactly as entered — not translated." },
      },
      "org.externalCollaborators.revokeAriaLabel": {
        description:
          "Accessible name for the icon-only button that revokes one external collaborator's direct grant on one project.",
        placeholders: {
          username: "The collaborator's username — not translated.",
          project: "The project's display name — not translated.",
        },
      },
      "org.externalCollaborators.viaSourceLabel": {
        description:
          "Small trailing label on a grant badge for a non-revocable grant (not a direct override), explaining how access was obtained.",
        placeholders: {
          source: "Machine-readable grant source ('group' or 'creator') — not translated, shown as-is.",
        },
      },
      "org.membersPage.orgPage.pageDescriptionPrefix": {
        description:
          "First fragment of the page subheading on the org Members page, immediately followed by the organization's name (rendered in bold, not through this catalog) and then org.membersPage.orgPage.pageDescriptionSuffix. English word order ('People in <Org Name>. Org-level roles…') may not fit every language — flag for review if your language needs the name repositioned.",
      },
      "org.membersPage.orgPage.tabsAriaLabel": {
        description: "Accessible name for the Roster/Matrix tab list on the org Members page.",
      },
      "org.membersPage.orgPage.invitedByLabel": {
        description:
          "Trailing byline on a pending-invite row, naming who sent it.",
        placeholders: {
          username: "The inviter's username — not translated — or the localized org.membersPage.orgPage.unknownInviter fallback.",
        },
      },
      "org.membersPage.orgPage.expiresInDays": {
        description:
          "Expiry countdown on a pending-invite row when more than a day remains, e.g. 'expires in 3 days'.",
        placeholders: { count: "Whole number of days until the invite expires; also selects the plural form." },
      },
      "org.membersPage.orgPage.expiresInHours": {
        description:
          "Expiry countdown on a pending-invite row when less than a day but at least an hour remains.",
        placeholders: { count: "Whole number of hours until the invite expires; also selects the plural form." },
      },
      "org.membersPage.orgPage.expiresInMinutes": {
        description:
          "Expiry countdown on a pending-invite row when less than an hour remains.",
        placeholders: { count: "Whole number of minutes until the invite expires; also selects the plural form." },
      },
      "org.membersPage.orgPage.expiresRelativePrefix": {
        description:
          "Fallback expiry line on a pending-invite row, used only when the day/hour/minute countdown can't be computed. {relative} is a pre-built relative-time phrase (e.g. '3 days from now').",
        placeholders: { relative: "Pre-formatted relative-time phrase — partially localized upstream." },
      },
      "org.membersPage.orgPage.revokeInviteAriaLabel": {
        description: "Accessible name for the icon-only button that revokes one pending org invite.",
        placeholders: { project: "The invited project's display name — not translated." },
      },
      "org.membersPage.orgTable.addMethodAriaLabel": {
        description:
          "Accessible name for the tabs that choose whether the org-member dialog adds an existing Aquilla user or sends an email invitation.",
      },
      "org.membersPage.orgTable.addMemberDescription": {
        description:
          "Dialog subtitle on the org Members 'Add a member' dialog. Explains that the action adds someone to the organization (or invites by email), not that it grants project access.",
      },
      "org.membersPage.orgTable.projectAccessNote": {
        description:
          "Helper paragraph under the add-member dialog subtitle (AQU-1107). States the rule that Contributor/Project lead/Viewer org membership does not open projects, and that only Maintainer and Owner see every project. Role names stay in this sentence as English role vocabulary matching the picker — they are not placeholders.",
      },
      "org.membersPage.orgTable.changeRoleDescription": {
        description:
          "Dialog subtitle when an org owner changes a member's organization-level role. Same access rule as org.membersPage.orgTable.projectAccessNote: Maintainer/Owner see every project; Contributor and below do not until added to a project or team.",
      },
      "org.membersPage.orgTable.copyEmailAriaLabel": {
        description:
          "Accessible name for the small copy-to-clipboard icon button beside a member's " +
          "email address in the org roster table.",
        placeholders: { email: "The member's email address — not translated." },
      },
      "org.membersPage.orgTable.projectAccessAriaLabel": {
        description:
          "Accessible name for the expand/disclosure control on a member row that reveals " +
          "which projects they have access to and through which path.",
        placeholders: { username: "The member's username — not translated." },
      },
      "org.membersPage.orgTable.removeOwnersOnlyAriaLabel": {
        description:
          "Accessible name for a disabled remove-member control, explaining that only org " +
          "owners may remove members — shown to a non-owner viewing the roster.",
        placeholders: { username: "The member's username — not translated." },
      },
      "org.rowActionsAriaLabel": {
        description:
          "Accessible name for the icon-only '⋯' row-actions button in several data tables " +
          "(org roster, team roster, team's attached projects, per-lane overview) — a " +
          "shared DataTableRowActionsButton convention distinct in wording from " +
          "org.orgProjectsDataTable.moreActionsAriaLabel's 'More actions for' tables.",
        placeholders: { name: "The row's subject — a username, project name, or lane label — not translated." },
      },
      "org.projectsList.shownOfTotal": {
        description:
          "Subheading under the projects list heading when a filter or lens narrows the visible rows, showing how many of the total are currently shown.",
        placeholders: {
          visible: "Count of projects currently visible after filtering/the active lens.",
          total: "Total count of projects in scope before filtering.",
        },
      },
      "org.projectsList.lensGroupAriaLabel": {
        description:
          "Accessible name for the row of lens buttons (Recently updated / Needs attention / Overdue / Least translated) above the all-orgs projects list.",
      },
      "org.projectsList.viewLabel": {
        description:
          "Label preceding the lens picker (Recently updated / Needs attention / Overdue / Least translated) above the all-orgs projects list.",
      },
      "org.orgProjectsDataTable.actionsColumnSrOnly": {
        description:
          "Screen-reader-only column heading for the trailing '…' row-actions column in the org projects data table — no visible header text, just this announced label.",
      },
      "org.orgProjectsDataTable.moreActionsAriaLabel": {
        description:
          "Accessible name for the icon-only '…' button that opens a row's actions menu " +
          "(project row: Assign work / Add member; archived-file row: Restore) — shared by " +
          "the org projects data table and the Archived projects/files tables.",
        placeholders: { name: "The project's or file's name — not translated." },
      },
      "org.sharedProjectsPage.scopedDescription": {
        description:
          "Subheading on the shared-with-you page when arriving scoped to one guest organization (via the org switcher), naming that organization.",
        placeholders: { org: "Display name of the guest organization — not translated." },
      },
      "org.assignWork.chaptersSelectedCount": {
        description:
          "Status line above the chapter checkbox list in the Assign work panel, counting how many chapters are currently checked (zero checked means 'whole book').",
        placeholders: { count: "How many chapters are currently checked; also selects the plural form." },
      },
      "org.assignedToMe.cellsProgress": {
        description:
          "Progress caption under an assignment row's progress bar in the assignee's 'Assigned to me' inbox: cells done of total, and the percentage.",
        placeholders: {
          done: "Whole-number count of cells completed in this assignment.",
          total: "Whole-number count of cells total in this assignment's scope.",
          pct: "Whole-number completion percentage, e.g. 40.",
        },
      },
      "org.sectionVisibilityBadge.changeVisibilityAriaLabel": {
        description:
          "Accessible name for the visibility-floor badge when the caller can edit it — the badge is a popover trigger, so the name states the current floor before naming the action it opens.",
        placeholders: { label: "The current floor's already-localized display label (e.g. 'Only maintainers & owners can see this')." },
      },
      "org.workloadRollup.removeAriaLabel": {
        description:
          "Accessible name for the icon-only × button that removes one row from the org Overview's team-workload manager rollup.",
        placeholders: {
          scope: "The assignment's scope label (e.g. a book or chapter range) — not translated.",
          user: "The assignee's username, or the localized org.workloadRollup.unknownUser fallback.",
        },
      },
      "org.workloadRollup.unknownUser": {
        description:
          "Fallback shown in place of a username when a username isn't available — the org Overview team-workload rollup, the per-member usage rollup, and the project overview Team card.",
        placeholders: { id: "The user's numeric id, used only when their username is unavailable." },
      },
      "org.usageRollup.audioSecondsOnly": {
        description:
          "Per-member audio-usage figure on the org Overview's team-usage manager rollup, used when total recorded time is under a minute.",
        placeholders: { seconds: "Whole number of seconds of recorded audio." },
      },
      "org.usageRollup.audioMinutesSeconds": {
        description:
          "Per-member audio-usage figure on the org Overview's team-usage manager rollup, used when total recorded time is a minute or more with a remaining seconds part.",
        placeholders: {
          minutes: "Whole number of minutes of recorded audio.",
          seconds: "Whole number of remaining seconds of recorded audio, always non-zero here.",
        },
      },
      "org.usageRollup.audioMinutesOnly": {
        description:
          "Per-member audio-usage figure on the org Overview's team-usage manager rollup, used when total recorded time is a whole number of minutes with no remaining seconds.",
        placeholders: { minutes: "Whole number of minutes of recorded audio." },
      },
      "org.usageRollup.aiRequestCount": {
        description:
          "Per-member AI-request count on the org Overview's team-usage manager rollup, summing TTS and LLM requests (e.g. '8 AI requests').",
        placeholders: { count: "Combined TTS + LLM request count; also selects the plural form." },
      },
      "org.joinOrgPage.organizationLine": {
        description:
          "First line of the org-invite preview card on JoinOrgPage, naming the organization the invite belongs to. Rendered via RichMessage with {name} in bold.",
        placeholders: { name: "The organization's display name, or the localized org.joinOrgPage.unnamedOrgFallback — not translated." },
      },
      "org.joinOrgPage.joinedRedirect": {
        description:
          "Confirmation line shown after successfully accepting an org invite, immediately before an automatic redirect to the new organization.",
        placeholders: { org: "The organization's display name, or the localized org.joinOrgPage.fallbackOrgName fallback — not translated." },
      },
      "org.joinOrgPage.roleLine": {
        description:
          "Second line of the org-invite preview card on JoinOrgPage, naming the role the invite grants, used when no inviter and no bound email are known. Deliberately lowercase — always the start of a clause on this page, never a full sentence opener.",
        placeholders: { role: "The invite's role name, already humanized (underscores replaced with spaces) — not translated, rendered in a styled span." },
      },
      "org.joinOrgPage.roleLineEmail": {
        description:
          "Variant of org.joinOrgPage.roleLine used when the invite is bound to a specific email address but no inviter is known.",
        placeholders: {
          role: "The invite's role name, already humanized — not translated, rendered in a styled span.",
          email: "The email address the invite was sent to — not translated, rendered in a monospace span.",
        },
      },
      "org.memberAccessDrillDown.projectsAccessibleCount": {
        description:
          "Count line above a member's project list on the access-breakdown panel, stating how many projects in this org the member can access.",
        placeholders: { count: "How many projects the member can access; also selects the plural form." },
      },
      "org.memberAccessDrillDown.noAccessEmptyTitle": {
        description:
          "Empty-state title on the access-breakdown panel when the member has no access " +
          "to any project in this org at all.",
        placeholders: { username: "The member's username — not translated." },
      },
      "org.memberAccessDrillDown.pathDirect": {
        description:
          "Small pill naming one contributing grant path on a project row of the access-" +
          "breakdown panel — this one for an explicit direct project grant/override. " +
          "{role} is the already-translated role name for that path; do not re-translate.",
        placeholders: { role: "Already-translated role display name for this grant path — not translated again." },
      },
      "org.memberAccessDrillDown.pathGroup": {
        description:
          "Same shape as org.memberAccessDrillDown.pathDirect, for access via a group " +
          "attached to the project. {group} is the group's name.",
        placeholders: {
          group: "The group's name — not translated.",
          role: "Already-translated role display name for this grant path — not translated again.",
        },
      },
      "org.memberAccessDrillDown.pathOrgLevel": {
        description:
          "Same shape as org.memberAccessDrillDown.pathDirect, for access via the " +
          "member's org-wide role.",
        placeholders: { role: "Already-translated role display name for this grant path — not translated again." },
      },
      "org.memberLaneScopeEditor.editScopesAriaLabel": {
        description:
          "Accessible name for the trigger button (a truncated summary of current scopes) " +
          "that opens the freeform lane/file scope editor popover for this member on this " +
          "project.",
        placeholders: { username: "The member's username — not translated." },
      },
      "org.memberLaneScopeEditor.scopesHeading": {
        description:
          "Popover heading naming whose lane/file scopes are being edited, in the matrix's freeform scope editor.",
        placeholders: { username: "The member's username — not translated." },
      },
      "org.memberLaneScopeEditor.newLaneCodeAriaLabel": {
        description:
          "Accessible name for the text input where a new lane code is typed, in the matrix's freeform scope editor. No visible form label, only a placeholder example.",
      },
      "org.memberMultiAddRow.peopleToAddAriaLabel": {
        description:
          "Accessible name for the list of chips naming everyone currently staged to be added, in the shared multi-add row (per-project Members page and the Share modal).",
      },
      "org.membersPanel.laneCheckboxAriaLabel": {
        description:
          "Accessible name for one lane checkbox in the roster's freeform scope editor " +
          "(MembersPanel), naming which lane the box scopes access to.",
        placeholders: { lane: "The lane's display label (a language/lane code or name) — not translated." },
      },
      "org.membersMatrixCellEditor.alsoHasAccessAriaLabel": {
        description:
          "Accessible name for the small icon-only indicator on a populated matrix cell showing the member has additional, non-winning access paths beyond the one shown.",
      },
      "org.membersMatrixCellEditor.addToProjectAriaLabel": {
        description:
          "Accessible name for the empty-cell '+' button in the members × projects " +
          "matrix, which opens the add-role popover for this person on this project.",
        placeholders: { username: "The person's username — not translated." },
      },
      "org.membersMatrixCellEditor.editRoleAriaLabel": {
        description:
          "Accessible name for a populated matrix cell's button, which opens the " +
          "role-edit popover for this person's existing grant on this project.",
        placeholders: { username: "The person's username — not translated." },
      },
      "org.membersMatrixCellEditor.editPopoverTitle": {
        description:
          "Heading inside the popover opened by org.membersMatrixCellEditor." +
          "editRoleAriaLabel, above the role picker / remove action.",
        placeholders: { username: "The person's username — not translated." },
      },
      "org.membersMatrixView.howAccessResolvedAriaLabel": {
        description:
          "Accessible name for the small help-circle button beside the Member column heading on the members × projects matrix, which opens a tooltip explaining the max-wins access model.",
      },
      "org.multiProjectInviteDialog.selectProjectAriaLabel": {
        description:
          "Accessible name for one project's checkbox in the multi-project invite " +
          "dialog's project checklist.",
        placeholders: { name: "The project's name — not translated." },
      },
      "org.multiProjectInviteDialog.projectsSelectedCount": {
        description:
          "Status line under the project checklist in the multi-project invite dialog, counting how many projects are currently checked.",
        placeholders: { count: "How many projects are checked; also selects the plural form." },
      },
      "org.multiProjectInviteDialog.rolesSuffix": {
        description:
          "Trailing clause appended after org.multiProjectInviteDialog.projectsSelectedCount, only when more than one project is checked, listing the distinct roles chosen across them. Leading space is deliberate — it continues the preceding sentence rather than starting a new one.",
        placeholders: { roles: "Comma-joined list of the distinct, already-localized role names chosen across the checked projects." },
      },
      "org.removeOrgMemberDialog.title": {
        description: "Confirmation-dialog title naming who is being removed from which organization.",
        placeholders: {
          username: "The member's username — not translated.",
          orgName: "The organization's display name — not translated.",
        },
      },
      "org.removeOrgMemberDialog.warningBody": {
        description:
          "Explanatory paragraph under the remove-member dialog title, naming who is affected and what removal does and doesn't touch.",
        placeholders: { username: "The member's username — not translated." },
      },
      "org.staffLanePopover.staffLaneHeading": {
        description:
          "Heading text used both as the popover trigger's fallback content (beside a person-plus icon) and as the popover body's own heading, naming which lane is being staffed.",
        placeholders: { lane: "The target language lane's display label — not translated." },
      },
      "org.staffLanePopover.addOrgMemberDescription": {
        description:
          "Subheading under org.staffLanePopover.staffLaneHeading explaining what the popover does. Rendered via RichMessage with {member} substituted as a bold span whose text is the translated org.staffLanePopover.orgMemberPhrase — supplied as a node (not raw data) so its emphasis and word position both survive translation.",
        placeholders: { member: "The already-translated, bold-styled 'org member' phrase (org.staffLanePopover.orgMemberPhrase) — do not interpolate it as plain data." },
      },
      "org.staffLanePopover.addToLaneButton": {
        description: "Primary confirm button that grants the selected role scoped to the named lane.",
        placeholders: { lane: "The target language lane's display label — not translated." },
      },
      "org.archivedProjects.viewsAriaLabel": {
        description:
          "Accessible name for the Projects/Recently deleted tab list on the org Archived page.",
      },
      "org.projectOverview.chapterAbbrevLabel": {
        description:
          "Compact chapter-row label in the per-file chapter/verse rollup, abbreviating 'Chapter' to fit a narrow column.",
        placeholders: { chapter: "The chapter's reference label, e.g. '3' — not translated." },
        maxLength: 10,
      },
      "org.projectOverview.filterProgressByLanguageAriaLabel": {
        description:
          "Accessible name for the segmented All/per-lane tabs that filter the Progress card's stats by target language, shown only when the project has more than one lane.",
      },
      "org.memberActivityPanel.fileRollupSummary": {
        description:
          "Compact numeric summary beside a file's name in the per-member file-worked-on rollup: how many cells and words this member touched in the file, and when they last touched it. Not pluralized on purpose — English always reads 'cells'/'words' here regardless of count, matching the source's existing behavior.",
        placeholders: {
          cells: "Number of cells this member touched in the file.",
          words: "Number of words this member touched in the file.",
          timestamp: "Already locale-formatted date/time of the member's last activity in this file, or an em dash when unknown.",
        },
      },
      "org.teamDetail.changeRoleTitleFor": {
        description:
          "Change-role dialog title on TeamDetail, used for both the member org-role dialog and the project team-grant-role dialog, once a target is known. Falls back to org.membersPage.changeRoleAria ('Change role' alone) before a target is picked.",
        placeholders: { name: "The member's username, or the project's name — not translated." },
      },
      "org.teamDetail.attachProjectDialogTitle": {
        description: "Title of the attach-project dialog on TeamDetail, naming the team a project is being attached to.",
        placeholders: { name: "The team's name — not translated." },
      },
      "org.teamDetail.teamSettingsAriaLabel": {
        description:
          "Accessible name for the icon-only gear button on TeamDetail's header that links to this team's settings page.",
      },
      "org.teamDetail.sectionsAriaLabel": {
        description: "Accessible name for the Projects/Members/Overview tab list on TeamDetail.",
      },
      "org.teamDetail.addedColumn": {
        description:
          "Sortable column heading on TeamDetail's projects and members tables for when the project or person was added to the team. Also the DateTooltip hover prefix on that cell (short calendar date visible, labeled datetime on hover).",
        maxLength: 16,
      },
    },
  },
  surfaces: [],
})
