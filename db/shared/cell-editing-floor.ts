// AQU-1068: the `cellEditingFloor` vocabulary.
//
// THE TIER IS A PRODUCT RULE, ENFORCED WHERE THE BUTTONS ARE (Sam,
// 2026-09-09). auth-worker reads it here to stage an agent's proposal, because
// an Apply button is a button like any other and the agent should offer only
// what the person could do by hand. sync-worker no longer reads it at all: it
// checked the tier at the /events perimeter until 2026-09-09, and doing so
// silently refused audio-cue re-import, DCS upstream import and diarization —
// three flows that emit the same event kinds through the user's own outbox.
// See sync-worker/src/events/authorize.ts for the full reasoning and for the
// one rule that DID stay at the perimeter: removing an imported cell needs
// maintainer.
//
// The CLIENT keeps its own copy in src/lib/sync/project-settings.ts, because
// it cannot import server code. That copy and this one are now the whole of
// the enforcement, so keep them in lock-step.

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
 * dropped to COMMENTER at the same time. That floor sits UNDER this tier:
 * while it was CONTRIBUTOR, choosing either of these two tiers would have
 * admitted nobody the old list could not already admit — the event would have
 * been refused a step earlier and the setting would have silently lied. That
 * static floor is now the only SERVER floor on those kinds, so it is what
 * keeps these two rungs honest.
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
