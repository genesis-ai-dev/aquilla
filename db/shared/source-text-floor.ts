// AQU-2647: who may edit source text, hide a cell, and split a line at quotes.
//
// One floor for all three. Absent, and any value this build does not recognise,
// reads as maintainer — never looser. A project that sets its own tier uses
// that; otherwise it uses its organization's. Maintainer and owner meet every
// rung this offers. A lower rung is met by that role on any language lane, or
// by the retiring project role at the same level.

export const SOURCE_TEXT_TIERS = ["contributor", "project_lead", "maintainer"] as const

export type SourceTextTier = (typeof SOURCE_TEXT_TIERS)[number]

const CONTRIBUTOR = 400
const PROJECT_LEAD = 500
const MAINTAINER = 600

export const SOURCE_TEXT_FLOOR_LEVEL: Record<SourceTextTier, number> = {
  contributor: CONTRIBUTOR,
  project_lead: PROJECT_LEAD,
  maintainer: MAINTAINER,
}

/** The floor an absent or unrecognised tier enforces. */
export const DEFAULT_SOURCE_TEXT_FLOOR = MAINTAINER

/**
 * The organization that keeps Project Lead when every other existing
 * organization moves to Maintainer. The migration matches this name, not a
 * project id or a user id. `organizations.name` is not unique, so every row
 * with this exact name is updated. The repo uses the string as that
 * organization's display name (for example the Pattani Malay note in
 * sync-worker/src/events/cell-removal-authority.ts).
 */
export const BIBLICA_ETT_ORG_NAME = "Biblica ETT"

export function isSourceTextTier(value: unknown): value is SourceTextTier {
  return typeof value === "string" && (SOURCE_TEXT_TIERS as readonly string[]).includes(value)
}

/** The level a stored tier admits. Unknown values stay at the default. */
export function sourceTextFloorLevel(tier: unknown): number {
  return isSourceTextTier(tier) ? SOURCE_TEXT_FLOOR_LEVEL[tier] : DEFAULT_SOURCE_TEXT_FLOOR
}

/**
 * The floor in force: the project's own tier when this build recognises it,
 * otherwise the organization's, otherwise maintainer.
 */
export function effectiveSourceTextFloor(projectTier: unknown, orgTier: unknown): number {
  if (isSourceTextTier(projectTier)) return SOURCE_TEXT_FLOOR_LEVEL[projectTier]
  if (isSourceTextTier(orgTier)) return SOURCE_TEXT_FLOOR_LEVEL[orgTier]
  return DEFAULT_SOURCE_TEXT_FLOOR
}

/**
 * What the one-time migration writes for an existing organization. Only the
 * exact name keeps Project Lead; every other name, including a near miss,
 * moves to Maintainer by leaving the key absent.
 */
export function sourceTextTierForExistingOrg(name: string | null | undefined): SourceTextTier {
  return name === BIBLICA_ETT_ORG_NAME ? "project_lead" : "maintainer"
}

/**
 * The clearance compared with the floor: the higher of the project role and
 * any language-lane grant. A lane grant does not lower the project role.
 */
export function sourceTextAuthorityLevel(input: {
  projectRole: number | null | undefined
  laneLevels?: readonly number[] | null
}): number {
  let best = typeof input.projectRole === "number" && Number.isFinite(input.projectRole) ? input.projectRole : 0
  for (const level of input.laneLevels ?? []) {
    if (typeof level === "number" && Number.isFinite(level) && level > best) best = level
  }
  return best
}

export function meetsSourceTextFloor(authority: number, floor: number): boolean {
  return authority >= floor
}
