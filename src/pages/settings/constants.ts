import { ROLE } from "@/lib/frontier/roles"

/** Short role labels for the export-floor hint on the index row. */
export const FLOOR_LABEL: Record<number, string> = {
  [ROLE.VIEWER]: "Viewer",
  [ROLE.CONTRIBUTOR]: "Contributor",
  [ROLE.PROJECT_LEAD]: "Project lead",
  [ROLE.MAINTAINER]: "Maintainer",
  [ROLE.OWNER]: "Owner",
}

export const ORG_SETTINGS_SECTIONS = [
  "identity",
  "export",
  "roster",
  "assignment",
  "providers",
] as const
export type OrgSettingsSection = (typeof ORG_SETTINGS_SECTIONS)[number]

export const ORG_SETTINGS_SECTION_TITLES: Record<OrgSettingsSection, string> = {
  identity: "Identity",
  export: "Export permissions",
  roster: "Roster & progress visibility",
  assignment: "Assignment authority",
  providers: "AI provider keys",
}

export const ORG_SETTINGS_SECTION_DESCRIPTIONS: Record<OrgSettingsSection, string> = {
  identity: "The organization's display name, shown across the workspace.",
  export:
    "Minimum role required to download project deliverables — USFM export and project zip. Defaults to Maintainer.",
  roster:
    "Who can see the member roster and per-member progress. Both default to Maintainer.",
  assignment:
    "Whether members below project lead may claim work for themselves. Leads and maintainers can always assign.",
  providers:
    "Org-level keys act as a baseline for everyone in this organization. Projects or individuals can override with their own.",
}
