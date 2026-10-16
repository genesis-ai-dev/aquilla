// AQU-1615: the external API addresses a target lane by lanes.id.
//
// A language tag, a legacy_tag (including ''), and an omitted id are not
// accepted and are not aliased. Omitting the id is a 400 that names the
// discovery endpoint. A lane the caller cannot see is the same 400 as a lane
// that does not exist — "lane does not exist", with no name and no "archived"
// — which is the AQU-1462 / external prepare response. Do not invent a status.

import { type AskedLane, type ExternalLaneSpec, type ProjectLaneRecord } from '../../../db/shared/lanes'
import { visibleTagsForMember } from '../../../db/shared/lane-visibility'
import { loadProjectSettings } from '../../../db/shared/projects'
import type { AquillaDb } from '../../../db/shim/postgres'
import {
  archivedTagsFromSettings,
  LANE_DOES_NOT_EXIST_REASON,
} from '../../../src/lib/lanes/archived-lane'
import {
  canonicalLanguageCodeOverride,
  laneDisplayName,
  laneLanguage,
  type LaneLanguageSettings,
} from '../../../src/lib/lanes/lane-display'

/** The unauthenticated API map. Project lanes themselves are on the project read. */
export const LANE_DISCOVERY_ENDPOINT = 'GET /api/v1/external'

export const LANE_LIST_ENDPOINT = 'GET /api/v1/external/projects/:projectId'

export function laneIdRequiredMessage(where: string): string {
  return (
    `${where} is required. ${LANE_DISCOVERY_ENDPOINT} describes lanes; ` +
    `${LANE_LIST_ENDPOINT} returns the lanes you may use (id, name, language, role).`
  )
}

export {
  RETIRED_LANE_SETTINGS_KEYS,
  RETIRED_LANE_SETTINGS_MESSAGE,
} from '../../../db/shared/retired-lane-settings'

export interface CallerLane {
  id: string
  name: string
  language: string
  role: 'source' | 'target'
  legacyTag: string | null
  archivedAt: string | null
}

export interface LaneResolutionContext {
  rows: readonly ProjectLaneRecord[]
  settings: Record<string, unknown>
  /** Null means the caller may see every lane. */
  visibleIds: ReadonlySet<string> | null
}

/** Resolve `?lane=` / `?targetLang=` on an external read. Null is an omission. */
export async function resolveExternalLaneParam(
  db: AquillaDb,
  flag: string | undefined,
  projectId: string,
  userId: number,
  roleLevel: number,
  laneId: string | null,
  where: string,
): Promise<{ ok: true; lane: CallerLane } | { ok: false; message: string }> {
  if (laneId === null) return { ok: false, message: laneIdRequiredMessage(where) }
  const ctx = await loadLaneResolutionContext(db, projectId, flag, userId, roleLevel)
  return resolveTargetLaneId(laneId, where, ctx)
}

export async function loadLaneResolutionContext(
  db: AquillaDb,
  projectId: string,
  flag: string | undefined,
  userId: number,
  role: number,
): Promise<LaneResolutionContext> {
  const [settings, visibility] = await Promise.all([
    loadProjectSettings(db, projectId),
    visibleTagsForMember(db, flag, projectId, userId, role),
  ])
  return {
    rows: settings.lanes ?? [],
    settings: settings.settings,
    visibleIds: visibility.visible,
  }
}

/** Settings-aware load. Prefer this when the caller already has the blob. */
export function laneContextFrom(
  rows: readonly ProjectLaneRecord[],
  settings: Record<string, unknown>,
  visibleIds: ReadonlySet<string> | null,
): LaneResolutionContext {
  return { rows, settings, visibleIds }
}

function toCallerLane(lane: ProjectLaneRecord, settings: LaneLanguageSettings | null | undefined): CallerLane {
  return {
    id: lane.id,
    name: laneDisplayName(lane),
    language: laneLanguage(lane, { settings, role: lane.role, legacyTag: lane.legacyTag }),
    role: lane.role,
    legacyTag: lane.legacyTag,
    archivedAt: lane.archivedAt,
  }
}

/**
 * Resolution context plus target lanes this plan will insert.
 *
 * Those rows are not in the database yet. They count as visible target lanes
 * for this check: the caller is creating them, and a ProjectSetup import has
 * to be able to name one.
 */
export function laneContextWithPlanned(
  ctx: LaneResolutionContext,
  planned: readonly AskedLane[] | undefined,
): LaneResolutionContext {
  const extra: ProjectLaneRecord[] = []
  const visibleIds = ctx.visibleIds === null ? null : new Set(ctx.visibleIds)
  for (const lane of planned ?? []) {
    if (lane.role !== 'target' || !lane.id) continue
    extra.push({
      id: lane.id,
      role: 'target',
      language: lane.language,
      name: lane.name ?? null,
      langCode: lane.langCode ?? null,
      legacyTag: lane.legacyTag ?? null,
      position: ctx.rows.length + extra.length,
      archivedAt: null,
    })
    visibleIds?.add(lane.id)
  }
  if (extra.length === 0) return ctx
  return { rows: [...ctx.rows, ...extra], settings: ctx.settings, visibleIds }
}

/** Target lanes this caller may write: visible, and not archived. */
export function writableTargetLanes(ctx: LaneResolutionContext): ProjectLaneRecord[] {
  const archived = archivedTagsFromSettings(ctx.settings)
  return ctx.rows.filter((lane) => {
    if (lane.role !== 'target') return false
    if (ctx.visibleIds !== null && !ctx.visibleIds.has(lane.id)) return false
    return !rowIsArchived(lane, archived)
  })
}

/** Lanes this caller may see, in display order. A hidden lane is absent. */
export function lanesVisibleToCaller(ctx: LaneResolutionContext): CallerLane[] {
  const settings = ctx.settings as LaneLanguageSettings
  return ctx.rows
    .filter((lane) => lane.role === 'source' || ctx.visibleIds === null || ctx.visibleIds.has(lane.id))
    .map((lane) => toCallerLane(lane, settings))
}

function listed(tags: readonly string[], value: string): boolean {
  if (!value) return false
  const needle = value.toLowerCase()
  return tags.some((tag) => tag !== '' && tag.toLowerCase() === needle)
}

function rowIsArchived(lane: ProjectLaneRecord, archivedTags: readonly string[]): boolean {
  if (lane.archivedAt != null && lane.archivedAt !== '') return true
  // The '' bridge is archived only by its row. archivedLanes cannot name it.
  if ((lane.legacyTag ?? '') === '') return false
  return listed(archivedTags, lane.legacyTag ?? '') || listed(archivedTags, lane.name ?? '')
}

export type ResolvedTargetLane =
  | { ok: true; lane: CallerLane }
  | { ok: false; message: string }

/**
 * Resolve a caller-supplied lane id to a target lane they may see.
 *
 * `undefined` is the omitted-id 400. Any other string that is not the id of
 * a visible target lane — a language, a legacy tag, a hidden id, a missing
 * id — is "lane does not exist".
 */
export function resolveTargetLaneId(
  laneId: string | undefined,
  where: string,
  ctx: LaneResolutionContext,
): ResolvedTargetLane {
  if (laneId === undefined) {
    return { ok: false, message: laneIdRequiredMessage(where) }
  }
  const row = ctx.rows.find((lane) => lane.id === laneId)
  const canSee =
    row != null && (row.role === 'source' || ctx.visibleIds === null || ctx.visibleIds.has(row.id))
  if (!row || !canSee || row.role !== 'target') {
    // A visible source lane is not a target. Still do not confirm a hidden
    // target: a source id the caller can see is the only case we name, and
    // only as "not a target", which discovery already showed them.
    if (row && canSee && row.role === 'source') {
      return { ok: false, message: `${where} must name a target lane` }
    }
    return { ok: false, message: `${where} ${LANE_DOES_NOT_EXIST_REASON}` }
  }
  if (rowIsArchived(row, archivedTagsFromSettings(ctx.settings))) {
    return { ok: false, message: `${where} lane '${laneDisplayName(row)}' is archived` }
  }
  return { ok: true, lane: toCallerLane(row, ctx.settings as LaneLanguageSettings) }
}

/** Shape-check a CreateProject / ProjectSetup `lanes` array. Does not mint ids. */
export function parseLaneSpecs(
  raw: unknown,
  where: string,
): { ok: true; lanes: ExternalLaneSpec[] } | { ok: false; message: string } {
  if (!Array.isArray(raw)) return { ok: false, message: `${where} must be an array` }
  const lanes: ExternalLaneSpec[] = []
  for (const [index, item] of raw.entries()) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return { ok: false, message: `${where}[${index}] must be an object` }
    }
    const spec = item as Record<string, unknown>
    if (spec.role !== 'source' && spec.role !== 'target') {
      return { ok: false, message: `${where}[${index}].role must be "source" or "target"` }
    }
    if (typeof spec.language !== 'string' || spec.language.trim().length === 0) {
      return { ok: false, message: `${where}[${index}].language is required` }
    }
    if (spec.name !== undefined && typeof spec.name !== 'string') {
      return { ok: false, message: `${where}[${index}].name must be a string when present` }
    }
    if (spec.code !== undefined && spec.code !== null && typeof spec.code !== 'string') {
      return { ok: false, message: `${where}[${index}].code must be a string when present` }
    }
    const override = canonicalLanguageCodeOverride(
      typeof spec.code === 'string' ? spec.code : null,
    )
    if (!override.ok) {
      return { ok: false, message: `${where}[${index}].code must be a well-formed BCP 47 tag` }
    }
    lanes.push({
      role: spec.role,
      language: spec.language,
      ...(typeof spec.name === 'string' ? { name: spec.name } : {}),
      ...(typeof spec.code === 'string' ? { code: spec.code } : {}),
    })
  }
  return { ok: true, lanes }
}

/** targetLang + laneId for an event, agreeing on the lane's frozen tag. */
export function eventLaneFields(lane: CallerLane): { targetLang: string; laneId: string } {
  return { targetLang: lane.legacyTag ?? '', laneId: lane.id }
}

/**
 * Stamp a stored command's lane onto an event.
 *
 * A current plan stores `lanes.id`. An older staged plan may still store a
 * language tag: that tag is written as `targetLang` only, so the event still
 * lands. An omitted id stamps nothing — the internal event path treats that
 * as the `''` bridge (canonicalLaneId). This function does not alias a tag
 * to a lane id.
 */
export function stampStoredLaneId(
  laneId: string | undefined,
  rows: readonly ProjectLaneRecord[],
): { targetLang?: string; laneId?: string } {
  if (laneId === undefined) return {}
  // An older staged plan used '' for the default-lane bridge. A new command
  // never stores '' — prepare rejects it — so this only keeps that plan working.
  if (laneId === '') return { targetLang: '' }
  const row = rows.find((candidate) => candidate.id === laneId)
  if (!row) return { targetLang: laneId }
  return { targetLang: row.legacyTag ?? '', laneId: row.id }
}
