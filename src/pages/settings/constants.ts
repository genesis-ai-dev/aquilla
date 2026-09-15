import { ROLE } from "@/lib/frontier/roles"

/** Short role labels for floor hints and compact Security-page selects. */
export const FLOOR_LABEL: Record<number, string> = {
  [ROLE.VIEWER]: "Viewer",
  // AQU-1002: the comment floors are the first selects to offer these two
  // rungs; without a short label their closed trigger fell through to the long
  // option sentence.
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
    "Who can see members and who can export, assign, manage terms, and change project languages.",
  billing:
    "Explore / Field / Enterprise agent credits for this organization.",
  providers:
    "Org-level keys act as a baseline for everyone in this organization. Projects or individuals can override with their own.",
  monday:
    "Connect this organization's Monday.com account. Projects can then link a board and push progress automatically.",
}
