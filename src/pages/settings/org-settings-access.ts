// AQU-2260 (Sam, Oct 29, Settings cleanup 5c, option A): every organization
// settings page can be opened by any member. Below the role a page needs, it
// is shown read-only — people can still see how things are set, which helps
// them ask for a change — with one line at its top saying who can change it,
// and "View only" beside it in the settings list.
//
// One row per page. A page added later (AQU-1410's per-organization feature
// toggles, say) adds its own row here and gets the same treatment.

import { ROLE } from "@/lib/frontier/roles"
import type { OrgSettingsSection } from "./constants"

export type OrgSettingsPage = OrgSettingsSection | "rules" | "knowledge"

/** The lowest org role that can change each page. Mirrors each page's own
 *  write gate (and the server's): Security's floors are the Owner's alone,
 *  everything else is a Maintainer's. */
export const ORG_SETTINGS_EDIT_FLOOR: Record<OrgSettingsPage, number> = {
  identity: ROLE.MAINTAINER,
  security: ROLE.OWNER,
  "project-defaults": ROLE.MAINTAINER,
  billing: ROLE.MAINTAINER,
  providers: ROLE.MAINTAINER,
  rules: ROLE.MAINTAINER,
  knowledge: ROLE.MAINTAINER,
  monday: ROLE.MAINTAINER,
  airtable: ROLE.MAINTAINER,
}

export function canChangeOrgSettingsPage(
  page: OrgSettingsPage,
  roleLevel: number | null | undefined,
): boolean {
  return (roleLevel ?? 0) >= ORG_SETTINGS_EDIT_FLOOR[page]
}
