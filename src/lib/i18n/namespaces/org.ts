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

    // -- OrgDataEgress: maintainer/owner multi-project archive --
    "org.egress.title": "Data egress",
    "org.egress.description": "Everything your organization has stored — review it, filter it, and take it with you as one zip archive.",
    "org.egress.selectOrgDescription": "Data egress is managed within a single organization.",
    "org.egress.roleRequired":
      "Data egress is available to organization owners, and to other roles when an owner enables them in Settings.",
    "org.egress.exportCount": plural({ one: "Export {count} file", other: "Export {count} files" }),
    "org.egress.loading": "Loading organization files",
    "org.egress.loadFailed": "Couldn’t load files",
    "org.egress.portfolioUnavailable": "Portfolio stats are unavailable — lane, audio, and last-edit columns may be incomplete.",
    "org.egress.policyRestricted": "Export restricted by org policy",
    "org.egress.selectAll": "Select all files",
    "org.egress.selectFile": "Select {file}",
    "org.egress.column.lanes": "Lanes",
    "org.egress.column.lastEdit": "Last edit",
    "org.egress.filterPlaceholder": "Filter files…",
    "org.egress.selectedCount": "{selected} of {total} selected",
    "org.egress.options.title": "Export options",
    "org.egress.options.textMode": "Text export mode",
    "org.egress.options.text.original.label": "Original format (round-trip)",
    "org.egress.options.text.original.description": "Each file in the format it was imported as; formats without a round-trip exporter use the conversion format below.",
    "org.egress.options.text.convert.label": "Convert to…",
    "org.egress.options.text.convert.description": "Every file re-serialized to one uniform format.",
    "org.egress.options.text.none.label": "Text off",
    "org.egress.options.text.none.description": "No text entries in the export.",
    "org.egress.options.conversionFormat": "Conversion format",
    "org.egress.options.targetLanes": "Target lanes",
    "org.egress.options.lane": "Lane {lane}",
    "org.egress.options.includeSources": "Include original source documents",
    "org.egress.options.includeSourcesDescription": "The raw files you uploaded, exactly as stored.",
    "org.egress.options.audioMode": "Audio export mode",
    "org.egress.options.audio.none.description": "No audio in the export.",
    "org.egress.options.audio.separate.label": "Every clip separately",
    "org.egress.options.audio.separate.description": "One audio file per cell recording.",
    "org.egress.options.audio.file.label": "One clip per file",
    "org.egress.options.audio.file.description": "All of a file’s recordings joined in document order.",
    "org.egress.options.audio.voice.label": "One clip per voice",
    "org.egress.options.audio.voice.description": "Each voice’s recordings joined together, no gaps.",
    "org.egress.options.audio.timeline.label": "Voice timeline stems (silence while others speak)",
    "org.egress.options.audio.timeline.description": "One aligned track per voice; all tracks share the file’s timeline.",
    "org.egress.options.useCache": "Reuse cached exports for unchanged projects",
    "org.egress.options.empty": "These options would export nothing — pick a lane, an audio mode, or source documents.",
    "org.egress.options.estimate": "{fileCount} · {cellCount}",
    "org.egress.options.estimateAudio": " · ~{minutes} min recorded audio",
    "org.egress.results.preparing": "Preparing",
    "org.egress.results.preparingExport": "Preparing export…",
    "org.egress.results.exportingText": "Exporting text",
    "org.egress.results.exportingAudio": "Exporting audio",
    "org.egress.results.packaging": "Packaging",
    "org.egress.results.finishing": "Finishing",
    "org.egress.results.projectStatus": "{phase} — {project} ({current} of {total}){cached}",
    "org.egress.results.phaseStatus": "{phase}…",
    "org.egress.results.cachedSuffix": " (cached)",
    "org.egress.results.progress": "Export progress",
    "org.egress.results.failed": "Export failed: {message}",
    "org.egress.results.complete": "Export complete — your download has started.",
    "org.egress.results.cached": "cached",
    "org.egress.results.entryCount": plural({ one: "{count} entry", other: "{count} entries" }),
    "org.egress.results.skipped": "Skipped {scope}: {reason}",
    "org.egress.results.noteLine": "Note: {file}: {note}",

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
    "org.switcher.searchFailed": "Couldn’t search organizations",

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
      "Viewer (100) — can read all org projects. No edit or management actions.",
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
    "org.memberAccessPanel.orgRoleAppliesNote": "— applies to every project in this org.",
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
      "Share of every cell whose selected recording has been validated. Counted against every cell, the same way as Validated, so it agrees with the Plan below.",
    "org.projectOverview.audioValidatedOfRecorded":
      "Of the audio actually recorded, {percent}% is validated.",
    "org.projectOverview.crossLaneTooltip": "Cross-language stat — not broken down per language.",
    "org.projectOverview.cellsSuffix": "cells",
    "org.projectOverview.laneDefaultFallback": "Default",
    "org.projectOverview.legendTranslated": "translated",
    "org.projectOverview.filesHeadingTruncated": "Files (top {cap} of {total})",
    "org.projectOverview.filesHeadingCount": "Files ({count})",
    "org.projectOverview.filesListAria": "File list",
    "org.projectOverview.fileListActionsAria": "File list actions",
    "org.projectOverview.copyCsvTooltip": "Copy the file list below as CSV",
    "org.projectOverview.copyCsv": "Copy CSV",
    "org.projectOverview.copyCsvCopied": "CSV copied to clipboard",
    "org.projectOverview.downloadCsvTooltip": "Download the file list below as a .csv file",
    "org.projectOverview.downloadCsv": "Download CSV",
    "org.projectOverview.downloadOriginals": "Download all originals",
    "org.projectOverview.downloadOriginalsTooltip":
      "Download every original imported source file as a zip",
    "org.projectOverview.downloadOriginalAria": "Download original {fileName}",
    "org.projectOverview.importedOriginalsHeading": "Imported originals",
    "org.projectOverview.importedOriginalsListAria": "Imported original files",
    "org.projectOverview.importedOriginalsShowMore": plural({
      one: "Show {count} more",
      other: "Show {count} more",
    }),
    "org.projectOverview.importedOriginalsShowAll": "Show all ({count})",
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
    "org.role.descriptionViewer": "Can read all org projects. No edit or management actions.",
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

    // -- OrgSettingsSecurity › EgressAccessSection: who may use Data egress (AQU-907) --
    "org.egressSettings.whoCanEgressLabel": "Who can use Data egress",
    "org.egressSettings.whoCanEgressDescription":
      "Minimum role that can open the organization-wide Data egress page and " +
      "download everything as one archive. Owners always can; each project's " +
      "export permission still applies to what ends up in the archive.",
    "org.egressSettings.ownersOnlyPolicyNote": "Only org owners can change who can use Data egress.",
    "org.egressSettings.roleOptionViewer": "{role} ({level}) — anyone with project access",
    "org.egressSettings.roleOptionOwner": "{role} ({level}) — default",
    "org.egressSettings.saveFailedFallback": "Couldn't save the egress permission.",

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
      "This updates their organization-level role across every project.",
    "org.membersPage.orgTable.addMemberTitle": "Add a member",
    "org.membersPage.orgTable.addMemberDescription":
      "Grant an org-wide role, or invite someone by email who doesn't have an account yet.",
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
      "A role that applies to every project in this org because of the person's org-level role. Change the org membership to affect all projects at once.",
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
      "This role is granted org-wide and applies to every project. A direct project grant added here will supersede the org-wide grant for this project only (max-wins still applies — only a higher direct role changes the effective role).",
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
      "Every member's access is the highest role they hold across up to four paths: a direct project grant, any group attached to this project, their org-wide role, or creator status. Adding a lower grant never reduces access — to fully remove someone, all contributing paths must be cleared.",
    "org.membersMatrixView.soleOwnerWarning": "Sole Owner: losing this person locks the project",
    "org.membersMatrixView.orgInheritedTooltip":
      "Access on every project comes from org-wide role; no per-project overrides.",

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
    // AQU-1097: the plan rollup. Never says "books" — a unit is a book, an
    // episode or a document depending on the project.
    "org.orgProjectsDataTable.unitsColumn": "Done",
    "org.orgProjectsDataTable.unitsDoneValue": "{done} of {total}",
    "org.orgProjectsDataTable.unitsDoneAria": "{done} of {total} units marked done",
    "org.orgProjectsDataTable.unitsOverdueTooltip": plural({
      one: "{count} unit is past its target date",
      other: "{count} units are past their target date",
    }),
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
    // "Couldn't search organizations" → org.switcher.searchFailed (identical text)
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
    // ── AQU-1092…1098: the plan board ──────────────────────────────────
    // Copy is deliberately unit-agnostic. A planning unit is a Bible book in
    // one project, a dub episode in another, a document in a third — so
    // nothing here may say "books".
    "org.projectOverview.plan.heading": "Plan",
    "org.projectOverview.plan.regionAria": "Planning units, grouped by status",
    "org.projectOverview.plan.summaryDoneLabel": "of {total} done",
    "org.projectOverview.plan.summaryOverdueLabel": plural({ one: "overdue", other: "overdue" }),
    "org.projectOverview.plan.summaryInProgressLabel": plural({ one: "in progress", other: "in progress" }),
    // AQU-1278. Its own pill rather than a share of "in progress", because
    // this is the one bucket a manager can empty this week. Both plural forms
    // are identical for the same reason as its two siblings above: the count
    // is drawn as a bold numeral beside the phrase, never inside it.
    "org.projectOverview.plan.summaryNearlyCompleteLabel": plural({ one: "nearly complete", other: "nearly complete" }),
    "org.projectOverview.plan.emptyTitle": "Nothing to plan yet",
    "org.projectOverview.plan.loading": "Loading the plan\u2026",
    "org.projectOverview.plan.saveFailed": "That change could not be saved, so it has been undone. Try again.",
    "org.projectOverview.plan.errorTitle": "The plan could not be loaded",
    "org.projectOverview.plan.error": "Something went wrong reading this project's plan. Nothing has been lost \u2014 try again.",
    "org.projectOverview.plan.importSource": "Import source",
    "org.projectOverview.plan.empty":
      "Import a source and its books, episodes or documents appear here as rows you can give target dates and mark done.",
    "org.projectOverview.plan.keyboardHint": "Arrow keys move between units \u00b7 Esc closes",
    "org.projectOverview.plan.cellCount": plural({ one: "{count} cell", other: "{count} cells" }),
    "org.projectOverview.plan.textBarsAria": "Text {translated}% translated, {validated}% validated",
    "org.projectOverview.plan.audioBarsAria": "Audio {recorded}% recorded, {validated}% validated",
    "org.projectOverview.plan.statusDone": "Done",
    "org.projectOverview.plan.statusOverdue": "Overdue",
    "org.projectOverview.plan.statusSoon": "Due soon",
    // AQU-1278. Fifteen characters, one over the ceiling the other statuses
    // carried. Sam's call was to keep the word and lift the ceiling to 16 for
    // the whole family rather than shorten this one — the six labels sit in
    // the same pill and are read against each other, so a translator sizing
    // one of them is sizing all six.
    "org.projectOverview.plan.statusNearlyComplete": "Nearly complete",
    "org.projectOverview.plan.statusInProgress": "In progress",
    "org.projectOverview.plan.statusNotStarted": "Not started",
    "org.projectOverview.plan.groupHintOverdue": "past target, not marked done",
    "org.projectOverview.plan.groupHintSoon": "target within a week",
    // The two numbers ARE the rule — `planNearlyCompleteThreshold` in
    // plan-status.ts is max(6% of the cells, 7). Nothing links the sentence to
    // the function, so a change to one is a change to both; the hint exists
    // because a group nobody can predict the membership of reads as a bug.
    "org.projectOverview.plan.groupHintNearlyComplete": "within 6% or 7 cells of done",
    "org.projectOverview.plan.groupHintInProgress": "active, comfortably ahead",
    "org.projectOverview.plan.groupHintNotStarted": "no content yet",
    "org.projectOverview.plan.groupHintDone": "marked complete by a manager",
    // The inspector docked beside the board.
    "org.projectOverview.plan.inspectorAria": "Details for {unit}",
    "org.projectOverview.plan.previousUnit": "Previous unit",
    "org.projectOverview.plan.nextUnit": "Next unit",
    "org.projectOverview.plan.openFile": "Open in the editor",
    "org.projectOverview.plan.targetDate": "Target date",
    "org.projectOverview.plan.noTarget": "No target",
    "org.projectOverview.plan.noTargetSet": "No target date set",
    "org.projectOverview.plan.targetMaintainerOnly": "Only maintainers can set target dates.",
    "org.projectOverview.plan.completion": "Completion",
    "org.projectOverview.plan.markDone": "Mark done",
    "org.projectOverview.plan.markDoneHint": "Undoable.",
    "org.projectOverview.plan.markDoneAnyway": "Mark done anyway",
    "org.projectOverview.plan.unmarkDone": "Un-mark",
    "org.projectOverview.plan.notMarkedDone": "Not marked done.",
    "org.projectOverview.plan.aMaintainer": "a maintainer",
    "org.projectOverview.plan.markedDoneBy": "Marked done {date} by {user}",
    "org.projectOverview.plan.doneBelowFullNudge":
      "Validated is at {validated}%. Marking done records your judgment, not the numbers \u2014 the bars stay visible beside the mark.",
    "org.projectOverview.plan.progress": "Progress",
    "org.projectOverview.plan.lastActivity": "Last activity {when}.",
    "org.projectOverview.plan.noActivity": "No activity yet.",
    "org.projectOverview.plan.resizeInspector": "Resize the details panel",
    "org.projectOverview.plan.textBarLabel": "TXT",
    "org.projectOverview.plan.audioBarLabel": "AUD",
    "org.projectOverview.plan.noTargetShort": "\u2014",
    "org.projectOverview.plan.daysLate": plural({ one: "{count} day late", other: "{count} days late" }),
    "org.projectOverview.plan.markedOn": "marked {date}",
    "org.projectOverview.plan.daysUntil": plural({ one: "in {count} day", other: "in {count} days" }),
    "org.projectOverview.plan.noTargetDate": "no target date",
    // ── AQU-1278: the shortfall line ───────────────────────────────────
    // What a unit still needs, on the row's second line and beside the
    // inspector's status pill. `planShortfallParts` picks at most two terms,
    // worst medium first, so these keys are always read as fragments and never
    // as a sentence. One key per medium because the count governs the noun,
    // and the join is a key of its own so a language that separates clauses
    // with a different mark — or with no spaces around it — can say so
    // instead of inheriting an English middot.
    "org.projectOverview.plan.shortfallTranslate": plural({ one: "{count} cell to translate", other: "{count} cells to translate" }),
    "org.projectOverview.plan.shortfallValidate": plural({ one: "{count} cell to validate", other: "{count} cells to validate" }),
    "org.projectOverview.plan.shortfallRecord": plural({ one: "{count} take to record", other: "{count} takes to record" }),
    // Never rendered today, and deliberately kept: `AUDIO_JUDGED_ON_RECORDED`
    // suppresses the audio-validate term because no client emits
    // `cell.audio.validate` yet (AQU-490 is the missing half), so the count is
    // zero on every project alive. The words exist so the flip is a constant,
    // not a copy round.
    "org.projectOverview.plan.shortfallAudioValidate": plural({ one: "{count} take to validate", other: "{count} takes to validate" }),
    // AQU-1278: the SHORT forms, used when two terms share one line. In full
    // they read "6 cells to translate \u00b7 8 cells to validate", which wraps in
    // the narrowest column on the board and takes the row's height with it \u2014
    // and the second noun is the same word as the first, so the line spends
    // its width saying "cells" twice. The noun survives in the single-term
    // case, where there is room and no context to borrow from.
    "org.projectOverview.plan.shortfallTranslateBrief": plural({ one: "{count} to translate", other: "{count} to translate" }),
    "org.projectOverview.plan.shortfallValidateBrief": plural({ one: "{count} to validate", other: "{count} to validate" }),
    "org.projectOverview.plan.shortfallRecordBrief": plural({ one: "{count} to record", other: "{count} to record" }),
    // Keeps its noun where the other brief forms drop theirs: with both nouns
    // gone, "6 to validate · 8 to validate" would name one thing twice. Sam's
    // word for this is "validated", never "sign off" (2026-09-17).
    "org.projectOverview.plan.shortfallAudioValidateBrief": plural({ one: "{count} take to validate", other: "{count} takes to validate" }),
    "org.projectOverview.plan.shortfallPair": "{first} \u00b7 {second}",
    // A unit with nothing outstanding that nobody has marked done: it stays in
    // Overdue where its blown date belongs, and this line is how the row
    // admits the work itself is finished. Without it that row looks identical
    // to one with three hundred cells to go.
    "org.projectOverview.plan.nothingLeft": "Nothing left",
    // AQU-1278: the second line under that one, on a unit with NO target date.
    // It used to read "no target date", which is true and useless — the reader
    // is looking at a finished book and wants to know why it is not in Done.
    "org.projectOverview.plan.nothingLeftUndone": "not marked done",
    // AQU-1278: prefixes a row's second line when the unit's assignments have
    // been read and there are none. Only ever shown for a unit whose
    // assignments ARE known, so it says "nobody", never "nobody yet loaded".
    "org.projectOverview.plan.unassignedRow": "unassigned",
    // Where the outstanding cells actually are. The plural agrees with how
    // many chapters are in the list, which the caller passes alongside — it is
    // not in the string, the same arrangement the summary pills use.
    "org.projectOverview.plan.shortfallWhere": plural({ one: "chapter {list}", other: "chapters {list}" }),
    "org.projectOverview.plan.shortfallWhereMore": plural({ one: "{list} and {count} more", other: "{list} and {count} more" }),
    // The links out of the plan and into the editor, landing on the first cell
    // that is actually missing something. Two keys rather than one with a
    // {kind} placeholder: an inflecting language cannot build "first
    // untranslated" from a noun it is handed at runtime.
    "org.projectOverview.plan.goToFirstUntranslated": "Go to first untranslated",
    "org.projectOverview.plan.goToFirstUnvalidated": "Go to first unvalidated",
    "org.projectOverview.plan.goToFirstUnrecorded": "Go to first unrecorded",
    "org.projectOverview.plan.goToFirstUnsigned": "Go to first unvalidated take",
    // AQU-1278, round 7: what a bar's two percentages stand for, on hover.
    "org.projectOverview.plan.readoutTranslated": "{done} of {total} translated",
    "org.projectOverview.plan.readoutValidated": "{done} of {total} validated",
    "org.projectOverview.plan.readoutRecorded": "{done} of {total} recorded",
    "org.projectOverview.plan.readoutAudioValidated": "{done} of {total} validated",
    // AQU-1096: the list controls. Neutral throughout — the orphaned
    // filterFiles* keys say "files", which this surface never does.
    "org.projectOverview.plan.filterPlaceholder": "Filter by name\u2026",
    "org.projectOverview.plan.filterAria": "Filter the plan by name",
    "org.projectOverview.plan.clearFilter": "Clear the plan filter",
    "org.projectOverview.plan.noMatchTitle": "Nothing matches",
    "org.projectOverview.plan.noMatch": "No unit matches the filters you have set. Clear them to see the whole plan again.",
    "org.projectOverview.plan.showingCount": "Showing {shown} of {total}.",
    "org.projectOverview.plan.viewStatus": "By status",
    "org.projectOverview.plan.viewOrder": "In order",
    "org.projectOverview.plan.needsDate": "Needs a date",
    "org.projectOverview.plan.needsDateTooltip": "Show only the units nobody has given a target date yet.",
    // AQU-1278: fold every group to its header, and back. One button, two labels.
    "org.projectOverview.plan.collapseAll": "Collapse all",
    "org.projectOverview.plan.expandAll": "Expand all",
    "org.projectOverview.plan.collapseAllTooltip": "Fold every group to its header and count.",
    "org.projectOverview.plan.expandAllTooltip": "Open every group.",
    // AQU-1278: the in-order arrangement's folders.
    "org.projectOverview.plan.folderAll": "All files",
    "org.projectOverview.plan.folderTallyOverdue": plural({ one: "{count} overdue", other: "{count} overdue" }),
    "org.projectOverview.plan.folderTallySoon": plural({ one: "{count} due soon", other: "{count} due soon" }),
    "org.projectOverview.plan.folderTallyNearlyComplete": plural({ one: "{count} nearly complete", other: "{count} nearly complete" }),
    "org.projectOverview.plan.folderTallyInProgress": plural({ one: "{count} in progress", other: "{count} in progress" }),
    "org.projectOverview.plan.folderTallyNotStarted": plural({ one: "{count} not started", other: "{count} not started" }),
    "org.projectOverview.plan.folderTallyDone": plural({ one: "{count} done", other: "{count} done" }),
    // AQU-1278: the heading is just the noun. "Progress by chapter" described
    // the old stack of per-chapter bars; the grid beneath it now says how it
    // measures, and the legend sits on this very line saying what the colours
    // mean, so the words only have to name what is below them.
    "org.projectOverview.plan.chapters": "Chapters",
    "org.projectOverview.plan.sections": "Sections",
    "org.projectOverview.plan.chapterCount": plural({ one: "{count} chapter", other: "{count} chapters" }),
    "org.projectOverview.plan.sectionCount": plural({ one: "{count} section", other: "{count} sections" }),
    // ── AQU-1278: the chapter grid ─────────────────────────────────────
    // One tile per chapter under the inspector's heading, coloured by what
    // that chapter is short of. The two summary lines above it answer the
    // question the grid poses at a glance — how much of this is left — for a
    // reader who is counting tiles instead of reading them.
    "org.projectOverview.plan.chaptersShort": plural({ one: "{count} chapter short", other: "{count} chapters short" }),
    "org.projectOverview.plan.chaptersComplete": "{done} of {total} complete",
    // "all complete", not the bare "complete" this legend would otherwise
    // read: the catalog already spends that string on autopilot.status.complete
    // and on the Living Memory brief's status, and the second of those holds a
    // reviewed entry in duplicate-exceptions.ts. A third key case-folding onto
    // the same value turns that group into a HARD failure of
    // no-duplicates.test.ts — an excused group may leave only one other key
    // colliding — and a swatch label does not earn a fourth exception. The
    // sense is unchanged: nothing outstanding in either medium.
    "org.projectOverview.plan.gridLegendComplete": "all complete",
    "org.projectOverview.plan.gridLegendTextShort": "text short",
    "org.projectOverview.plan.gridLegendAudioShort": "audio short",
    // A media file's sections are time ranges, not chapters, so the grid has
    // nothing to draw. It says why rather than rendering an empty frame, which
    // reads as a load that failed.
    // AQU-1278: the chapter card under the grid, opened by clicking a tile.
    // The title names the chapter the way the reader just clicked it; the line
    // beside it says what is outstanding in the medium that leads.
    "org.projectOverview.plan.chapterTitle": "Chapter {chapter}",
    "org.projectOverview.plan.chapterCellsUntranslated": plural({ one: "{count} cell not yet translated", other: "{count} cells not yet translated" }),
    "org.projectOverview.plan.chapterCellsUnvalidated": plural({ one: "{count} cell not yet validated", other: "{count} cells not yet validated" }),
    "org.projectOverview.plan.chapterTakesUnrecorded": plural({ one: "{count} take not yet recorded", other: "{count} takes not yet recorded" }),
    // The overflow chip at the end of the verse row, when the outstanding
    // verses outnumber the chips one row can hold.
    // …and its sibling for a document, which has no sections at all.
    // AQU-1278: the tile beneath the chapter grid for a book's USFM front
    // matter — cells with no chapter number, filed before chapter 1.
    "org.projectOverview.plan.frontMatter": "front matter",
    "org.projectOverview.plan.tileAria": "Chapter {chapter}: {short} cells short",
    "org.projectOverview.plan.tileAriaSection": "{section}: {short} cells short",
    // Audio hangs off the file, not off a target language, so every lane reads
    // the same recordings — a manager comparing two lanes' audio bars and
    // finding them identical is seeing the truth, not a stuck filter.
    "org.projectOverview.plan.audioSharedAcrossLanes": "audio is shared by every language",
    // ── AQU-1278: per-assignment progress ──────────────────────────────
    // Who owns which slice of a unit, and how far along their slice is.
    "org.projectOverview.plan.assignedTo": "Assigned to",
    "org.projectOverview.plan.assign": "Assign",
    "org.projectOverview.plan.assignmentScope": "{scope} \u00b7 {count} cells",
    "org.projectOverview.plan.assignmentDue": "due {date}",
    "org.projectOverview.plan.assignmentNoDeadline": "no deadline",
    // AQU-1278: the tail of a person's shortfall line — "2 to validate · ch. 12".
    // Abbreviated because it follows a count on a line three hundred pixels wide.
    "org.projectOverview.plan.shortfallInChapters": "ch. {list}",
    "org.projectOverview.plan.unassignedChapters": plural({ one: "{count} chapter is not assigned", other: "{count} chapters are not assigned" }),
    "org.projectOverview.plan.everyChapterAssigned": "Every chapter is assigned.",
    "org.projectOverview.plan.moreAssignees": "{count} more",

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
      "org.egress.exportCount": {
        description: "Primary action on Data egress, showing how many selected files will be exported.",
        placeholders: { count: "Number of selected files; also selects the plural form." },
      },
      "org.egress.selectFile": {
        description: "Accessible name for one file-row selection checkbox.",
        placeholders: { file: "File name — not translated." },
      },
      "org.egress.selectedCount": {
        description: "Selection summary above the organization file inventory.",
        placeholders: {
          selected: "Number of selected files.",
          total: "Total number of files in the organization inventory.",
        },
      },
      "org.egress.options.lane": {
        description: "Accessible name for one target-lane checkbox in export options.",
        placeholders: { lane: "Target lane display label — not translated." },
      },
      "org.egress.options.estimate": {
        description: "Compact file-and-cell estimate at the bottom of Data egress options.",
        placeholders: {
          fileCount: "Already-localized file count, such as '2 files'.",
          cellCount: "Already-localized cell count, such as '40 cells'.",
        },
      },
      "org.egress.options.estimateAudio": {
        description: "Optional audio-duration suffix appended to the Data egress estimate.",
        placeholders: { minutes: "Rounded number of recorded-audio minutes." },
      },
      "org.egress.results.projectStatus": {
        description: "Live export progress line for one project in a multi-project organization export.",
        placeholders: {
          phase: "Localized current export phase.",
          project: "Project name — not translated.",
          current: "One-based current project number.",
          total: "Total number of projects being exported.",
          cached: "Localized cached suffix, or an empty string.",
        },
      },
      "org.egress.results.phaseStatus": {
        description: "Live organization-level packaging status after all individual projects finish.",
        placeholders: { phase: "Localized current export phase." },
      },
      "org.egress.results.failed": {
        description: "Terminal Data egress error message.",
        placeholders: { message: "Verbatim technical failure reason." },
      },
      "org.egress.results.entryCount": {
        description: "Number of archive entries produced for one project.",
        placeholders: { count: "Number of produced archive entries; also selects the plural form." },
      },
      "org.egress.results.skipped": {
        description: "Transparency line naming one skipped export scope and its reason.",
        placeholders: {
          scope: "File, lane, source, or audio scope identifier — not translated.",
          reason: "Verbatim skip reason from the export engine or server.",
        },
      },
      "org.egress.results.noteLine": {
        description:
          "Transparency line under a project's export results carrying one file's caveat — e.g. that a source document is not the byte-exact original upload. Only the leading word is translatable copy.",
        placeholders: {
          file: "File name — not translated.",
          note: "Verbatim caveat from the export engine.",
        },
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
      "org.switcher.searchFailed": {
        description:
          "Empty-state copy in the org switcher when a server-side organization search failed. Distinct from the member-list load failure, which replaces the whole switcher with a retry affordance.",
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
      "org.projectOverview.fileListActionsAria": {
        description:
          "Accessible name for the icon-only overflow (⋯) button beside the file-list filter/sort controls. Distinct from org.projectOverview.moreActionsAria, which names the project-header overflow.",
      },
      "org.projectOverview.copyCsvCopied": {
        description:
          "Success toast shown after Copy CSV writes the filtered file list to the clipboard. The menu item itself stays labeled Copy CSV.",
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
      "org.projectOverview.downloadOriginalAria": {
        description:
          "Accessible name for the icon-only button on a project-overview imported-originals row that downloads the exact original imported file.",
        placeholders: { fileName: "The file's display name — not translated." },
      },
      "org.projectOverview.downloadOriginals": {
        description:
          "Button on the project-overview imported-originals card that downloads every stored original as a zip. Distinct from Download CSV, which is the plan progress table.",
      },
      "org.projectOverview.downloadOriginalsTooltip": {
        description:
          "Tooltip on Download all originals explaining that the zip contains the raw imported source files, not a translation-injected export.",
      },
      "org.projectOverview.importedOriginalsHeading": {
        description:
          "Heading of the project-overview card that lists imported source files a PM can download as originals. Distinct from the Plan board, which is progress, not assets.",
      },
      "org.projectOverview.importedOriginalsListAria": {
        description:
          "Accessible name for the list of imported original files on the project overview, distinguishing it from the plan and team lists.",
      },
      "org.projectOverview.importedOriginalsShowMore": {
        description:
          "Text button under the imported-originals list on the project overview, which starts capped at five rows. Reveals the next batch of rows; count is the batch size, not how many are still hidden. Sits beside org.projectOverview.importedOriginalsShowAll and is hidden once fewer than a full batch remains.",
        placeholders: { count: "Number of additional rows the next batch reveals (always five)." },
      },
      "org.projectOverview.importedOriginalsShowAll": {
        description:
          "Text button under the capped imported-originals list on the project overview that reveals every remaining row at once. Count is the total number of files that have a stored original, not how many are still hidden. Replaced by org.projectOverview.showFewer once everything is visible.",
        placeholders: { count: "Total number of imported original files in the list." },
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
      "org.egressSettings.whoCanEgressLabel": {
        description:
          "Label for the dropdown that sets the lowest organization role allowed to open the Data egress page (the organization-wide bulk download), and also the name read aloud for that dropdown by screen readers. A question-shaped noun phrase with no question mark — it names the choice rather than asking one. 'Data egress' is the page's own title (org.egress.title) and must match it.",
      },
      "org.egressSettings.whoCanEgressDescription": {
        description:
          "Explanatory paragraph under the Data-egress permission dropdown, addressed to the administrator making the choice. Two statements: owners always have access regardless of the chosen floor, and each project's separate export permission still filters what the archive can contain.",
      },
      "org.egressSettings.ownersOnlyPolicyNote": {
        description:
          "Sentence explaining that the Data-egress permission dropdown is not editable by this reader, because changing it is reserved for owners of the organization. Shown as quiet helper text under the dropdown and again as an error when a save is refused for the same reason. A complete sentence stating a rule, not an instruction to the reader.",
      },
      "org.egressSettings.roleOptionViewer": {
        description:
          "The lowest entry in the Data-egress permission dropdown. Same shape as org.exportSettings.roleOptionPlain, with a note after the dash saying that choosing it lets everyone with project access use Data egress — the most permissive setting.",
        placeholders: {
          role: "The role's already-translated display name, resolved from common.role.* — do not translate it again here.",
          level:
            "The role's numeric level (100–700), a fixed permission code shared with the server. Keep it in Western digits and do not localize the numerals.",
        },
      },
      "org.egressSettings.roleOptionOwner": {
        description:
          "The highest entry in the Data-egress permission dropdown. Same shape as org.exportSettings.roleOptionPlain, with a one-word note after the dash marking it as the value in force unless somebody changes it — for this setting the owner level is the default, unlike the export dropdown where maintainer is.",
        placeholders: {
          role: "The role's already-translated display name, resolved from common.role.* — do not translate it again here.",
          level:
            "The role's numeric level (100–700), a fixed permission code shared with the server. Keep it in Western digits and do not localize the numerals.",
        },
      },
      "org.egressSettings.saveFailedFallback": {
        description:
          "Error shown under the Data-egress permission dropdown when saving the new setting failed and the server gave no explanation of its own — the setting is unchanged and the reader can simply try again. A complete sentence in the product's voice.",
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
      "org.orgProjectsDataTable.unitsColumn": {
        description:
          "Column header on the org projects table: how many of a project's planning " +
          "units a manager has marked finished. Deliberately neutral — a unit is a Bible " +
          "book, a dub episode or a document depending on the project, so this must never " +
          "say 'Books'.",
        maxLength: 12,
      },
      "org.orgProjectsDataTable.unitsDoneValue": {
        description: "Cell value for the Done column, e.g. '5 of 66'.",
        placeholders: { done: "Units marked done — a number.", total: "Units in the project — a number." },
      },
      "org.orgProjectsDataTable.unitsDoneAria": {
        description: "Screen-reader label for the Done column cell.",
        placeholders: { done: "Units marked done — a number.", total: "Units in the project — a number." },
      },
      "org.orgProjectsDataTable.unitsOverdueTooltip": {
        description:
          "Tooltip on the red badge beside the Done count: how many units are past their " +
          "target date without a Done mark.",
        placeholders: { count: "Overdue units — a number." },
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
      "org.projectOverview.audioValidatedOfRecorded": {
        description:
          "Second sentence of the Audio Validated tooltip, appended after org.projectOverview.audioValidatedTooltip. Gives the other ratio a reviewer usually wants: validated audio measured against the audio that exists rather than against every cell. A separate sentence, and a separate key, so it can be ordered independently.",
        placeholders: {
          percent: "Validated audio as a percentage of the audio actually recorded \u2014 a whole number, no % sign.",
        },
      },
      "org.projectOverview.plan.heading": {
        description: "Heading of the project dashboard's plan table. Neutral on purpose: rows are Bible books, dub episodes or documents depending on the project, so this must never say 'Books'.",
        maxLength: 16,
      },
      "org.projectOverview.plan.regionAria": {
        description: "Screen-reader name for the plan list region, which arrow keys navigate.",
      },
      "org.projectOverview.plan.summaryDoneLabel": {
        description:
          "Summary pill above the plan table. The count of finished units is rendered as a bold numeral IMMEDIATELY BEFORE this text, so the phrase continues from it: \"2\" + \"of 66 done\".",
        placeholders: { total: "Units in the project — a number." },
      },
      "org.projectOverview.plan.summaryOverdueLabel": {
        description:
          "Summary pill. The count is rendered as a bold numeral immediately before this text: \"1\" + \"overdue\". The plural form is selected by that count even though it does not appear in the string.",
      },
      "org.projectOverview.plan.summaryInProgressLabel": {
        description:
          "Summary pill. The count is rendered as a bold numeral immediately before this text: \"28\" + \"in progress\". Counts units that are started or due soon but not finished.",
      },
      "org.projectOverview.plan.summaryNearlyCompleteLabel": {
        description:
          "Summary pill. The count is rendered as a bold numeral immediately before this text: \"9\" + \"nearly complete\". The plural form is selected by that count even though it does not appear in the string. Counts only the units a few cells from finished, which are NOT also counted as in progress.",
      },
      "org.projectOverview.plan.emptyTitle": {
        description: "Heading of the empty state, when a project has no plannable files yet.",
      },
      "org.projectOverview.plan.errorTitle": {
        description:
          "Heading shown when the plan read fails. Deliberately distinct from the empty state, which would tell a manager their project has no work in it.",
      },
      "org.projectOverview.plan.importSource": {
        description:
          "Button in the plan's empty state. Opens the editor, which is where importing a source happens.",
      },
      "org.projectOverview.plan.empty": {
        description: "Shown when a project has no plannable files yet.",
      },
      "org.projectOverview.plan.keyboardHint": {
        description: "Hint shown while a unit is selected, describing keyboard navigation.",
      },
      "org.projectOverview.plan.cellCount": {
        description: "Secondary line under a unit's name: how many cells it contains.",
        placeholders: { count: "Cells in the unit — a number." },
      },
      "org.projectOverview.plan.textBarsAria": {
        description: "Screen-reader label for the two stacked text-progress bars on a plan row.",
        placeholders: { translated: "Percent translated — a number.", validated: "Percent validated — a number." },
      },
      "org.projectOverview.plan.audioBarsAria": {
        description: "Screen-reader label for the two stacked audio-progress bars on a plan row.",
        placeholders: { recorded: "Percent recorded — a number.", validated: "Percent validated — a number." },
      },
      // The six status labels share ONE ceiling, raised 14 → 16 by AQU-1278 to
      // fit "Nearly complete" without shortening it (Sam's call). They are read
      // against each other in the same pill, so sizing them apart would only
      // move the truncation to whichever label a translator wrote longest.
      "org.projectOverview.plan.statusDone": {
        description: "Status of a unit a manager has explicitly marked finished. Can read Done even when its bars are below 100%.",
        maxLength: 16,
      },
      "org.projectOverview.plan.statusOverdue": {
        description: "Status of a unit past its target date with no Done mark.",
        maxLength: 16,
      },
      "org.projectOverview.plan.statusSoon": {
        description: "Status of a unit whose target date is within a week.",
        maxLength: 16,
      },
      "org.projectOverview.plan.statusNearlyComplete": {
        description:
          "Status of a started unit whose worse medium is within a few cells of finished — six percent of its cells, or seven cells, whichever is larger. Sits between Due soon and In progress on the board: a blown date still outranks 'almost there'.",
        maxLength: 16,
      },
      "org.projectOverview.plan.statusInProgress": {
        description: "Status of a unit with content that is comfortably ahead of its target.",
        maxLength: 16,
      },
      "org.projectOverview.plan.statusNotStarted": {
        description: "Status of a unit with no translated text and no recorded audio yet.",
        maxLength: 16,
      },
      "org.projectOverview.plan.groupHintOverdue": {
        description: "Right-aligned hint on the Overdue group header, explaining what puts a unit there.",
      },
      "org.projectOverview.plan.groupHintSoon": {
        description: "Hint on the Due soon group header.",
      },
      "org.projectOverview.plan.groupHintNearlyComplete": {
        description:
          "Hint on the Nearly complete group header, stating the rule that puts a unit there: its worse medium is short by at most six percent of its cells, or seven cells, whichever is larger. The two numbers are the rule itself, not an illustration — keep them exact.",
      },
      "org.projectOverview.plan.groupHintInProgress": {
        description: "Hint on the In progress group header.",
      },
      "org.projectOverview.plan.groupHintNotStarted": {
        description: "Hint on the Not started group header.",
      },
      "org.projectOverview.plan.groupHintDone": {
        description: "Hint on the Done group header, stressing that the mark is a human judgment.",
      },
      "org.projectOverview.plan.inspectorAria": {
        description: "Screen-reader name for the detail panel docked beside the plan.",
        placeholders: { unit: "The unit's name — a book name, episode or document title. Not translated." },
      },
      "org.projectOverview.plan.previousUnit": {
        description: "Tooltip on the up arrow that steps to the previous unit.",
        maxLength: 20,
      },
      "org.projectOverview.plan.nextUnit": {
        description: "Tooltip on the down arrow that steps to the next unit.",
        maxLength: 20,
      },
      "org.projectOverview.plan.openFile": {
        description: "Tooltip on the detail panel's title and on a chapter card's title; each opens what it names in the editor.",
        maxLength: 30,
      },
      "org.projectOverview.plan.targetDate": {
        description: "Label for the date a manager plans this unit to be finished by.",
        maxLength: 18,
      },
      "org.projectOverview.plan.noTarget": {
        description: "Placeholder in the target-date picker when none is set.",
        maxLength: 16,
      },
      "org.projectOverview.plan.noTargetSet": {
        description: "Shown instead of a date picker to someone who cannot set dates.",
        maxLength: 28,
      },
      "org.projectOverview.plan.targetMaintainerOnly": {
        description: "Explains to a non-maintainer why no date control is offered.",
      },
      "org.projectOverview.plan.completion": {
        description: "Section label above the Mark done control.",
        maxLength: 16,
      },
      "org.projectOverview.plan.markDone": {
        description: "Button marking a unit finished. An explicit human judgment, not derived from percentages.",
        maxLength: 14,
      },
      "org.projectOverview.plan.markDoneHint": {
        description: "Reassurance beside Mark done that the action can be reversed.",
        maxLength: 14,
      },
      "org.projectOverview.plan.markDoneAnyway": {
        description: "Confirms marking a unit done although its validated percentage is below 100.",
        maxLength: 22,
      },
      "org.projectOverview.plan.unmarkDone": {
        description: "Button reversing a Done mark.",
        maxLength: 14,
      },
      "org.projectOverview.plan.notMarkedDone": {
        description: "Shown to a non-maintainer when a unit has no Done mark.",
        maxLength: 24,
      },
      "org.projectOverview.plan.aMaintainer": {
        description: "Fallback for who marked a unit done when the username is unknown.",
        maxLength: 18,
      },
      "org.projectOverview.plan.markedDoneBy": {
        description: "Provenance line: when a unit was marked done and by whom.",
        placeholders: { date: "ISO date, e.g. 2026-09-02.", user: "Username — not translated." },
      },
      "org.projectOverview.plan.doneBelowFullNudge": {
        description: "Shown when marking a unit done whose validated share is under 100%. Informative, not blocking — the mark is a judgment the numbers cannot make.",
        placeholders: { validated: "Percent validated — a number." },
      },
      "org.projectOverview.plan.progress": {
        description: "Section label above the four progress bars.",
        maxLength: 16,
      },
      "org.projectOverview.plan.lastActivity": {
        description: "When this unit was last edited.",
        placeholders: { when: "How long ago the unit was last edited \u2014 already-formatted relative time." },
      },
      "org.projectOverview.plan.resizeInspector": {
        description:
          "Accessible name for the drag handle on the left edge of the docked details panel.",
      },
      "org.projectOverview.plan.noActivity": {
        description: "Shown when a unit has never been edited.",
        maxLength: 24,
      },
      "org.projectOverview.plan.textBarLabel": {
        description:
          "Three-letter label beside a plan row's text-progress bars. Abbreviated because it " +
          "repeats on every row; keep it very short.",
        maxLength: 4,
      },
      "org.projectOverview.plan.audioBarLabel": {
        description:
          "Three-letter label beside a plan row's audio-progress bars. Abbreviated because it " +
          "repeats on every row; keep it very short.",
        maxLength: 4,
      },
      "org.projectOverview.plan.noTargetShort": {
        description:
          "Placeholder in a plan row's date column when the unit has no target date. An em " +
          "dash; translate only if the language uses a different absent-value mark.",
        maxLength: 3,
      },
      "org.projectOverview.plan.daysLate": {
        description:
          "Under an overdue unit's target date: how far past it the unit is, counted from the " +
          "end of the target day everywhere on Earth.",
        placeholders: { count: "Whole days late — a number." },
      },
      "org.projectOverview.plan.markedOn": {
        description: "Under a finished unit's date: when a manager marked it done.",
        placeholders: { date: "A short calendar date, already formatted." },
      },
      "org.projectOverview.plan.daysUntil": {
        description: "Note beside a Due soon unit: how long until its target date.",
        placeholders: { count: "Days remaining — a number." },
      },
      "org.projectOverview.plan.noTargetDate": {
        description: "Note beside a started unit that nobody has given a target date.",
      },
      "org.projectOverview.plan.shortfallTranslate": {
        description:
          "One term of the shortfall line — the plan row's second line, and the line beside the inspector's status pill. Says how many cells in this unit still have no target text. Read as a fragment, never as a sentence: at most two terms appear, joined by org.projectOverview.plan.shortfallPair.",
        placeholders: { count: "Cells with no target text yet — a number; it also selects the plural form." },
      },
      "org.projectOverview.plan.shortfallValidate": {
        description:
          "One term of the shortfall line (see shortfallTranslate): how many cells have target text that nobody has validated yet. Always listed after the translate term, because a cell nobody has written cannot be validated.",
        placeholders: { count: "Translated cells still awaiting validation — a number; it also selects the plural form." },
      },
      "org.projectOverview.plan.shortfallRecord": {
        description:
          "One term of the shortfall line (see shortfallTranslate), for a file that carries recordings: how many cells have no take recorded against them. A 'take' is one recorded clip for one cell.",
        placeholders: { count: "Cells with no recording yet — a number; it also selects the plural form." },
      },
      "org.projectOverview.plan.shortfallAudioValidate": {
        description:
          "One term of the shortfall line (see shortfallTranslate): recorded takes nobody has validated yet. Not rendered anywhere today — audio is judged on what has been recorded until the recording-review UI exists (AQU-490), so this count is zero on every project. Translate it anyway; it appears the day that lands.",
        placeholders: { count: "Recorded takes still awaiting validation — a number; it also selects the plural form." },
      },
      "org.projectOverview.plan.shortfallTranslateBrief": {
        description:
          "The short form of shortfallTranslate, used when TWO shortfall terms share one line on a plan row — \"6 to translate · 8 to validate\". The noun is dropped because the full pair wraps in the narrowest column on the board, and because both terms count the same thing, so saying it twice buys nothing. Keep it as short as the language allows.",
        placeholders: { count: "Cells with no target text yet — a number; it also selects the plural form." },
      },
      "org.projectOverview.plan.shortfallValidateBrief": {
        description:
          "The short form of shortfallValidate (see shortfallTranslateBrief): translated cells nobody has validated yet, worded for a line that already carries another term.",
        placeholders: { count: "Translated cells still awaiting validation — a number; it also selects the plural form." },
      },
      "org.projectOverview.plan.shortfallRecordBrief": {
        description:
          "The short form of shortfallRecord (see shortfallTranslateBrief): cells with no take recorded against them, worded for a line that already carries another term.",
        placeholders: { count: "Cells with no recording yet — a number; it also selects the plural form." },
      },
      "org.projectOverview.plan.shortfallAudioValidateBrief": {
        description:
          "The short form of shortfallAudioValidate (see shortfallTranslateBrief): recorded takes nobody has validated yet. Unlike the other brief forms it KEEPS its noun, because beside shortfallValidateBrief with both nouns dropped it would read as the same thing said twice. Not rendered today — audio is judged on what has been recorded until AQU-490 ships.",
        placeholders: { count: "Recorded takes still awaiting validation — a number; it also selects the plural form." },
      },
      "org.projectOverview.plan.shortfallPair": {
        description:
          "Joins the two terms of a shortfall line — \"6 cells to translate · 34 cells to validate\". A key of its own so a language that separates clauses with a different mark, or without spaces around it, can say so. Do not reorder the two: the first is deliberately the worse of the pair.",
        placeholders: {
          first: "The worse shortfall term, already translated and formatted — e.g. '6 cells to translate'.",
          second: "The second shortfall term, already translated and formatted.",
        },
      },
      "org.projectOverview.plan.nothingLeft": {
        description:
          "Replaces the shortfall line on a unit with no outstanding work in it. Such a unit can still sit under Overdue — a blown target date outranks a finished one — and this is how its row admits the work itself is done.",
      },
      "org.projectOverview.plan.nothingLeftUndone": {
        description:
          "Second line of a plan row whose first line reads 'Nothing left' and which has no target date: every cell is done but no manager has marked the unit complete. A lower-case fragment sitting under the line above, not a sentence.",
        maxLength: 20,
      },
      "org.projectOverview.plan.unassignedRow": {
        description:
          "Prefixes a plan row's second line when nobody holds an assignment covering that unit — \"unassigned · 3 hours ago\". A lower-case fragment before a separator, never a standalone label.",
        maxLength: 14,
      },
      "org.projectOverview.plan.shortfallWhere": {
        description:
          "Tail of the inspector's shortfall line, naming which chapters the outstanding cells are in: \"chapters 3, 4 and 9\". The number of chapters in the list selects the plural form and is passed alongside; like the summary pills, it never appears in the string itself.",
        placeholders: { list: "The chapter numbers, already joined into one list by the caller — e.g. '3, 4 and 9'. Not translated." },
      },
      "org.projectOverview.plan.shortfallWhereMore": {
        description:
          "Replaces the bare chapter list on a plan row when the outstanding work is spread over more chapters than the row has room to name. The first few are named and the rest are counted, because a row that listed forty numbers would push everything else off the line.",
        placeholders: {
          list: "The first few chapter numbers, already joined for this locale.",
          count: "How many further chapters are short — a number. The plural form is selected by it.",
        },
      },
      "org.projectOverview.plan.goToFirstUntranslated": {
        description:
          "Link in the inspector that opens the editor on this unit, scrolled to the first cell with no target text. Separate from its unvalidated sibling rather than built from a shared phrase, because 'first untranslated' inflects as a whole in most languages.",
      },
      "org.projectOverview.plan.goToFirstUnvalidated": {
        description:
          "Link in the inspector that opens the editor on this unit, scrolled to the first translated cell nobody has validated. Offered where the outstanding work is validation rather than translation.",
      },
      "org.projectOverview.plan.goToFirstUnrecorded": {
        description:
          "Link in the inspector and on a board row that opens the editor on this unit, scrolled to the first cell with no recorded take. Offered once the unit's text is finished and the outstanding work is recording. On a dubbing project it lands on the subtitle cell whose linked cue has no take.",
      },
      "org.projectOverview.plan.goToFirstUnsigned": {
        description:
          "Link that opens the editor at the first recorded take nobody has validated (selected and approved). 'Take' is what keeps it apart from goToFirstUnvalidated, which is about text. Not offered today — audio is judged on what has been recorded until AQU-490 ships.",
      },
      "org.projectOverview.plan.readoutTranslated": {
        description:
          "Hover tip, and accessible name, of the first percentage beside a text bar on the plan board and in its inspector: what that percentage stands for, as cells. \"1,530 of 1,533 translated\". Both numbers arrive already formatted for the reader's locale.",
        placeholders: { done: "Cells with target text, formatted — e.g. '1,530'.", total: "The unit's cells, formatted — e.g. '1,533'." },
      },
      "org.projectOverview.plan.readoutValidated": {
        description:
          "Hover tip, and accessible name, of the second percentage beside a text bar: how many cells are validated, out of the unit's cells. See readoutTranslated.",
        placeholders: { done: "Validated cells, formatted.", total: "The unit's cells, formatted." },
      },
      "org.projectOverview.plan.readoutRecorded": {
        description:
          "Hover tip, and accessible name, of the first percentage beside an audio bar: cells with a recorded take, out of the bar's own total — which on a dubbing project is the cue sheet's count, not the file's. See readoutTranslated.",
        placeholders: { done: "Cells with a take, formatted.", total: "Cells the audio is measured against, formatted." },
      },
      "org.projectOverview.plan.readoutAudioValidated": {
        description:
          "Hover tip, and accessible name, of the second percentage beside an audio bar: takes that have been validated, out of the bar's own total. Same English as readoutValidated on purpose — Sam's word for audio validation is 'validated' (2026-09-17); a language that distinguishes the two may.",
        placeholders: { done: "Validated takes, formatted.", total: "Cells the audio is measured against, formatted." },
      },
      "org.projectOverview.plan.filterPlaceholder": {
        description:
          "Placeholder in the plan's filter box. Ends in an ellipsis; the matching aria-label does not. Matches a unit's displayed name and its book code.",
        maxLength: 24,
      },
      "org.projectOverview.plan.filterAria": {
        description:
          "Accessible name for the plan's filter box. Says what typing here does; unlike the visible placeholder it must NOT end in an ellipsis.",
      },
      "org.projectOverview.plan.showingCount": {
        description:
          "Footer line under a filtered plan, saying how much of it is on screen. The summary pills above always count the WHOLE project, so this is the only place the filtered figure appears.",
        placeholders: {
          shown: "Units passing the filter \u2014 a number.",
          total: "Units in the project \u2014 a number.",
        },
      },
      "org.projectOverview.plan.viewStatus": {
        description:
          "Button that arranges the plan grouped by status (the default). Paired with 'In order'.",
        maxLength: 14,
      },
      "org.projectOverview.plan.viewOrder": {
        description:
          "Button that arranges the plan as one flat list in canonical order \u2014 Bible book order, or file order. Paired with 'By status'.",
        maxLength: 14,
      },
      "org.projectOverview.plan.needsDate": {
        description:
          "Toggle that narrows the plan to units with no target date and no Done mark \u2014 a planner's to-do list.",
        maxLength: 16,
      },
      "org.projectOverview.plan.collapseAll": {
        description:
          "Button in the plan board's toolbar, after the By status / In order toggle, that folds every status group down to its header and count in one click. Shown while at least one group is open; its twin expandAll takes over once all are folded. Disabled in the In order arrangement, which has no groups.",
        maxLength: 16,
      },
      "org.projectOverview.plan.expandAll": {
        description:
          "The same button as collapseAll once every group on the board is folded: one click opens them all. Keep it the same length as collapseAll so the toolbar does not shift between the two.",
        maxLength: 16,
      },
      "org.projectOverview.plan.collapseAllTooltip": {
        description: "Hover text of the collapseAll button. A short sentence saying what one click does.",
      },
      "org.projectOverview.plan.expandAllTooltip": {
        description: "Hover text of the expandAll button. A short sentence saying what one click does.",
      },
      "org.projectOverview.plan.folderAll": {
        description:
          "Header of the single group the plan board's in-order arrangement draws when a project keeps none of its files in folders — every row sits under it, so it can be folded like any folder. Beside the count of rows.",
        maxLength: 16,
      },
      "org.projectOverview.plan.folderTallyOverdue": {
        description:
          "One term of a folder header's tally on the plan board's in-order arrangement: how many rows inside the folder are overdue. Terms are joined with shortfallPair — \"3 done · 1 nearly complete\" — and only the non-zero ones appear. Same vocabulary as the group headings, lower case.",
        placeholders: { count: "Rows in the folder with this status — a number; it also selects the plural form." },
      },
      "org.projectOverview.plan.folderTallySoon": {
        description:
          "One term of a folder header's tally on the plan board's in-order arrangement: how many rows inside the folder are due soon. Terms are joined with shortfallPair — \"3 done · 1 nearly complete\" — and only the non-zero ones appear. Same vocabulary as the group headings, lower case.",
        placeholders: { count: "Rows in the folder with this status — a number; it also selects the plural form." },
      },
      "org.projectOverview.plan.folderTallyNearlyComplete": {
        description:
          "One term of a folder header's tally on the plan board's in-order arrangement: how many rows inside the folder are nearly complete. Terms are joined with shortfallPair — \"3 done · 1 nearly complete\" — and only the non-zero ones appear. Same vocabulary as the group headings, lower case.",
        placeholders: { count: "Rows in the folder with this status — a number; it also selects the plural form." },
      },
      "org.projectOverview.plan.folderTallyInProgress": {
        description:
          "One term of a folder header's tally on the plan board's in-order arrangement: how many rows inside the folder are in progress. Terms are joined with shortfallPair — \"3 done · 1 nearly complete\" — and only the non-zero ones appear. Same vocabulary as the group headings, lower case.",
        placeholders: { count: "Rows in the folder with this status — a number; it also selects the plural form." },
      },
      "org.projectOverview.plan.folderTallyNotStarted": {
        description:
          "One term of a folder header's tally on the plan board's in-order arrangement: how many rows inside the folder are not started. Terms are joined with shortfallPair — \"3 done · 1 nearly complete\" — and only the non-zero ones appear. Same vocabulary as the group headings, lower case.",
        placeholders: { count: "Rows in the folder with this status — a number; it also selects the plural form." },
      },
      "org.projectOverview.plan.folderTallyDone": {
        description:
          "One term of a folder header's tally on the plan board's in-order arrangement: how many rows inside the folder are done. Terms are joined with shortfallPair — \"3 done · 1 nearly complete\" — and only the non-zero ones appear. Same vocabulary as the group headings, lower case.",
        placeholders: { count: "Rows in the folder with this status — a number; it also selects the plural form." },
      },
      "org.projectOverview.plan.chapters": {
        description: "Inspector heading over the grid of chapter tiles for a Bible book. A plural noun naming what is below it, not a sentence — the colour legend shares this line and the grid says how it measures.",
        maxLength: 16,
      },
      "org.projectOverview.plan.sections": {
        description: "Inspector heading over the grid of section tiles for a non-Scripture unit — an episode's scenes, a document's headings. The counterpart of the chapters heading; see it.",
        maxLength: 16,
      },
      "org.projectOverview.plan.chapterCount": {
        description: "Part of the inspector subtitle, e.g. \"1,007 cells \u00b7 21 chapters \u00b7 Tok Pisin\".",
        placeholders: { count: "Chapters in the unit — a number." },
      },
      "org.projectOverview.plan.sectionCount": {
        description: "Part of the inspector subtitle for a non-Scripture unit.",
        placeholders: { count: "Sections in the unit — a number." },
      },
      "org.projectOverview.plan.chaptersShort": {
        description:
          "Summary line above the inspector's chapter grid: how many of this unit's chapters still have outstanding cells in them. Counts chapters, not cells — the cell figure is the shortfall line above.",
        placeholders: { count: "Chapters with outstanding cells — a number; it also selects the plural form." },
      },
      "org.projectOverview.plan.chaptersComplete": {
        description:
          "Second summary line above the inspector's chapter grid, counting the chapters with nothing outstanding left in them against the unit's total.",
        placeholders: {
          done: "Chapters with nothing outstanding — a number.",
          total: "Chapters in the unit — a number.",
        },
      },
      "org.projectOverview.plan.gridLegendComplete": {
        description:
          "Legend label under the chapter grid, beside the swatch for a chapter with nothing outstanding in either medium. Read as one of three fragments in a row — 'all complete · text short · audio short' — so keep it a phrase, not a sentence.",
      },
      "org.projectOverview.plan.gridLegendTextShort": {
        description:
          "Legend label under the chapter grid, beside the swatch for a chapter still missing translated or validated text. Read as one of three fragments in a row.",
      },
      "org.projectOverview.plan.gridLegendAudioShort": {
        description:
          "Legend label under the chapter grid, beside the swatch for a chapter whose text is done but whose recordings are not. Read as one of three fragments in a row.",
      },
      "org.projectOverview.plan.chapterTitle": {
        description:
          "Heading of the chapter card that opens under the inspector's grid when a reader clicks a tile. A section with no chapter number of its own — a document's \"Scene 4\" — uses its own name instead and never reaches this string.",
        placeholders: { chapter: "The chapter number — a number, not translated." },
        maxLength: 18,
      },
      "org.projectOverview.plan.chapterCellsUntranslated": {
        description:
          "Beside the chapter card's heading: how many cells in this chapter still have no target text. Shown when translation is the outstanding work; its two siblings cover validation and recording. Reads as a fact about the chapter, not as an instruction.",
        placeholders: { count: "Cells with no target text — a number; it also selects the plural form." },
      },
      "org.projectOverview.plan.chapterCellsUnvalidated": {
        description:
          "Beside the chapter card's heading (see chapterCellsUntranslated): how many translated cells nobody has validated yet.",
        placeholders: { count: "Translated cells awaiting validation — a number; it also selects the plural form." },
      },
      "org.projectOverview.plan.chapterTakesUnrecorded": {
        description:
          "Beside the chapter card's heading (see chapterCellsUntranslated), for a file that carries recordings: how many cells have no take against them. A 'take' is one recorded clip for one cell.",
        placeholders: { count: "Cells with no recording — a number; it also selects the plural form." },
      },
      "org.projectOverview.plan.frontMatter": {
        description:
          "Label on the tile beneath the inspector's chapter grid for a Bible book's USFM front matter — a book title, running headers, an introduction: cells that belong to the book but to no chapter. Lower case, because it sits in a row of small tiles among chapter numbers.",
        maxLength: 14,
      },
      "org.projectOverview.plan.tileAria": {
        description:
          "Accessible name of one chapter tile in the inspector's grid. A sighted reader gets the colour and the number; a screen-reader user gets this instead, so it must carry both facts on its own.",
        placeholders: {
          chapter: "The chapter number — a number, not translated.",
          short: "Outstanding cells in that chapter — a number.",
        },
      },
      "org.projectOverview.plan.tileAriaSection": {
        description:
          "Accessible name of a tile that is NOT a numbered chapter — USFM front matter, a one-chapter book, or a document's own section name. Those cannot sit on the numbered grid and must not be announced as \"Chapter Scene 4\", so they name themselves instead.",
        placeholders: {
          section: "The section's own key, e.g. a book code or a scene name. Not translated.",
          short: "Outstanding cells in that section — a number.",
        },
      },
      "org.projectOverview.plan.audioSharedAcrossLanes": {
        description:
          "Note beside the inspector's audio bars: recordings hang off the file rather than off one target language, so every lane reads the same audio figures. Lower case because it is read as a parenthetical beside the bars, not as a sentence of its own.",
      },
      "org.projectOverview.plan.assignedTo": {
        description:
          "Label above the inspector's list of the people given part of this unit to work on.",
      },
      "org.projectOverview.plan.assign": {
        description:
          "Button beside an unassigned slice of a unit that opens the assignee picker — the imperative verb. dialog.assign.submit is the confirm button inside that dialog and reads the same in English by coincidence; a language that splits 'open the picker' from 'commit the choice' needs both.",
      },
      "org.projectOverview.plan.assignmentScope": {
        description:
          "One row of the inspector's assignment list: what a person has been given and how big it is — \"Chapters 3–9 · 412 cells\". Not count-governed: the English noun stays plural whatever the number is. A locale whose noun must agree with {count} needs this key changed to a plural one, not worked around in translation.",
        placeholders: {
          scope: "The assigned slice, already formatted by the caller — e.g. 'Chapters 3–9' or a file name. Not translated.",
          count: "Cells in that slice — a number.",
        },
      },
      "org.projectOverview.plan.assignmentDue": {
        description:
          "Tail of an assignment row, saying when that person's slice is due. Lower case: it follows the scope on the same line. org.orgHome.dueDate is the capitalised, standalone version on a project row.",
        placeholders: { date: "A short calendar date, already formatted." },
      },
      "org.projectOverview.plan.assignmentNoDeadline": {
        description:
          "Fills the same slot as the due date on an assignment nobody has dated, so the row keeps its shape. Lower case for the same reason.",
      },
      "org.projectOverview.plan.shortfallInChapters": {
        description:
          "Tail of one person's line in the inspector's Assigned to section, naming which chapters their outstanding work is in — \"2 to validate \u00b7 ch. 12\". Abbreviate 'chapter' the way a reader of this language would in a list: the panel is narrow and the count in front of it has already been shortened for the same reason.",
        placeholders: {
          list: "The chapter numbers, already joined into one list by the caller — e.g. '12 and 40'. Not translated.",
        },
        maxLength: 12,
      },
      "org.projectOverview.plan.unassignedChapters": {
        description:
          "Warning under the inspector's assignment list: chapters of this unit nobody has been made responsible for. The count is what makes it actionable, so it stays in the sentence.",
        placeholders: { count: "Chapters with no assignee — a number; it also selects the plural form." },
      },
      "org.projectOverview.plan.everyChapterAssigned": {
        description:
          "The reassuring counterpart of the unassigned-chapters warning, shown when nothing in the unit is left over. A full sentence, because it is the end of the story rather than a label.",
      },
      "org.projectOverview.plan.moreAssignees": {
        description:
          "Overflow chip closing a truncated row of assignee avatars: how many people the row could not fit.",
        placeholders: { count: "Assignees not shown — a number." },
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
