// AQU-1068: the cell-editing tiers, shared by Project settings and (AQU-1768)
// the organization's Project defaults page, so both offer the same ladder
// spelled the same way.

import { ROLE } from "@/lib/frontier/roles"
import { FLOOR_LABEL } from "@/pages/settings/constants"
import type { MessageKey } from "@/lib/i18n/messages/en"
import type { CellEditingTier } from "@/lib/sync/project-settings"

/**
 * AQU-1068: the cell-editing tiers, in the order they are offered.
 *
 * The reset default leads, matching every other floor control on this page;
 * the rest climb the ladder, matching RosterProgressSection and
 * TermbaseEditSection.
 *
 * The labels used to be DESCRIPTIVE — "Maintainers and project leads", "Anyone
 * who can edit" — on the theory that they said who is admitted more plainly
 * than a bare rank. Matthew's review overruled that (Sam approved, 2026-09-08):
 * an admin who has just set someone's role on the Members panel should not have
 * to work out which bespoke phrase covers that rank, so this is the standard
 * ladder, spelled the standard way, and only "No one" — which is not a role —
 * keeps a phrase of its own.
 *
 * `level` is what makes the two-tier labelling work, exactly as in
 * RosterProgressSection: FLOOR_LABEL supplies the short word for the closed
 * trigger and the message key the fuller row in the open list. "No one" has no
 * level and therefore no FLOOR_LABEL entry, so it shows its row text in both.
 */
export const CELL_EDITING_FLOOR_OPTIONS: readonly {
  value: CellEditingTier
  /** Ladder level this tier admits, or null for "none" — which is a refusal,
   *  not a rank, and so has no place on the ladder. */
  level: number | null
  labelKey: MessageKey
}[] = [
  { value: "none", level: null, labelKey: "projectSettings.cellEditing.optionNone" },
  { value: "commenter", level: ROLE.COMMENTER, labelKey: "projectSettings.cellEditing.optionCommenter" },
  { value: "reviewer", level: ROLE.REVIEWER, labelKey: "projectSettings.cellEditing.optionReviewer" },
  { value: "contributor", level: ROLE.CONTRIBUTOR, labelKey: "projectSettings.cellEditing.optionContributor" },
  { value: "project_lead", level: ROLE.PROJECT_LEAD, labelKey: "projectSettings.cellEditing.optionProjectLead" },
  { value: "maintainer", level: ROLE.MAINTAINER, labelKey: "projectSettings.cellEditing.optionMaintainer" },
]

/**
 * AQU-1768: the short name of a tier, for "Organization default (…)" and the
 * org's own picker — the closed-trigger word for a rank, the row text for
 * "No one", exactly as the Select above labels them.
 */
export function cellEditingTierLabel(
  t: (key: MessageKey) => string,
  tier: CellEditingTier,
): string {
  const option = CELL_EDITING_FLOOR_OPTIONS.find((o) => o.value === tier) ?? CELL_EDITING_FLOOR_OPTIONS[0]
  // "No one — default" is the open-list row; "default" would be wrong inside
  // "Organization default (…)", so the refusal gets its own short name.
  if (option.level == null) return t("projectSettings.mediaDefaults.cellEditingNobody")
  return FLOOR_LABEL[option.level] ?? t(option.labelKey)
}
