// AQU-832 wave 3 (WS-08): FLOOR_LABEL used to duplicate the exact role
// vocabulary now owned by `common.role.*` (src/lib/i18n/namespaces/common.ts)
// as a second, hardcoded, English-only copy. Removed — OrgSettingsIndex.tsx
// resolves the same labels via `resolveRoleName(t, level)` instead.

export const ORG_SETTINGS_SECTIONS = [
  "identity",
  "export",
  "roster",
  "assignment",
  "terminology",
  "providers",
  "monday",
] as const
export type OrgSettingsSection = (typeof ORG_SETTINGS_SECTIONS)[number]

export const ORG_SETTINGS_SECTION_TITLES: Record<OrgSettingsSection, string> = {
  identity: "Identity",
  export: "Export permissions",
  roster: "Roster & progress visibility",
  assignment: "Assignment authority",
  terminology: "Terminology permissions",
  providers: "AI provider keys",
  monday: "Monday.com",
}

export const ORG_SETTINGS_SECTION_DESCRIPTIONS: Record<OrgSettingsSection, string> = {
  identity: "The organization's display name, shown across the workspace.",
  export:
    "Minimum role required to download project deliverables — USFM export and project zip. Defaults to Maintainer.",
  roster:
    "Who can see the member roster and per-member progress. Both default to Maintainer.",
  assignment:
    "Whether members below project lead may claim work for themselves. Leads and maintainers can always assign.",
  terminology:
    "Minimum role required to manage a project's term base — add, edit, delete, and archive terms. Defaults to Project lead.",
  providers:
    "Org-level keys act as a baseline for everyone in this organization. Projects or individuals can override with their own.",
  monday:
    "Connect this organization's Monday.com account. Projects can then link a board and push progress automatically.",
}
