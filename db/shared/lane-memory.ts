// Per-lane Living Memory: the lane → project resolution every prompt reader
// shares (AQU-2348).
//
// A project's Living Memory is the DEFAULT for every language lane. A
// maintainer may customize one section for ONE lane, and that lane then owns
// its own copy; every other lane, and a project with a single lane, is
// untouched. Two shapes, chosen per section:
//
//   * OVERRIDE WITH FALLBACK for the prose sections — the default prediction
//     prompt (`settings.systemPrompt`) and the translation brief
//     (`settings.translationBrief`). A lane either inherits the project's
//     value or replaces it wholesale. Nothing is merged: half a project brief
//     spliced into half a lane brief is prose no reviewer can read, and the
//     point of the control is that the two lanes stop sharing.
//   * UNION for the authored entries (`settings.livingMemoryEntries`), which
//     are a LIST. A lane sees the project's entries plus its own, so adding a
//     lane note never silently drops the project's standards.
//
// Keying is `lanes.id` — the opaque 8-hex id (AQU-1240) — never the legacy
// tag, which is an event key a rename can strand. An ABSENT lane entry, and
// an absent map, mean "this lane inherits", which is what every project had
// before these keys existed: that is why no migration is needed to open a
// legacy project, and why `resolveLaneMemory` with no lane answers exactly
// what the project-wide readers answered before.
//
// Resolution order, everywhere: lane row → project row.
//
// This module is METADATA + PURE RESOLVERS/VALIDATORS ONLY — no DB, no React,
// no network — so the SPA's prompt builder, sync-worker's prompt preview and
// the PatchSettings validator all read the same rules and cannot drift apart
// (the AQU-1230 preview contract).

/** Which level a resolved section came from. */
export type LaneMemorySource = 'lane' | 'project'

/** A resolved section: the value in force, and where it came from. */
export interface LaneResolved<T> {
  value: T | undefined
  source: LaneMemorySource
}

/** An authored Living Memory entry, as far as lane resolution cares. */
export interface LaneScopedEntry {
  /** The lane that owns this entry. Absent/null = a project-wide entry. */
  laneId?: string | null
}

/** The settings keys lane memory reads. Structurally compatible with both
 *  `ProjectWideSettings` and the worker's loose settings blob. */
export interface LaneMemorySettings<Brief = Record<string, unknown>, Entry extends LaneScopedEntry = LaneScopedEntry> {
  systemPrompt?: string
  systemPromptByLane?: Record<string, string>
  translationBrief?: Brief
  translationBriefByLane?: Record<string, Brief>
  livingMemoryEntries?: readonly Entry[]
}

/** Everything a prompt reader needs for one lane, each part saying where it came from. */
export interface ResolvedLaneMemory<Brief = Record<string, unknown>, Entry extends LaneScopedEntry = LaneScopedEntry> {
  systemPrompt: LaneResolved<string>
  brief: LaneResolved<Brief>
  /** Project entries first, then this lane's own, each in stored order. */
  entries: Entry[]
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** True when `value` is the opaque lane-id shape (AQU-1240). A language never is. */
function isLaneIdKey(value: string): boolean {
  return /^[0-9a-f]{8}$/.test(value)
}

// ── resolution ──────────────────────────────────────────────────────────────

/**
 * One override-with-fallback section.
 *
 * `laneId === undefined` is a management surface asking for the project-wide
 * value (the `laneCheckOverrides` convention), so no lane entry is consulted
 * and the answer is `project`. A lane entry that exists wins even when it is
 * an empty string: "this lane deliberately has none" is a customization, not
 * an absence, and pruning it here would make the UI's Revert control a no-op.
 */
export function resolveLaneOverride<T>(
  projectValue: T | undefined,
  byLane: Readonly<Record<string, T>> | undefined,
  laneId: string | undefined,
): LaneResolved<T> {
  if (laneId !== undefined && byLane && Object.prototype.hasOwnProperty.call(byLane, laneId)) {
    return { value: byLane[laneId], source: 'lane' }
  }
  return { value: projectValue, source: 'project' }
}

/**
 * The authored entries in force in `laneId`: the project's (no `laneId`) plus
 * that lane's own. Another lane's entries never appear.
 *
 * `laneId === undefined` asks for the project-wide list, so lane-owned entries
 * are left out — a management surface showing "the project's instructions"
 * must not show one lane's.
 */
export function resolveLaneEntries<Entry extends LaneScopedEntry>(
  entries: readonly Entry[] | undefined,
  laneId: string | undefined,
): Entry[] {
  if (!entries) return []
  const project = entries.filter((entry) => entry.laneId == null)
  if (laneId === undefined) return project
  return [...project, ...entries.filter((entry) => entry.laneId === laneId)]
}

/**
 * Everything the copilot, Autopilot, the health checks and the Agent API's
 * prompt preview need for one lane. ONE resolver, so the preview cannot drift
 * from what the copilot actually sends.
 */
export function resolveLaneMemory<
  Brief = Record<string, unknown>,
  Entry extends LaneScopedEntry = LaneScopedEntry,
>(
  settings: LaneMemorySettings<Brief, Entry> | null | undefined,
  laneId: string | undefined,
): ResolvedLaneMemory<Brief, Entry> {
  return {
    systemPrompt: resolveLaneOverride(settings?.systemPrompt, settings?.systemPromptByLane, laneId),
    brief: resolveLaneOverride(settings?.translationBrief, settings?.translationBriefByLane, laneId),
    entries: resolveLaneEntries(settings?.livingMemoryEntries, laneId),
  }
}

/**
 * The TARGET lane id carrying `tag`, or undefined when no row does.
 *
 * Distinct from `laneIdForTag` (src/lib/lanes/active-lane-choice.ts), which
 * answers the same question for rows a caller has ALREADY filtered to target
 * lanes. This one takes the project's whole lane list — what a worker loads —
 * so it filters the source lane out itself.
 *
 * Event keys and the external `?targetLang=` are the lane's `legacy_tag`;
 * lane memory is keyed by `lanes.id`, so every reader holding a tag comes
 * through here. A lane tagged with its own id (the AQU-1418 bug case) matches
 * on the id too, so a caller holding either reaches the same row. A tag no row
 * carries resolves to no lane, which reads as "inherit" rather than an error:
 * a project whose lane rows have not arrived must still get a prompt.
 */
export function targetLaneIdForTag(
  tag: string,
  lanes: readonly { id: string; role: 'source' | 'target'; legacyTag?: string | null }[] | null | undefined,
): string | undefined {
  const targets = (lanes ?? []).filter((lane) => lane.role === 'target')
  const row = targets.find((lane) => (lane.legacyTag ?? '') === tag) ?? targets.find((lane) => lane.id === tag)
  return row?.id
}

// ── writers (customize / revert) ────────────────────────────────────────────

/**
 * The map to store when a maintainer customizes one section for one lane.
 * Writing the project's own value is still a customization — the lanes have
 * stopped sharing, which is the whole point of the control — so nothing is
 * pruned on the way in.
 */
export function withLaneMemoryValue<T>(
  stored: Readonly<Record<string, T>> | undefined,
  laneId: string,
  value: T,
): Record<string, T> {
  return { ...stored, [laneId]: value }
}

/**
 * The map to store on "Revert to project": the lane's copy is REMOVED, so the
 * lane reads the project value again. Returns undefined when that was the last
 * entry, so the key is deleted rather than left as `{}` — an empty map would
 * otherwise accumulate on every project that ever tried a lane override.
 */
export function withoutLaneMemoryValue<T>(
  stored: Readonly<Record<string, T>> | undefined,
  laneId: string,
): Record<string, T> | undefined {
  if (!stored || !Object.prototype.hasOwnProperty.call(stored, laneId)) return stored ?? undefined
  const next: Record<string, T> = {}
  for (const [key, value] of Object.entries(stored)) {
    if (key !== laneId) next[key] = value
  }
  return Object.keys(next).length === 0 ? undefined : next
}

// ── validators (PatchSettings / describe_command) ───────────────────────────

const LANE_KEY_RULE =
  "laneId: the target lane's opaque 8-hex id, as GET /api/v1/external/projects/:projectId returns it " +
  '(never a language or a legacy tag). An absent entry means that lane inherits the project value'

export const SYSTEM_PROMPT_BY_LANE_TYPE_NAME = `{ [laneId]: string } (${LANE_KEY_RULE})`

export const TRANSLATION_BRIEF_BY_LANE_TYPE_NAME = `{ [laneId]: object } (${LANE_KEY_RULE})`

function laneKeyProblem(key: string, where: string): string | null {
  if (!isLaneIdKey(key)) {
    return (
      `${where} names "${key}", which is not a lane id. Lane memory is keyed by the lane's ` +
      'opaque 8-hex id (GET /api/v1/external/projects/:projectId lists them), never by a language or a legacy tag'
    )
  }
  return null
}

export function systemPromptByLaneProblem(value: unknown): string | null {
  if (!isPlainObject(value)) return 'must be an object keyed by lane id'
  for (const [laneId, prompt] of Object.entries(value)) {
    const problem = laneKeyProblem(laneId, 'systemPromptByLane')
    if (problem) return problem
    if (typeof prompt !== 'string') return `systemPromptByLane["${laneId}"] must be a string`
  }
  return null
}

export function translationBriefByLaneProblem(value: unknown): string | null {
  if (!isPlainObject(value)) return 'must be an object keyed by lane id'
  for (const [laneId, brief] of Object.entries(value)) {
    const problem = laneKeyProblem(laneId, 'translationBriefByLane')
    if (problem) return problem
    if (!isPlainObject(brief)) return `translationBriefByLane["${laneId}"] must be a brief object`
  }
  return null
}

// ── lane-scoped ROWS (knowledge documents, style rules) ─────────────────────
//
// The settings sections above are VALUES a lane overrides. Knowledge documents
// and style rules are ROWS, so a lane does not override them — it ADDS to
// them: a row either belongs to the project (`lane_id IS NULL`) and is in
// force for every lane, or belongs to ONE lane and is in force only there.
// Union, for the same reason the authored entries union: dropping the
// project's reference documents the moment a lane gains its own would make
// adding one lane's glossary silently un-ground every other section.
//
// One rule, two forms — the SQL a retrieval query filters with and the
// predicate an in-memory list filters with — so the DB and the client cannot
// answer "is this row in force here?" differently.

/** A stored row that may belong to one lane. `null`/absent = project-wide. */
export interface LaneOwnedRow {
  laneId?: string | null
}

/** Is `rowLaneId` in force in `laneId`? A project-wide row always is. */
export function laneRowApplies(
  rowLaneId: string | null | undefined,
  laneId: string | undefined,
): boolean {
  if (rowLaneId == null || rowLaneId === '') return true
  return laneId !== undefined && rowLaneId === laneId
}

/**
 * The rows in force in `laneId`: the project's plus that lane's own, in the
 * order given. Another lane's rows never appear.
 *
 * `laneId === undefined` — no lane resolved, or a management surface asking
 * for the project-wide set — keeps only the project's rows, which is every row
 * a project had before lanes could own one.
 */
export function laneScopedRows<Row extends LaneOwnedRow>(
  rows: readonly Row[],
  laneId: string | undefined,
): Row[] {
  return rows.filter((row) => laneRowApplies(row.laneId, laneId))
}

/**
 * The same rule as SQL, for a retrieval query: a fragment to AND into a WHERE
 * clause plus the binds it consumes, in order.
 *
 * The empty string is treated as "project-wide" on the way out as well, so a
 * row written with `''` — which no writer should produce, but a hand-run SQL
 * fix might — reads as the project's rather than as a lane nobody can name.
 */
export function laneRowFilterSql(
  column: string,
  laneId: string | undefined,
): { sql: string; binds: string[] } {
  const projectWide = `(${column} IS NULL OR ${column} = '')`
  if (laneId === undefined) return { sql: projectWide, binds: [] }
  return { sql: `(${projectWide} OR ${column} = ?)`, binds: [laneId] }
}

/**
 * The lane a row may be written with, or a problem naming the rule.
 *
 * Shared by every writer that accepts a `laneId` so one message describes the
 * key: an org-owned row can never carry a lane (lane ids are project-local, so
 * a shared row keyed by one project's lane would be unreadable in the next),
 * and the key is the opaque 8-hex id, never a language or a legacy tag.
 */
export function laneOwnedRowProblem(
  laneId: string | null | undefined,
  opts: { orgOwned: boolean },
): string | null {
  if (laneId == null || laneId === '') return null
  if (opts.orgOwned) {
    return (
      'laneId cannot be set on an organization-wide row: lane ids belong to one project, so a ' +
      'shared row keyed by a lane would name a lane the next project does not have'
    )
  }
  return laneKeyProblem(laneId, 'laneId')
}
