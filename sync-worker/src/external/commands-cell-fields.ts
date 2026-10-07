// Cell-field commands (AQU-1183, parity epic AQU-1181 items 15/20) — the
// registry commands for cell state the UI can already write but no agent
// command could reach: the SOURCE side of a cell, its subtitle/audio timing,
// its transcript, and a file's timeline track overrides.
//
// This module owns the STATIC layer — the command shapes, hand validation
// (no zod, matching commands.ts), the role-floor arithmetic, and the
// deterministic normalization of a batch into the per-target ops a commit
// compiles. Live-state resolution (chain-head pins, existence, the dynamic
// timing-lock / track-editing gates) and the compile/commit engine live in
// cell-fields-engine.ts.
//
// WHY THESE FOUR SHARE A MODULE AND A CHANGESET PATH: they all write fields on
// an EXISTING cell or file, and two of them (SetSource, SetTranscription)
// compile to the SAME chain-mutating event kind. `source.cell.commit` is a
// head compare-and-swap (AD-2), so two of them addressing one cell in one
// changeset would compete for a single chain slot and the loser would be
// silently dropped as a stale sibling. Normalizing the batch here — one
// source.cell.commit per cell, carrying whichever of value/valueHtml/
// transcription the batch asked for — is what makes that unrepresentable.

import { REQUIRED_ROLE } from '../events/role-policy'
import { cellKey } from './cell-keys'
import type { ChangesetWarning } from './types'

/** Edit the SOURCE side of a cell — the text translators work from.
 *
 *  Compiles to `source.cell.commit`, which sits at PROJECT_LEAD in
 *  role-policy.ts — deliberately a higher floor than SetTranslation's
 *  CONTRIBUTOR, matching the UI's own source-edit floor. The commit advances
 *  the source chain head, so every target pinned to the old head goes stale by
 *  the ordinary AD-9 derivation (`source.event_id != target.source_event_id`)
 *  — exactly as a UI source edit does. Nothing here re-pins anything. */
export interface SetSourceCommand {
  kind: 'SetSource'
  fileId: string
  cellId: string
  value: string
  valueHtml?: string
}

/** Set a cell's `transcription` — the corrected transcript of an imported
 *  MEDIA section, whose `value` holds the import filename as provenance
 *  (AQU-847). Compiles to a TRANSCRIPT-ONLY `source.cell.commit` (no `value`
 *  in the payload), which the projection applies without blanking the
 *  filename. Same PROJECT_LEAD floor as SetSource — it is the same event. */
export interface SetTranscriptionCommand {
  kind: 'SetTranscription'
  fileId: string
  cellId: string
  transcription: string
}

/** Set a cell's span on the timeline and/or the file's audio timing mode.
 *
 *  `startMs`/`endMs` (both or neither) compile to `cell.retime`; `timingMode`
 *  compiles to `file.timing.set` for the whole file. They ride one command
 *  because they are one intent — "time this file the way I mean it" — but they
 *  carry DIFFERENT floors, so the command's floor is the max of the parts
 *  (see cellFieldsFloor). Fractional milliseconds are rejected here, at the
 *  boundary (AQU-927). */
export interface SetTimingCommand {
  kind: 'SetTiming'
  fileId: string
  /** Required when startMs/endMs are present; meaningless for timingMode. */
  cellId?: string
  startMs?: number
  endMs?: number
  /** null clears back to the project-level default. */
  timingMode?: 'dubbing' | 'audioFirst' | null
}

/** One timeline track's presentation delta, merged into
 *  `files.meta.trackOverrides[trackId]`. Compiles to `file.track.set`
 *  (MAINTAINER). `patch: null` deletes the entry; a null field inside a patch
 *  clears that single override. Restructuring patches additionally require the
 *  project's `allowTrackEditing` — a SECOND gate no clearance skips (see
 *  track-editing-authority.ts), mirrored at prepare so a plan the caller could
 *  never commit is refused rather than staged. */
export interface SetTrackOverrideCommand {
  kind: 'SetTrackOverride'
  fileId: string
  trackId: string
  patch: TrackPatch | null
}

/** Mirrors EventPayloads['file.track.set'].patch. */
export interface TrackPatch {
  kind?: 'source-subtitles' | 'source-audio' | 'target-subtitles' | 'target-audio' | 'folder' | 'audio'
  name?: string | null
  order?: number | null
  groupId?: string | null
  color?: string | null
  sourceTrackId?: string | null
}

export type CellFieldCommand =
  | SetSourceCommand
  | SetTranscriptionCommand
  | SetTimingCommand
  | SetTrackOverrideCommand

export const CELL_FIELD_KINDS: readonly CellFieldCommand['kind'][] = [
  'SetSource',
  'SetTranscription',
  'SetTiming',
  'SetTrackOverride',
] as const

const CELL_FIELD_KIND_SET = new Set<string>(CELL_FIELD_KINDS)

export function isCellFieldKind(kind: unknown): kind is CellFieldCommand['kind'] {
  return typeof kind === 'string' && CELL_FIELD_KIND_SET.has(kind)
}

/** Narrow a Command (or any tagged member of a wider union) to the cell-field
 *  family. Generic over the input union so `filter(isCellFieldCommand)` on
 *  `Command[]` yields `CellFieldCommand[]` without a cast. */
export function isCellFieldCommand<T extends { kind: string }>(
  c: T,
): c is Extract<T, CellFieldCommand> {
  return CELL_FIELD_KIND_SET.has(c.kind)
}

/** Hard cap on cell-field commands per changeset — one human-reviewable plan,
 *  matching EmitEvents' own ceiling. */
export const CELL_FIELDS_MAX_COMMANDS = 200

/** Mirrors the handler's allow-lists (handlers/file-track-set.ts) so an agent
 *  gets validation_failed at prepare instead of a per-event perimeter
 *  rejection buried in the receipt. The handler stays the backstop. */
const TRACK_PATCH_KEYS = new Set(['kind', 'name', 'order', 'groupId', 'color', 'sourceTrackId'])
const TRACK_KINDS = new Set([
  'source-subtitles',
  'source-audio',
  'target-subtitles',
  'target-audio',
  'folder',
  'audio',
])
const TRACK_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

const TIMING_MODES = new Set(['dubbing', 'audioFirst'])

export interface CellFieldValidationIssue {
  index: number
  message: string
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * AQU-927 at the API boundary: a millisecond field must be a finite INTEGER.
 *
 * The lesson that issue left is that a float must never travel — `start_ms` /
 * `end_ms` are BIGINT, Postgres refuses a fractional literal outright, and a
 * /events flush applies as ONE batch, so a single stray 2403.5 failed every
 * event beside it. The projection now rounds as a last line of defence, but an
 * API that silently rounded would hand an agent a cue boundary it did not ask
 * for and no way to notice. So this surface REJECTS, with the offending value
 * in the message — the agent re-sends the integer it meant.
 */
export function integerMsIssue(field: string, value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return `${field} must be a finite number of milliseconds`
  }
  if (!Number.isInteger(value)) {
    return `${field} must be an INTEGER number of milliseconds (got ${value}) — milliseconds are stored as BIGINT; round before sending`
  }
  if (value < 0) return `${field} must be >= 0`
  return null
}

/** Validate one raw cell-field command. Returns the typed command, or null
 *  after pushing issues (mirrors validatePatchSettingsCommand's contract). */
export function validateCellFieldCommand(
  c: Record<string, unknown>,
  index: number,
  issues: CellFieldValidationIssue[],
): CellFieldCommand | null {
  const fail = (message: string): null => {
    issues.push({ index, message })
    return null
  }

  if (c.kind === 'SetSource') {
    if (!isNonEmptyString(c.fileId)) return fail('SetSource.fileId must be a non-empty string')
    if (!isNonEmptyString(c.cellId)) return fail('SetSource.cellId must be a non-empty string')
    if (typeof c.value !== 'string') return fail('SetSource.value must be a string')
    if (c.valueHtml !== undefined && typeof c.valueHtml !== 'string') {
      return fail('SetSource.valueHtml must be a string when present')
    }
    return {
      kind: 'SetSource',
      fileId: c.fileId,
      cellId: c.cellId,
      value: c.value,
      ...(c.valueHtml !== undefined ? { valueHtml: c.valueHtml } : {}),
    }
  }

  if (c.kind === 'SetTranscription') {
    if (!isNonEmptyString(c.fileId)) return fail('SetTranscription.fileId must be a non-empty string')
    if (!isNonEmptyString(c.cellId)) return fail('SetTranscription.cellId must be a non-empty string')
    if (typeof c.transcription !== 'string') return fail('SetTranscription.transcription must be a string')
    return {
      kind: 'SetTranscription',
      fileId: c.fileId,
      cellId: c.cellId,
      transcription: c.transcription,
    }
  }

  if (c.kind === 'SetTiming') {
    if (!isNonEmptyString(c.fileId)) return fail('SetTiming.fileId must be a non-empty string')
    const hasSpan = c.startMs !== undefined || c.endMs !== undefined
    const hasMode = c.timingMode !== undefined
    if (!hasSpan && !hasMode) {
      return fail('SetTiming must carry startMs+endMs, timingMode, or both')
    }
    if (hasSpan) {
      if (c.startMs === undefined || c.endMs === undefined) {
        return fail('SetTiming.startMs and SetTiming.endMs must be provided together')
      }
      if (!isNonEmptyString(c.cellId)) {
        return fail('SetTiming.cellId must be a non-empty string when retiming a cell')
      }
      const startIssue = integerMsIssue('SetTiming.startMs', c.startMs)
      if (startIssue) return fail(startIssue)
      const endIssue = integerMsIssue('SetTiming.endMs', c.endMs)
      if (endIssue) return fail(endIssue)
      if ((c.endMs as number) < (c.startMs as number)) {
        return fail('SetTiming.endMs must be >= SetTiming.startMs')
      }
    }
    if (hasMode && c.timingMode !== null && !TIMING_MODES.has(c.timingMode as string)) {
      return fail(`SetTiming.timingMode must be "dubbing", "audioFirst", or null`)
    }
    return {
      kind: 'SetTiming',
      fileId: c.fileId,
      ...(hasSpan
        ? {
            cellId: c.cellId as string,
            startMs: c.startMs as number,
            endMs: c.endMs as number,
          }
        : {}),
      ...(hasMode ? { timingMode: c.timingMode as 'dubbing' | 'audioFirst' | null } : {}),
    }
  }

  if (c.kind === 'SetTrackOverride') {
    if (!isNonEmptyString(c.fileId)) return fail('SetTrackOverride.fileId must be a non-empty string')
    if (!isNonEmptyString(c.trackId) || !TRACK_ID_PATTERN.test(c.trackId)) {
      return fail('SetTrackOverride.trackId must match /^[A-Za-z0-9_-]{1,64}$/')
    }
    if (c.patch === undefined) {
      return fail('SetTrackOverride.patch must be an object or null (null deletes the override)')
    }
    if (c.patch === null) {
      return { kind: 'SetTrackOverride', fileId: c.fileId, trackId: c.trackId, patch: null }
    }
    if (!isPlainObject(c.patch)) {
      return fail('SetTrackOverride.patch must be an object or null')
    }
    const raw = c.patch
    const keys = Object.keys(raw)
    if (keys.length === 0) return fail('SetTrackOverride.patch must not be empty')
    for (const key of keys) {
      if (!TRACK_PATCH_KEYS.has(key)) {
        return fail(`SetTrackOverride.patch has an unknown key: ${key}`)
      }
    }
    if (raw.kind !== undefined && !TRACK_KINDS.has(raw.kind as string)) {
      return fail(`SetTrackOverride.patch.kind must be one of ${[...TRACK_KINDS].join(', ')}`)
    }
    for (const key of ['name', 'groupId', 'color', 'sourceTrackId'] as const) {
      if (raw[key] !== undefined && raw[key] !== null && typeof raw[key] !== 'string') {
        return fail(`SetTrackOverride.patch.${key} must be a string or null when present`)
      }
    }
    if (raw.order !== undefined && raw.order !== null) {
      if (typeof raw.order !== 'number' || !Number.isFinite(raw.order)) {
        return fail('SetTrackOverride.patch.order must be a finite number or null when present')
      }
    }
    const patch: TrackPatch = {
      ...(raw.kind !== undefined ? { kind: raw.kind as TrackPatch['kind'] } : {}),
      ...(raw.name !== undefined ? { name: raw.name as string | null } : {}),
      ...(raw.order !== undefined ? { order: raw.order as number | null } : {}),
      ...(raw.groupId !== undefined ? { groupId: raw.groupId as string | null } : {}),
      ...(raw.color !== undefined ? { color: raw.color as string | null } : {}),
      ...(raw.sourceTrackId !== undefined ? { sourceTrackId: raw.sourceTrackId as string | null } : {}),
    }
    return { kind: 'SetTrackOverride', fileId: c.fileId, trackId: c.trackId, patch }
  }

  return fail(`unsupported cell-field command kind: ${String(c.kind)}`)
}

/**
 * Static role floor for one cell-field command — the SAME floor its compiled
 * event(s) hit at the /events perimeter, read from role-policy.ts.
 *
 * SetSource/SetTranscription → source.cell.commit (PROJECT_LEAD 500), a rung
 * above SetTranslation's target.cell.commit (CONTRIBUTOR 400), as the issue
 * requires and as the UI's own source-edit floor already is.
 *
 * SetTiming is the max of the parts it carries: cell.retime is CONTRIBUTOR,
 * file.timing.set is MAINTAINER, so a command doing both is a maintainer's.
 * The DYNAMIC timing-lock bump (locked project → MAINTAINER for a retime) is
 * a live-state question and lives in the engine, not here.
 */
export function cellFieldsFloor(c: CellFieldCommand): number {
  switch (c.kind) {
    case 'SetSource':
    case 'SetTranscription':
      return REQUIRED_ROLE['source.cell.commit']
    case 'SetTiming': {
      let floor = 0
      if (c.startMs !== undefined) floor = Math.max(floor, REQUIRED_ROLE['cell.retime'])
      if (c.timingMode !== undefined) floor = Math.max(floor, REQUIRED_ROLE['file.timing.set'])
      return floor
    }
    case 'SetTrackOverride':
      return REQUIRED_ROLE['file.track.set']
  }
}

/** Max floor across a batch. */
export function cellFieldsBatchFloor(cmds: readonly CellFieldCommand[]): number {
  let floor = 0
  for (const c of cmds) floor = Math.max(floor, cellFieldsFloor(c))
  return floor
}

/** One normalized source-side write: at most ONE per cell, per the chain-slot
 *  rule in this module's header. */
export interface PlannedSourceCommit {
  fileId: string
  cellId: string
  value?: string
  valueHtml?: string
  transcription?: string
}

export interface PlannedRetime {
  fileId: string
  cellId: string
  startMs: number
  endMs: number
}

export interface PlannedTimingMode {
  fileId: string
  timingMode: 'dubbing' | 'audioFirst' | null
}

export interface PlannedTrackOverride {
  fileId: string
  trackId: string
  patch: TrackPatch | null
}

/** The batch, normalized into the per-target ops a commit compiles. */
export interface CellFieldPlan {
  sourceCommits: PlannedSourceCommit[]
  retimes: PlannedRetime[]
  timingModes: PlannedTimingMode[]
  trackOverrides: PlannedTrackOverride[]
  warnings: ChangesetWarning[]
}

/** In-memory join key for a (file, cell) or (file, track) target. cellKey's NUL
 *  separator is fine as a Map key — it never becomes a jsonb object key. */
const targetKey = cellKey

/**
 * Normalize a validated batch into its per-target ops.
 *
 * PURE AND DETERMINISTIC ON PURPOSE: prepare runs it to compute the effect
 * summary and mint the prepare-time event ids, and commit runs it AGAIN over
 * the stored commands to compile. Same input, same output, same order — which
 * is what makes the two id ledgers line up index-for-index on a crash-retry.
 * Order within each bucket is first-seen; later writes to the same target
 * merge over earlier ones (last wins) and raise a duplicate warning, never a
 * silent drop.
 */
export function planCellFields(cmds: readonly CellFieldCommand[]): CellFieldPlan {
  const warnings: ChangesetWarning[] = []
  const sourceCommits = new Map<string, PlannedSourceCommit>()
  const retimes = new Map<string, PlannedRetime>()
  const timingModes = new Map<string, PlannedTimingMode>()
  const trackOverrides = new Map<string, PlannedTrackOverride>()

  const duplicate = (fileId: string, cellId: string, message: string): void => {
    warnings.push({ code: 'duplicate_command', fileId, cellId, message })
  }

  for (const c of cmds) {
    if (c.kind === 'SetSource' || c.kind === 'SetTranscription') {
      const key = targetKey(c.fileId, c.cellId)
      const existing = sourceCommits.get(key)
      const patch: PlannedSourceCommit =
        c.kind === 'SetSource'
          ? {
              fileId: c.fileId,
              cellId: c.cellId,
              value: c.value,
              ...(c.valueHtml !== undefined ? { valueHtml: c.valueHtml } : {}),
            }
          : { fileId: c.fileId, cellId: c.cellId, transcription: c.transcription }
      if (existing) {
        // Overlapping FIELDS are last-wins and warned; disjoint fields (a
        // SetSource plus a SetTranscription on one cell) simply merge — they
        // are one source.cell.commit either way, so there is no conflict to
        // report and nothing is dropped.
        const overlap = Object.keys(patch).some(
          (k) => k !== 'fileId' && k !== 'cellId' && k in existing,
        )
        if (overlap) {
          duplicate(c.fileId, c.cellId, 'duplicate source-side write for this cell — later one supersedes the earlier')
        }
        sourceCommits.set(key, { ...existing, ...patch })
      } else {
        sourceCommits.set(key, patch)
      }
      continue
    }

    if (c.kind === 'SetTiming') {
      if (c.startMs !== undefined && c.endMs !== undefined && c.cellId) {
        const key = targetKey(c.fileId, c.cellId)
        if (retimes.has(key)) {
          duplicate(c.fileId, c.cellId, 'duplicate retime for this cell — later one supersedes the earlier')
        }
        retimes.set(key, { fileId: c.fileId, cellId: c.cellId, startMs: c.startMs, endMs: c.endMs })
      }
      if (c.timingMode !== undefined) {
        if (timingModes.has(c.fileId)) {
          duplicate(c.fileId, '', 'duplicate timingMode for this file — later one supersedes the earlier')
        }
        timingModes.set(c.fileId, { fileId: c.fileId, timingMode: c.timingMode })
      }
      continue
    }

    const key = targetKey(c.fileId, c.trackId)
    if (trackOverrides.has(key)) {
      duplicate(c.fileId, '', `duplicate track override for track ${c.trackId} — later one supersedes the earlier`)
    }
    trackOverrides.set(key, { fileId: c.fileId, trackId: c.trackId, patch: c.patch })
  }

  return {
    sourceCommits: [...sourceCommits.values()],
    retimes: [...retimes.values()],
    timingModes: [...timingModes.values()],
    trackOverrides: [...trackOverrides.values()],
    warnings,
  }
}
