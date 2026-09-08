import { ROLE } from "@/lib/frontier/roles"

/** Short role labels for floor hints and compact Security-page selects.
 *
 *  AQU-1068 added commenter and reviewer: the project-settings cell-editing
 *  floor is the first floor control offered the full ladder, and a rung with
 *  no entry here falls back to its dropdown-row sentence, which is too long
 *  for a closed trigger. */
export const FLOOR_LABEL: Record<number, string> = {
  [ROLE.VIEWER]: "Viewer",
  [ROLE.COMMENTER]: "Commenter",
  [ROLE.REVIEWER]: "Reviewer",
  [ROLE.CONTRIBUTOR]: "Contributor",
  [ROLE.PROJECT_LEAD]: "Project lead",
  [ROLE.MAINTAINER]: "Maintainer",
  [ROLE.OWNER]: "Owner",
}

export const ORG_SETTINGS_SECTIONS = [
  "identity",
  "security",
  "billing",
  "providers",
  "monday",
] as const
export type OrgSettingsSection = (typeof ORG_SETTINGS_SECTIONS)[number]

/** Retired per-floor pages that now live on /settings/security. */
export const ORG_SETTINGS_SECTION_ALIASES: Record<string, OrgSettingsSection> = {
  export: "security",
  roster: "security",
  assignment: "security",
  terminology: "security",
}

export const ORG_SETTINGS_SECTION_TITLES: Record<OrgSettingsSection, string> = {
  identity: "Identity",
  security: "Security",
  billing: "Billing & usage",
  providers: "AI provider keys",
  monday: "Monday.com",
}

export const ORG_SETTINGS_SECTION_DESCRIPTIONS: Record<OrgSettingsSection, string> = {
  identity: "The organization's display name, shown across the workspace.",
  security:
    "Who can see members and who can export, assign, and manage terms.",
  billing:
    "Explore / Field / Enterprise agent credits for this organization.",
  providers:
    "Org-level keys act as a baseline for everyone in this organization. Projects or individuals can override with their own.",
  monday:
    "Connect this organization's Monday.com account. Projects can then link a board and push progress automatically.",
}
