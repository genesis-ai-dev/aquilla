/**
 * AQU-1616 — plan the lane batch backfill.
 *
 * Pure: no connection, no SQL execution. The script in
 * `scripts/neon-backfill-lane-batch.ts` loads a snapshot and applies `writes`.
 * A second plan of the snapshot after those writes is empty, except the
 * progress recompute, which is the existing projection and is safe to repeat.
 *
 * Lane rows are never deleted. `legacy_tag` is never written. Events are
 * never rewritten. `legacy_tag ''` stays the permanent bridge.
 *
 * "Same lane?" is the lane id (`resolveEventLane`). "Same language?" goes
 * through `languagesEqual` only.
 */

import { languagesEqual } from "../language-normalize"
import {
  BLANK_LANE_PLACEHOLDER,
  SOURCE_LANE_PLACEHOLDER,
  codeForLanguageLabel,
} from "./backfill-plan"
import { resolveEventLane } from "./event-lane"
import { isLaneId } from "./lane-id"
import { lanesForRequestedTag, type LaneIdentity } from "./read-wall"
import { legacyEmptyLaneId, stampRenderingLanes } from "../terminology/rendering-lane"
import { resolveLaneScopeValue } from "./scope-ids"

export const GUESSED_LANE_LANGUAGE_REASON =
  "legacy tag is the lane id; language taken from the stored name"

export const LANE_BATCH_MIGRATIONS = [
  "0138_project_source_link_lane_id.sql",
  "0152_lane_language.sql",
] as const

export const LANE_BATCH_READ_ONLY_OPTIONS = "-c default_transaction_read_only=on"

/** node-pg client config. Dry run sets the read-only session at startup. */
export function laneBatchClientConfig(
  connectionString: string,
  readOnly: boolean,
): { connectionString: string; options?: string } {
  return readOnly
    ? { connectionString, options: LANE_BATCH_READ_ONLY_OPTIONS }
    : { connectionString }
}

export interface LaneBatchColumnPresence {
  laneLanguage: boolean
  laneNameNullable: boolean
  sourceLinkLaneId: boolean
  audioLaneId: boolean
  audioValidatorLaneId: boolean
  backtranslationLaneId: boolean
}

/**
 * Why `--apply` must refuse. Null means the migrations and the columns this
 * backfill writes are present. 0138 and 0152 are the named gate; the other
 * columns are what the audio and back-translation writes update.
 */
export function laneBatchApplyRefusal(
  appliedMigrations: readonly string[],
  columns: LaneBatchColumnPresence,
): string | null {
  const applied = new Set(appliedMigrations)
  const missingMigrations = LANE_BATCH_MIGRATIONS.filter((name) => !applied.has(name))
  const schemaGaps: string[] = []
  if (!columns.laneLanguage) schemaGaps.push("lanes.language is missing")
  if (!columns.laneNameNullable) schemaGaps.push("lanes.name is still NOT NULL")
  if (!columns.sourceLinkLaneId) schemaGaps.push("projects.source_link_lane_id is missing")
  if (
    missingMigrations.length > 0 ||
    !columns.laneLanguage ||
    !columns.laneNameNullable ||
    !columns.sourceLinkLaneId
  ) {
    const details = [
      ...missingMigrations.map((name) => `not in schema_migrations: ${name}`),
      ...schemaGaps,
    ]
    return (
      "Refusing --apply until migrations 0138_project_source_link_lane_id.sql and " +
      "0152_lane_language.sql are applied.\n" +
      details.join("\n")
    )
  }
  const later: string[] = []
  if (!columns.audioLaneId) later.push("cell_audio.lane_id (migration 0135_cell_audio_lane_id.sql)")
  if (!columns.audioValidatorLaneId) {
    later.push("cell_audio_validators.lane_id (migration 0135_cell_audio_lane_id.sql)")
  }
  if (!columns.backtranslationLaneId) {
    later.push("cell_backtranslations.lane_id (migration 0144_cell_backtranslations_lane_id.sql)")
  }
  if (later.length > 0) {
    return `Refusing --apply: these columns are not on this database:\n${later.join("\n")}`
  }
  return null
}

export const LANE_BATCH_SQL = {
  updateLane:
    "UPDATE lanes SET language = $1, name = $2, lang_code = NULL, updated_at = now() WHERE project_id = $3 AND id = $4",
  updateScope:
    "UPDATE project_member_scopes SET value = $1 WHERE project_id = $2 AND user_id = $3 AND kind = 'lane' AND value = $4",
  deleteScope:
    "DELETE FROM project_member_scopes WHERE project_id = $1 AND user_id = $2 AND kind = 'lane' AND value = $3",
  updateInvite:
    "UPDATE project_invites SET scope_lanes = $1 WHERE token = $2 AND project_id = $3",
  updateLink:
    "UPDATE projects SET source_link_lane_id = $1, updated_at = now() WHERE id = $2 AND source_link_lane_id IS NULL",
  updateAudio:
    "UPDATE cell_audio SET lane_id = $1 WHERE project_id = $2 AND file_id = $3 AND cell_id = $4 AND audio_id = $5 AND lane_id IS NULL",
  updateAudioValidator:
    "UPDATE cell_audio_validators SET lane_id = $1 WHERE project_id = $2 AND file_id = $3 AND cell_id = $4 AND audio_id = $5 AND username = $6 AND lane_id IS NULL",
  updateBacktranslation:
    "UPDATE cell_backtranslations SET lane_id = $1 WHERE project_id = $2 AND file_id = $3 AND cell_id = $4 AND target_event_id = $5 AND lane_id IS NULL",
  updateConcept:
    "UPDATE concepts SET renderings = $1::jsonb WHERE concept_id = $2 AND project_id = $3",
} as const

export interface LaneBatchLane {
  id: string
  role: "source" | "target"
  name: string | null
  langCode: string | null
  /** null is the source lane. '' is the former default target lane. */
  legacyTag: string | null
  /** null when 0152 is not applied, or the column is null. */
  language: string | null
}

export interface LaneBatchScope {
  userId: string
  kind: string
  value: string
}

export interface LaneBatchInvite {
  token: string
  /** null when the invite is unscoped. */
  scopeLanes: string[] | null
  /** The stored text was not a JSON array of strings. */
  scopeLanesInvalid?: boolean
}

export interface LaneBatchAudio {
  fileId: string
  cellId: string
  audioId: string
  role: string
  laneId: string | null
  eventLaneId: string | null
  /** null when no event named a tag. '' is an explicit default-lane tag. */
  eventTargetLang: string | null
}

export interface LaneBatchAudioValidator {
  fileId: string
  cellId: string
  audioId: string
  username: string
  laneId: string | null
}

export interface LaneBatchBacktranslation {
  fileId: string
  cellId: string
  targetEventId: string
  laneId: string | null
  eventLaneId: string | null
  eventTargetLang: string | null
  targetCellLaneId: string | null
  targetEventLaneId: string | null
  targetEventTargetLang: string | null
}

export interface LaneBatchConcept {
  conceptId: string
  renderings: unknown[]
}

export interface LaneBatchProgressRow {
  fileId: string
  scope: string
  sectionKey: string
  laneId: string
  targetLang: string
}

export interface LaneBatchProject {
  id: string
  name: string
  sourceLanguage: string | null
  targetLanguage: string | null
  sourceProjectId: string | null
  /** null is the schema's source-consumption default. */
  sourceLinkConsumes: string | null
  sourceLinkLaneId: string | null
  lanes: LaneBatchLane[]
  scopes: LaneBatchScope[]
  invites: LaneBatchInvite[]
  audio: LaneBatchAudio[]
  audioValidators: LaneBatchAudioValidator[]
  backtranslations: LaneBatchBacktranslation[]
  concepts: LaneBatchConcept[]
  files: { id: string }[]
  progress: LaneBatchProgressRow[]
}

export interface LaneBatchSnapshot {
  projects: LaneBatchProject[]
}

export interface AudioLogEvent {
  id: string
  kind: string
  serverSeq: number
  laneId: string | null
  targetLang: string | null
}

/**
 * The event replay would leave on the take: the latest `cell.audio.attach`,
 * or the latest other audio event when the take has no attach.
 */
export function selectAudioLaneEvent(events: readonly AudioLogEvent[]): AudioLogEvent | null {
  if (events.length === 0) return null
  const sorted = [...events].sort((a, b) => a.serverSeq - b.serverSeq || a.id.localeCompare(b.id))
  const attaches = sorted.filter((event) => event.kind === "cell.audio.attach")
  const chosen = attaches.length > 0 ? attaches[attaches.length - 1] : sorted[sorted.length - 1]
  return chosen ?? null
}

export interface GuessedLaneLanguage {
  projectId: string
  projectName: string
  laneId: string
  legacyTag: string
  name: string
  language: string
  reason: string
}

export interface UnresolvableRow {
  rule:
    | "scopes"
    | "invites"
    | "links"
    | "backtranslations"
    | "audio"
    | "audioValidators"
    | "concepts"
    | "progress"
  projectId: string
  projectName: string
  key: string
  reason: string
}

export interface NameCodeDisagreement {
  projectId: string
  projectName: string
  laneId: string
  name: string
  langCode: string
  derivedCode: string
}

export interface DuplicateLaneNames {
  projectId: string
  projectName: string
  name: string
  laneIds: string[]
}

export interface ScopeTagMatch {
  surface: "member" | "invite"
  projectId: string
  projectName: string
  userId: string | null
  value: string
  matches: number
}

export interface LaneBatchCounts {
  lanes: {
    examined: number
    languageFilled: number
    langCodeCleared: number
    nameCleared: number
    guessed: number
    leftEmpty: number
    unchanged: number
  }
  scopes: {
    examined: number
    converted: number
    alreadyId: number
    droppedDuplicate: number
    zero: number
    two: number
  }
  invites: {
    examined: number
    updated: number
    already: number
    unscoped: number
    zero: number
    two: number
  }
  links: {
    examined: number
    filled: number
    already: number
    conflict: number
    unresolved: number
  }
  backtranslations: {
    examined: number
    filled: number
    already: number
    conflict: number
    unresolved: number
    byRule: {
      eventLaneId: number
      eventTargetLang: number
      targetEvent: number
      emptyTag: number
    }
  }
  audio: {
    examined: number
    filled: number
    already: number
    conflict: number
    unresolved: number
    byRule: {
      sourceRole: number
      eventLaneId: number
      eventTargetLang: number
      emptyTag: number
    }
  }
  audioValidators: {
    examined: number
    filled: number
    already: number
    unresolved: number
  }
  concepts: {
    examined: number
    restamped: number
    already: number
    unresolved: number
  }
  progress: {
    filesToRecompute: number
    filesMissingSourceRow: number
    orphanRows: number
  }
}

export interface LaneBatchReport {
  mode: "dry-run" | "apply"
  counts: LaneBatchCounts
  guessedLanguages: GuessedLaneLanguage[]
  unresolvable: UnresolvableRow[]
  aqu1585: {
    disagreements: NameCodeDisagreement[]
    duplicateNames: DuplicateLaneNames[]
  }
  scopeTags: {
    zero: ScopeTagMatch[]
    two: ScopeTagMatch[]
  }
}

export type LaneBatchWrite =
  | {
      table: "lanes"
      projectId: string
      laneId: string
      language: string | null
      name: string | null
      langCode: null
    }
  | {
      table: "project_member_scopes"
      action: "update" | "delete"
      projectId: string
      userId: string
      from: string
      to?: string
    }
  | {
      table: "project_invites"
      projectId: string
      token: string
      scopeLanes: string[]
    }
  | {
      table: "projects"
      projectId: string
      sourceLinkLaneId: string
    }
  | {
      table: "cell_audio"
      projectId: string
      fileId: string
      cellId: string
      audioId: string
      laneId: string
    }
  | {
      table: "cell_audio_validators"
      projectId: string
      fileId: string
      cellId: string
      audioId: string
      username: string
      laneId: string
    }
  | {
      table: "cell_backtranslations"
      projectId: string
      fileId: string
      cellId: string
      targetEventId: string
      laneId: string
    }
  | {
      table: "concepts"
      projectId: string
      conceptId: string
      renderings: unknown[]
    }

export interface LaneBatchPlan {
  report: LaneBatchReport
  writes: LaneBatchWrite[]
  progressFiles: { projectId: string; fileId: string }[]
}

function emptyCounts(): LaneBatchCounts {
  return {
    lanes: {
      examined: 0,
      languageFilled: 0,
      langCodeCleared: 0,
      nameCleared: 0,
      guessed: 0,
      leftEmpty: 0,
      unchanged: 0,
    },
    scopes: { examined: 0, converted: 0, alreadyId: 0, droppedDuplicate: 0, zero: 0, two: 0 },
    invites: { examined: 0, updated: 0, already: 0, unscoped: 0, zero: 0, two: 0 },
    links: { examined: 0, filled: 0, already: 0, conflict: 0, unresolved: 0 },
    backtranslations: {
      examined: 0,
      filled: 0,
      already: 0,
      conflict: 0,
      unresolved: 0,
      byRule: { eventLaneId: 0, eventTargetLang: 0, targetEvent: 0, emptyTag: 0 },
    },
    audio: {
      examined: 0,
      filled: 0,
      already: 0,
      conflict: 0,
      unresolved: 0,
      byRule: { sourceRole: 0, eventLaneId: 0, eventTargetLang: 0, emptyTag: 0 },
    },
    audioValidators: { examined: 0, filled: 0, already: 0, unresolved: 0 },
    concepts: { examined: 0, restamped: 0, already: 0, unresolved: 0 },
    progress: { filesToRecompute: 0, filesMissingSourceRow: 0, orphanRows: 0 },
  }
}

function trimmed(value: string | null | undefined): string {
  return (value ?? "").trim()
}

function isPlaceholderName(name: string): boolean {
  const folded = name.trim().toLowerCase()
  return folded === SOURCE_LANE_PLACEHOLDER.toLowerCase() || folded === BLANK_LANE_PLACEHOLDER.toLowerCase()
}

function asIdentity(lane: LaneBatchLane): LaneIdentity {
  return { id: lane.id, name: lane.name, legacyTag: lane.legacyTag }
}

function targetLanes(project: LaneBatchProject): LaneBatchLane[] {
  return project.lanes.filter((lane) => lane.role === "target")
}

function sourceLane(project: LaneBatchProject): LaneBatchLane | null {
  return project.lanes.find((lane) => lane.role === "source") ?? null
}

function emptyTagLane(lanes: readonly LaneBatchLane[]): LaneBatchLane | null {
  const matches = lanes.filter((lane) => lane.role === "target" && (lane.legacyTag ?? "") === "")
  return matches.length === 1 ? matches[0]! : null
}

interface LaneFill {
  language: string
  guess: GuessedLaneLanguage | null
}

/**
 * A stored language is kept. Re-running must not replace it from settings or
 * from a name this backfill already cleared. An empty language is filled once:
 * source from settings, the '' lane from the target language, a language tag
 * from that tag, a lane-id tag from the name (a guess).
 */
function fillLanguage(project: LaneBatchProject, lane: LaneBatchLane): LaneFill {
  const stored = trimmed(lane.language)
  if (stored) return { language: stored, guess: null }
  if (lane.role === "source") {
    return { language: trimmed(project.sourceLanguage), guess: null }
  }
  const tag = lane.legacyTag ?? ""
  if (tag === "") return { language: trimmed(project.targetLanguage), guess: null }
  if (isLaneId(tag)) {
    const name = trimmed(lane.name)
    if (!name || isPlaceholderName(name)) return { language: "", guess: null }
    return {
      language: name,
      guess: {
        projectId: project.id,
        projectName: project.name,
        laneId: lane.id,
        legacyTag: tag,
        name,
        language: name,
        reason: GUESSED_LANE_LANGUAGE_REASON,
      },
    }
  }
  return { language: tag.trim(), guess: null }
}

function shouldClearName(name: string | null, language: string): boolean {
  const value = trimmed(name)
  if (!value) return false
  if (isPlaceholderName(value)) return true
  if (!trimmed(language)) return false
  return languagesEqual(value, language)
}

function tagLane(
  lanes: readonly LaneBatchLane[],
  tag: string,
): { ok: true; lane: LaneBatchLane } | { ok: false; reason: string } {
  const matches = lanes.filter((lane) => lane.role === "target" && (lane.legacyTag ?? "") === tag)
  if (matches.length === 1) return { ok: true, lane: matches[0]! }
  if (matches.length === 0) return { ok: false, reason: `targetLang "${tag}" matches no lane` }
  return { ok: false, reason: `targetLang "${tag}" matches ${matches.length} lanes` }
}

type AssignmentRule = "eventLaneId" | "eventTargetLang" | "targetEvent" | "emptyTag" | "sourceRole"

function assignTagOrId(
  lanes: readonly LaneBatchLane[],
  laneId: string | null,
  targetLang: string | null,
): { ok: true; laneId: string; rule: AssignmentRule } | { ok: false; reason: string } {
  const targets = lanes.filter((lane) => lane.role === "target")
  const named = laneId !== null || targetLang !== null
  if (!named) {
    const empty = emptyTagLane(lanes)
    if (!empty) return { ok: false, reason: "no lane with legacy_tag ''" }
    return { ok: true, laneId: empty.id, rule: "emptyTag" }
  }
  const resolved = resolveEventLane(
    { laneId: laneId ?? undefined, targetLang: targetLang ?? undefined },
    targets.map(asIdentity),
  )
  if (!resolved.ok) return { ok: false, reason: resolved.reason }
  if (resolved.laneId) return { ok: true, laneId: resolved.laneId, rule: "eventLaneId" }
  const found = tagLane(lanes, resolved.tag)
  if (!found.ok) return found
  return { ok: true, laneId: found.lane.id, rule: resolved.tag === "" ? "emptyTag" : "eventTargetLang" }
}

function assignBacktranslation(
  project: LaneBatchProject,
  row: LaneBatchBacktranslation,
): { ok: true; laneId: string; rule: AssignmentRule } | { ok: false; reason: string } {
  const named = row.eventLaneId !== null || row.eventTargetLang !== null
  if (named) return assignTagOrId(project.lanes, row.eventLaneId, row.eventTargetLang)
  const targets = targetLanes(project)
  if (row.targetCellLaneId && targets.some((lane) => lane.id === row.targetCellLaneId)) {
    return { ok: true, laneId: row.targetCellLaneId, rule: "targetEvent" }
  }
  if (row.targetEventLaneId !== null || row.targetEventTargetLang !== null) {
    const resolved = assignTagOrId(project.lanes, row.targetEventLaneId, row.targetEventTargetLang)
    if (!resolved.ok) return resolved
    return { ok: true, laneId: resolved.laneId, rule: "targetEvent" }
  }
  const empty = emptyTagLane(project.lanes)
  if (!empty) return { ok: false, reason: "no lane with legacy_tag ''" }
  return { ok: true, laneId: empty.id, rule: "emptyTag" }
}

function assignAudio(
  project: LaneBatchProject,
  row: LaneBatchAudio,
): { ok: true; laneId: string; rule: AssignmentRule } | { ok: false; reason: string } {
  if (row.role === "source") {
    const source = sourceLane(project)
    if (!source) return { ok: false, reason: "project has no source lane" }
    return { ok: true, laneId: source.id, rule: "sourceRole" }
  }
  if (row.role !== "dub") return { ok: false, reason: `unknown audio role "${row.role}"` }
  return assignTagOrId(project.lanes, row.eventLaneId, row.eventTargetLang)
}

function noteStoredLane(
  current: string | null,
  assigned: string,
): "fill" | "already" | "conflict" {
  if (current === null || current === "") return "fill"
  if (current === assigned) return "already"
  return "conflict"
}

function scopeMatch(
  lanes: readonly LaneIdentity[],
  value: string,
): { ok: true; laneId: string } | { ok: false; matches: number } {
  // The conversion decision is resolveLaneScopeValue. The match count is only
  // so the report can separate zero lanes from two; it is the same lookup.
  const resolved = resolveLaneScopeValue(value, lanes)
  if (resolved.ok) return resolved
  return { ok: false, matches: lanesForRequestedTag(lanes, value).length }
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function renderingList(value: unknown): unknown[] | null {
  if (!Array.isArray(value)) return null
  if (value.some((item) => !item || typeof item !== "object")) return null
  return value
}

export function planLaneBatch(
  snapshot: LaneBatchSnapshot,
  options?: { projectId?: string },
): LaneBatchPlan {
  const counts = emptyCounts()
  const guessedLanguages: GuessedLaneLanguage[] = []
  const unresolvable: UnresolvableRow[] = []
  const disagreements: NameCodeDisagreement[] = []
  const duplicateNames: DuplicateLaneNames[] = []
  const scopeZero: ScopeTagMatch[] = []
  const scopeTwo: ScopeTagMatch[] = []
  const writes: LaneBatchWrite[] = []
  const progressFiles: { projectId: string; fileId: string }[] = []
  const byId = new Map(snapshot.projects.map((project) => [project.id, project]))
  const focus = options?.projectId
  const projects = focus ? snapshot.projects.filter((project) => project.id === focus) : snapshot.projects

  for (const project of projects) {
    const names = new Map<string, { display: string; laneIds: string[] }>()
    for (const lane of project.lanes) {
      counts.lanes.examined += 1
      const name = trimmed(lane.name)
      const code = trimmed(lane.langCode)
      if (name && code && !isPlaceholderName(name)) {
        const derived = codeForLanguageLabel(name)
        if (derived && !languagesEqual(derived, code)) {
          disagreements.push({
            projectId: project.id,
            projectName: project.name,
            laneId: lane.id,
            name,
            langCode: code,
            derivedCode: derived,
          })
        }
      }
      if (name) {
        const key = name.toLowerCase()
        const group = names.get(key) ?? { display: name, laneIds: [] }
        group.laneIds.push(lane.id)
        names.set(key, group)
      }

      const fill = fillLanguage(project, lane)
      if (!fill.language) counts.lanes.leftEmpty += 1
      if (fill.guess) {
        guessedLanguages.push(fill.guess)
        counts.lanes.guessed += 1
      }
      const clearName = shouldClearName(lane.name, fill.language)
      const clearCode = code.length > 0
      const nextLanguage = fill.language || null
      const languageChanged = trimmed(lane.language) !== fill.language
      if (!languageChanged && !clearName && !clearCode) {
        counts.lanes.unchanged += 1
        continue
      }
      if (languageChanged && fill.language) counts.lanes.languageFilled += 1
      if (clearName) counts.lanes.nameCleared += 1
      if (clearCode) counts.lanes.langCodeCleared += 1
      writes.push({
        table: "lanes",
        projectId: project.id,
        laneId: lane.id,
        language: nextLanguage,
        name: clearName ? null : lane.name,
        langCode: null,
      })
    }
    for (const group of names.values()) {
      if (group.laneIds.length < 2) continue
      duplicateNames.push({
        projectId: project.id,
        projectName: project.name,
        name: group.display,
        laneIds: group.laneIds,
      })
    }

    const identities = targetLanes(project).map(asIdentity)
    const laneScopes = project.scopes.filter((scope) => scope.kind === "lane")
    const byUser = new Map<string, LaneBatchScope[]>()
    for (const scope of laneScopes) {
      const list = byUser.get(scope.userId) ?? []
      list.push(scope)
      byUser.set(scope.userId, list)
    }
    for (const [userId, scopes] of byUser) {
      const present = new Set(scopes.map((scope) => scope.value))
      const pending: { from: string; to: string }[] = []
      for (const scope of scopes) {
        counts.scopes.examined += 1
        const match = scopeMatch(identities, scope.value)
        if (!match.ok) {
          const row: ScopeTagMatch = {
            surface: "member",
            projectId: project.id,
            projectName: project.name,
            userId,
            value: scope.value,
            matches: match.matches,
          }
          if (match.matches === 0) {
            counts.scopes.zero += 1
            scopeZero.push(row)
          } else if (match.matches === 2) {
            counts.scopes.two += 1
            scopeTwo.push(row)
          }
          unresolvable.push({
            rule: "scopes",
            projectId: project.id,
            projectName: project.name,
            key: `user:${userId} value:${scope.value}`,
            reason:
              match.matches === 0
                ? "scope tag matches zero lanes"
                : `scope tag matches ${match.matches} lanes`,
          })
          continue
        }
        if (scope.value === match.laneId) {
          counts.scopes.alreadyId += 1
          continue
        }
        pending.push({ from: scope.value, to: match.laneId })
      }
      for (const row of pending) {
        if (present.has(row.to)) {
          counts.scopes.droppedDuplicate += 1
          writes.push({
            table: "project_member_scopes",
            action: "delete",
            projectId: project.id,
            userId,
            from: row.from,
          })
          continue
        }
        counts.scopes.converted += 1
        present.add(row.to)
        writes.push({
          table: "project_member_scopes",
          action: "update",
          projectId: project.id,
          userId,
          from: row.from,
          to: row.to,
        })
      }
    }

    for (const invite of project.invites) {
      counts.invites.examined += 1
      if (invite.scopeLanesInvalid) {
        unresolvable.push({
          rule: "invites",
          projectId: project.id,
          projectName: project.name,
          key: "invite",
          reason: "scope_lanes is not a JSON array of strings",
        })
        continue
      }
      if (invite.scopeLanes === null) {
        counts.invites.unscoped += 1
        continue
      }
      const next: string[] = []
      const seen = new Set<string>()
      for (const value of invite.scopeLanes) {
        const match = scopeMatch(identities, value)
        if (!match.ok) {
          const row: ScopeTagMatch = {
            surface: "invite",
            projectId: project.id,
            projectName: project.name,
            userId: null,
            value,
            matches: match.matches,
          }
          if (match.matches === 0) {
            counts.invites.zero += 1
            scopeZero.push(row)
          } else if (match.matches === 2) {
            counts.invites.two += 1
            scopeTwo.push(row)
          }
          unresolvable.push({
            rule: "invites",
            projectId: project.id,
            projectName: project.name,
            key: `invite value:${value}`,
            reason:
              match.matches === 0
                ? "scope tag matches zero lanes"
                : `scope tag matches ${match.matches} lanes`,
          })
          if (!seen.has(value)) {
            seen.add(value)
            next.push(value)
          }
          continue
        }
        if (seen.has(match.laneId)) continue
        seen.add(match.laneId)
        next.push(match.laneId)
      }
      if (sameList(invite.scopeLanes, next)) {
        counts.invites.already += 1
        continue
      }
      counts.invites.updated += 1
      writes.push({
        table: "project_invites",
        projectId: project.id,
        token: invite.token,
        scopeLanes: next,
      })
    }

    if (project.sourceProjectId) {
      counts.links.examined += 1
      const upstream = byId.get(project.sourceProjectId)
      const consumes = project.sourceLinkConsumes ?? "source"
      let resolved: string | null = null
      let problem: string | null = null
      if (!upstream) {
        problem = `upstream project ${project.sourceProjectId} has no lane rows in this snapshot`
      } else if (consumes === "source") {
        const lane = sourceLane(upstream)
        if (!lane) problem = "upstream has no source lane"
        else resolved = lane.id
      } else if (consumes === "target") {
        const lane = emptyTagLane(upstream.lanes)
        if (!lane) problem = "upstream has no target lane with legacy_tag ''"
        else resolved = lane.id
      } else {
        problem = `unknown source_link_consumes "${consumes}"`
      }
      if (!resolved) {
        counts.links.unresolved += 1
        unresolvable.push({
          rule: "links",
          projectId: project.id,
          projectName: project.name,
          key: `upstream:${project.sourceProjectId ?? ""}`,
          reason: problem ?? "link lane unresolved",
        })
      } else if (project.sourceLinkLaneId === resolved) {
        counts.links.already += 1
      } else if (project.sourceLinkLaneId) {
        counts.links.conflict += 1
        unresolvable.push({
          rule: "links",
          projectId: project.id,
          projectName: project.name,
          key: `upstream:${project.sourceProjectId}`,
          reason: `source_link_lane_id is already ${project.sourceLinkLaneId}, which is not the backfill lane ${resolved}`,
        })
      } else {
        counts.links.filled += 1
        writes.push({ table: "projects", projectId: project.id, sourceLinkLaneId: resolved })
      }
    }

    const takeLane = new Map<string, string | null>()
    for (const take of project.audio) {
      counts.audio.examined += 1
      const key = `${take.fileId}\0${take.cellId}\0${take.audioId}`
      const assigned = assignAudio(project, take)
      if (!assigned.ok) {
        counts.audio.unresolved += 1
        takeLane.set(key, null)
        unresolvable.push({
          rule: "audio",
          projectId: project.id,
          projectName: project.name,
          key: `${take.fileId}/${take.cellId}/${take.audioId}`,
          reason: assigned.reason,
        })
        continue
      }
      const stored = noteStoredLane(take.laneId, assigned.laneId)
      const kept = stored === "conflict" ? take.laneId : assigned.laneId
      takeLane.set(key, kept)
      if (stored === "conflict") {
        counts.audio.conflict += 1
        unresolvable.push({
          rule: "audio",
          projectId: project.id,
          projectName: project.name,
          key: `${take.fileId}/${take.cellId}/${take.audioId}`,
          reason: `lane_id is already ${take.laneId}, which is not ${assigned.laneId}`,
        })
        continue
      }
      if (assigned.rule === "sourceRole") counts.audio.byRule.sourceRole += 1
      else if (assigned.rule === "eventLaneId") counts.audio.byRule.eventLaneId += 1
      else if (assigned.rule === "eventTargetLang") counts.audio.byRule.eventTargetLang += 1
      else counts.audio.byRule.emptyTag += 1
      if (stored === "already") {
        counts.audio.already += 1
        continue
      }
      counts.audio.filled += 1
      writes.push({
        table: "cell_audio",
        projectId: project.id,
        fileId: take.fileId,
        cellId: take.cellId,
        audioId: take.audioId,
        laneId: assigned.laneId,
      })
    }

    for (const vote of project.audioValidators) {
      counts.audioValidators.examined += 1
      const key = `${vote.fileId}\0${vote.cellId}\0${vote.audioId}`
      const laneId = takeLane.get(key)
      if (!laneId) {
        counts.audioValidators.unresolved += 1
        unresolvable.push({
          rule: "audioValidators",
          projectId: project.id,
          projectName: project.name,
          key: `${vote.fileId}/${vote.cellId}/${vote.audioId}/${vote.username}`,
          reason: laneId === null ? "the take's lane is unresolved" : "no audio take for this vote",
        })
        continue
      }
      const stored = noteStoredLane(vote.laneId, laneId)
      if (stored === "already") {
        counts.audioValidators.already += 1
        continue
      }
      if (stored === "conflict") {
        counts.audioValidators.unresolved += 1
        unresolvable.push({
          rule: "audioValidators",
          projectId: project.id,
          projectName: project.name,
          key: `${vote.fileId}/${vote.cellId}/${vote.audioId}/${vote.username}`,
          reason: `lane_id is already ${vote.laneId}, which is not the take's lane ${laneId}`,
        })
        continue
      }
      counts.audioValidators.filled += 1
      writes.push({
        table: "cell_audio_validators",
        projectId: project.id,
        fileId: vote.fileId,
        cellId: vote.cellId,
        audioId: vote.audioId,
        username: vote.username,
        laneId,
      })
    }

    for (const row of project.backtranslations) {
      counts.backtranslations.examined += 1
      const assigned = assignBacktranslation(project, row)
      const key = `${row.fileId}/${row.cellId}/${row.targetEventId}`
      if (!assigned.ok) {
        counts.backtranslations.unresolved += 1
        unresolvable.push({
          rule: "backtranslations",
          projectId: project.id,
          projectName: project.name,
          key,
          reason: assigned.reason,
        })
        continue
      }
      const stored = noteStoredLane(row.laneId, assigned.laneId)
      if (stored === "conflict") {
        counts.backtranslations.conflict += 1
        unresolvable.push({
          rule: "backtranslations",
          projectId: project.id,
          projectName: project.name,
          key,
          reason: `lane_id is already ${row.laneId}, which is not ${assigned.laneId}`,
        })
        continue
      }
      if (assigned.rule === "eventLaneId") counts.backtranslations.byRule.eventLaneId += 1
      else if (assigned.rule === "eventTargetLang") counts.backtranslations.byRule.eventTargetLang += 1
      else if (assigned.rule === "targetEvent") counts.backtranslations.byRule.targetEvent += 1
      else counts.backtranslations.byRule.emptyTag += 1
      if (stored === "already") {
        counts.backtranslations.already += 1
        continue
      }
      counts.backtranslations.filled += 1
      writes.push({
        table: "cell_backtranslations",
        projectId: project.id,
        fileId: row.fileId,
        cellId: row.cellId,
        targetEventId: row.targetEventId,
        laneId: assigned.laneId,
      })
    }

    const bridge = legacyEmptyLaneId(
      project.lanes.map((lane) => ({ id: lane.id, role: lane.role, legacyTag: lane.legacyTag })),
    )
    for (const concept of project.concepts) {
      counts.concepts.examined += 1
      const list = renderingList(concept.renderings)
      if (!list) {
        counts.concepts.unresolved += 1
        unresolvable.push({
          rule: "concepts",
          projectId: project.id,
          projectName: project.name,
          key: concept.conceptId,
          reason: "renderings are not a list of objects",
        })
        continue
      }
      const missing = list.some((item) => {
        const laneId = (item as { laneId?: unknown }).laneId
        return typeof laneId !== "string" || laneId === ""
      })
      if (!bridge && missing) {
        counts.concepts.unresolved += 1
        unresolvable.push({
          rule: "concepts",
          projectId: project.id,
          projectName: project.name,
          key: concept.conceptId,
          reason: "rendering has no laneId and the project has no target lane with legacy_tag ''",
        })
        continue
      }
      const stamped = stampRenderingLanes(list, bridge)
      if (JSON.stringify(stamped) === JSON.stringify(list)) {
        counts.concepts.already += 1
        continue
      }
      counts.concepts.restamped += 1
      writes.push({
        table: "concepts",
        projectId: project.id,
        conceptId: concept.conceptId,
        renderings: stamped,
      })
    }

    const source = sourceLane(project)
    const laneIds = new Set(project.lanes.map((lane) => lane.id))
    if (!source && project.files.length > 0) {
      unresolvable.push({
        rule: "progress",
        projectId: project.id,
        projectName: project.name,
        key: "source-lane",
        reason: "project has no source lane for source totals",
      })
    }
    const sourceFiles = new Set(
      project.progress
        .filter((row) => row.scope === "file" && row.sectionKey === "" && source && row.laneId === source.id)
        .map((row) => row.fileId),
    )
    for (const file of project.files) {
      counts.progress.filesToRecompute += 1
      progressFiles.push({ projectId: project.id, fileId: file.id })
      if (source && !sourceFiles.has(file.id)) counts.progress.filesMissingSourceRow += 1
    }
    for (const row of project.progress) {
      if (laneIds.has(row.laneId)) continue
      counts.progress.orphanRows += 1
      unresolvable.push({
        rule: "progress",
        projectId: project.id,
        projectName: project.name,
        key: `${row.fileId}/${row.scope}/${row.sectionKey}/${row.laneId}`,
        reason: "progress row's lane_id is not a lane of this project",
      })
    }
  }

  return {
    writes,
    progressFiles,
    report: {
      mode: "dry-run",
      counts,
      guessedLanguages,
      unresolvable,
      aqu1585: { disagreements, duplicateNames },
      scopeTags: { zero: scopeZero, two: scopeTwo },
    },
  }
}

function cell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ")
}

function countLines(counts: LaneBatchCounts): string[] {
  const lines: string[] = []
  const write = (title: string, rows: Record<string, number | Record<string, number>>) => {
    lines.push(`### ${title}`, "")
    for (const [key, value] of Object.entries(rows)) {
      if (value && typeof value === "object") {
        for (const [rule, count] of Object.entries(value)) lines.push(`- ${key}.${rule}: ${count}`)
      } else {
        lines.push(`- ${key}: ${value}`)
      }
    }
    lines.push("")
  }
  write("Lanes", counts.lanes)
  write("Member scopes", counts.scopes)
  write("Invites", counts.invites)
  write("Links", counts.links)
  write("Back-translations", counts.backtranslations)
  write("Audio", counts.audio)
  write("Audio validators", counts.audioValidators)
  write("Concepts", counts.concepts)
  write("Progress", counts.progress)
  return lines
}

/** Markdown the conductor reviews. Project names are included here on purpose. */
export function renderLaneBatchReport(report: LaneBatchReport): string {
  const lines = [
    "# Lane batch backfill",
    "",
    report.mode === "apply"
      ? "Apply. Writes run only after migrations 0138 and 0152 are on the target."
      : "Dry run. Nothing is written. An accidental write fails because the session is read-only.",
    "",
    "Events are not rewritten. Lane rows are not deleted. `lanes.legacy_tag` is not changed. `legacy_tag ''` stays the bridge.",
    "",
    "Progress apply recomputes each file with the existing progress projection, so source totals land on the source lane and no `''` row is manufactured.",
    "",
    "## Counts",
    "",
    ...countLines(report.counts),
    "## Guessed lane languages",
    "",
  ]
  if (report.guessedLanguages.length === 0) lines.push("None.", "")
  else {
    lines.push("| Project | Lane | Legacy tag | Name | Language | Reason |", "| --- | --- | --- | --- | --- | --- |")
    for (const row of report.guessedLanguages) {
      lines.push(
        `| ${cell(row.projectName)} | ${cell(row.laneId)} | ${cell(row.legacyTag)} | ${cell(row.name)} | ${cell(row.language)} | ${cell(row.reason)} |`,
      )
    }
    lines.push("")
  }
  lines.push("## Unresolvable rows", "")
  if (report.unresolvable.length === 0) lines.push("None.", "")
  else {
    lines.push("| Rule | Project | Key | Reason |", "| --- | --- | --- | --- |")
    for (const row of report.unresolvable) {
      lines.push(`| ${cell(row.rule)} | ${cell(row.projectName)} | ${cell(row.key)} | ${cell(row.reason)} |`)
    }
    lines.push("")
  }
  lines.push("## AQU-1585 name/code disagreements", "")
  if (report.aqu1585.disagreements.length === 0) lines.push("None. These are reported and not auto-fixed.", "")
  else {
    lines.push("Reported only. The backfill does not rename the lane or delete the duplicate.", "")
    lines.push("| Project | Lane | Name | lang_code | Derived code |", "| --- | --- | --- | --- | --- |")
    for (const row of report.aqu1585.disagreements) {
      lines.push(
        `| ${cell(row.projectName)} | ${cell(row.laneId)} | ${cell(row.name)} | ${cell(row.langCode)} | ${cell(row.derivedCode)} |`,
      )
    }
    lines.push("")
  }
  lines.push("## AQU-1585 duplicate names", "")
  if (report.aqu1585.duplicateNames.length === 0) lines.push("None.", "")
  else {
    lines.push("| Project | Name | Lanes |", "| --- | --- | --- |")
    for (const row of report.aqu1585.duplicateNames) {
      lines.push(`| ${cell(row.projectName)} | ${cell(row.name)} | ${cell(row.laneIds.join(", "))} |`)
    }
    lines.push("")
  }
  const scopeSection = (title: string, rows: ScopeTagMatch[]) => {
    lines.push(`## ${title}`, "")
    if (rows.length === 0) {
      lines.push("None.", "")
      return
    }
    lines.push("| Surface | Project | User | Value | Matches |", "| --- | --- | --- | --- | --- |")
    for (const row of rows) {
      lines.push(
        `| ${row.surface} | ${cell(row.projectName)} | ${cell(row.userId ?? "")} | ${cell(row.value)} | ${row.matches} |`,
      )
    }
    lines.push("")
  }
  scopeSection("Scope tags matching zero lanes", report.scopeTags.zero)
  scopeSection("Scope tags matching two lanes", report.scopeTags.two)
  return lines.join("\n")
}
