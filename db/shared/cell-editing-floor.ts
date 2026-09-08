// AQU-1068: the `cellEditingFloor` vocabulary, shared by both workers.
//
// sync-worker enforces it at the /events perimeter; auth-worker asks the same
// question when it stages an agent's proposal, so the agent never offers an
// insert or a removal that would be refused at apply. Two copies of a mapping
// that must agree is one copy too many — hence this module.
//
// The CLIENT keeps its own copy in src/lib/sync/project-settings.ts, because
// it cannot import server code; that one is an affordance gate only.

/** Role levels, mirroring the ladder both workers already carry. */
const MAINTAINER = 600
const PROJECT_LEAD = 500
const CONTRIBUTOR = 400
const REVIEWER = 300
const COMMENTER = 200

/**
 * Stored tier -> the role level it admits. "none" is deliberately absent.
 *
 * The rungs are the product's standard permission ladder (Matthew's review,
 * approved by Sam 2026-09-08) rather than a bespoke set, so a project admin
 * picks the same names here they picked on the Members panel.
 *
 * COMMENTER and REVIEWER are only REAL because the static floor for
 * `source.cell.create` / `.delete` / `.reorder` in both role-policy tables
 * dropped to COMMENTER at the same time. That floor sits UNDER this tier gate:
 * while it was CONTRIBUTOR, choosing either of these two tiers would have
 * admitted nobody the old list could not already admit — the event would have
 * been refused a step earlier and the setting would have silently lied.
 */
const FLOOR_BY_TIER: Record<string, number> = {
  maintainer: MAINTAINER,
  project_lead: PROJECT_LEAD,
  contributor: CONTRIBUTOR,
  reviewer: REVIEWER,
  commenter: COMMENTER,
}

/**
 * The role level a settings blob admits to cell editing, or `null` for nobody.
 *
 * `null` — the refusing answer — covers every way of not saying yes: an absent
 * key, the explicit "none", a non-string, and any tier this build does not
 * recognise. A value a newer client invents must never read as permission on
 * an older server.
 */
export function cellEditingFloorFromSettings(settings: unknown): number | null {
  if (typeof settings !== "object" || settings === null) return null
  const tier = (settings as { cellEditingFloor?: unknown }).cellEditingFloor
  if (typeof tier !== "string") return null
  return FLOOR_BY_TIER[tier] ?? null
}

/** Removing an IMPORTED cell needs this on top of the tier, always. */
export const IMPORTED_CELL_REMOVAL_ROLE = MAINTAINER

/** The event kinds the tier governs. Reorder is here because every add and
 *  remove batches one in as chain bookkeeping, and a gate that refused the
 *  companion would kill the whole batch. */
export const CELL_EDITING_KINDS = [
  "source.cell.create",
  "source.cell.delete",
  "source.cell.reorder",
] as const

export function isCellEditingKind(kind: string): boolean {
  return (CELL_EDITING_KINDS as readonly string[]).includes(kind)
}
