/**
 * High-level helpers for producing AD-2-shape events and enqueuing them
 * into the outbox. Surface for Phase 2c-α writers — the editor commit path,
 * the importer (2c-β), and cell action helpers.
 *
 * Why this lives separately from `outbox.ts`: `outbox.ts` is the
 * persistence + listener layer (pure IDB plumbing). This module is the
 * "give me a typed event for this user action" layer. Tests use the
 * outbox API directly; UI hooks/components use these helpers.
 *
 * The legacy `cqrs-bridge.ts` is the Y.Doc-coupled equivalent. It still
 * works during 2c-α (Y.Doc remains the load path for cells); 2c-β will
 * delete it once the editor is rewritten to read from the cells projection
 * directly.
 */

import { v7 as uuidv7 } from "uuid"
import { enqueueOutboxEvent } from "./outbox"
import { getCqrsOutboxBridge } from "./cqrs-bridge"
import { canPerform, requiredRoleFor, ROLE } from "./role-policy"
import {
  OUTBOX_SCHEMA_VERSION,
  type OutboxEventKind,
  type OutboxPayloadFor,
  type OutboxRawEvent,
  isGenesisKind,
} from "./outbox-types"
import posthog from "@/lib/posthog"
import { FIRST_CELL_COMMIT, FIRST_CELL_VALIDATE } from "@/lib/analytics-events"

// Session-scoped flags — reset on page reload (true "first in session" semantics).
let _firstCommitFired = false
let _firstValidateFired = false

// ── Envelope construction ─────────────────────────────────────────────────

export interface BuildEventInput<K extends OutboxEventKind> {
  kind: K
  projectId: string
  fileId?: string
  cellId?: string
  /** Required for chain-mutating non-genesis kinds. Pass `null` for genesis. */
  parentId?: string | null
  author: string
  payload: OutboxPayloadFor<K>
  clientTs?: number
  /** Pre-generated UUIDv7. Defaults to a fresh one. Exposed for tests + idempotency. */
  id?: string
}

/**
 * Build a raw event envelope. Validates that genesis kinds have a null
 * `parentId` — that's a hard rule on the client side (the server's projection
 * UPSERT guard reads parentId, and a non-null parent on a `*.create` is a
 * programmer error).
 *
 * Non-genesis chain-mutating kinds *should* carry a parentId in practice,
 * but we don't enforce it client-side — there are valid transient states
 * (the very first target.cell.commit on a cell whose target row hasn't been
 * projected locally yet, the importer's chained commits within a single
 * transaction before any have round-tripped to D1, etc.). The server's
 * parent-chain guard is authoritative; a wrong client-side parentId
 * surfaces as a stale-sibling broadcast and the outbox dead-letters.
 */
export function buildRawEvent<K extends OutboxEventKind>(
  input: BuildEventInput<K>,
): OutboxRawEvent<K> {
  const id = input.id ?? uuidv7()
  const clientTs = input.clientTs ?? Date.now()
  const parentId = input.parentId ?? null

  if (isGenesisKind(input.kind) && parentId !== null) {
    throw new Error(
      `buildRawEvent: kind "${input.kind}" is genesis; parentId must be null`,
    )
  }

  const envelope: OutboxRawEvent<K> = {
    id,
    schemaVersion: OUTBOX_SCHEMA_VERSION,
    kind: input.kind,
    projectId: input.projectId,
    ...(input.fileId ? { fileId: input.fileId } : {}),
    ...(input.cellId ? { cellId: input.cellId } : {}),
    parentId,
    author: input.author,
    payload: input.payload,
    clientTs,
  }
  return envelope
}

/**
 * Build the envelope, enqueue it, and return the event id. The id is the
 * caller's handle for chaining (subsequent events on the same cell pass
 * this id as `parentId`).
 *
 * Optimistic projection updates (the "advance local useCells row before the
 * server acks") are the responsibility of the caller — they need to know
 * which row to update and how. See the editor's commit handler.
 */
/** Thrown by enqueueEvent when the signed-in user's known role is below the
 *  server's requirement for this event kind. Caught by the emit helpers'
 *  existing `.catch` handlers, which surface it to the user. Failing here (at
 *  the source) prevents a guaranteed-403 from entering the durable outbox and
 *  head-of-line blocking the queue. */
export class InsufficientRoleError extends Error {
  kind: string
  roleLevel: number
  required: number
  // Explicit field assignment (not constructor parameter properties) — the
  // app tsconfig sets `erasableSyntaxOnly`, which forbids `public x` params.
  constructor(kind: string, roleLevel: number, required: number) {
    super(`role ${roleLevel} below required ${required} for ${kind}`)
    this.kind = kind
    this.roleLevel = roleLevel
    this.required = required
    this.name = "InsufficientRoleError"
  }
}

export async function enqueueEvent<K extends OutboxEventKind>(
  input: BuildEventInput<K>,
): Promise<{ event: OutboxRawEvent<K>; eventId: string }> {
  // Pre-enqueue role gate (client mirror of the server's authorize() check).
  // Only blocks when the role is KNOWN and provably insufficient — otherwise
  // fail open and let the server stay authoritative.
  const roleLevel = getCqrsOutboxBridge()?.roleLevel ?? null
  if (!canPerform(input.kind, roleLevel) && roleLevel != null) {
    throw new InsufficientRoleError(input.kind, roleLevel, requiredRoleFor(input.kind) ?? 0)
  }
  const event = buildRawEvent(input)
  // The legacy outbox accepts CqrsRawEvent; our OutboxRawEvent is a superset
  // (added parentId, prefixed kinds). The IDB serialization keeps unknown
  // fields, so write through with a structural cast.
  await enqueueOutboxEvent(
    event as unknown as Parameters<typeof enqueueOutboxEvent>[0],
  )
  return { event, eventId: event.id }
}

// ── Convenience builders for common writer flows ──────────────────────────

export interface CellCommitInput {
  projectId: string
  fileId: string
  cellId: string
  /** Current chain-head event_id for this cell row (from `cells.event_id`). */
  parentId: string | null
  /** AD-9 staleness pin: source row's `event_id`. Null for target-owned cells. */
  sourceEventId?: string | null
  value: string
  valueHtml?: string
  author: string
  clientTs?: number
  /** When true, tags the payload with `ai_suggestion: true` to record
   *  `cell.commit.llm-accept` provenance. Normal (human-typed) commits
   *  omit this field entirely — the generic commit path is unaffected. */
  aiSuggestion?: boolean
  /**
   * FRO-177: audit metadata for replace-all operations. Records the find and
   * replace strings so the per-cell history drawer can show the replace context.
   */
  searchQuery?: string
  replaceString?: string
}

/**
 * Emit a `target.cell.commit` event — translator-side commit on blur, idle,
 * or lock release. The caller supplies the current chain head; the returned
 * eventId becomes the next parent for follow-up commits.
 */
export async function emitTargetCellCommit(
  input: CellCommitInput,
): Promise<string> {
  // FRO-267: once-per-session first-commit funnel event.
  if (!_firstCommitFired) {
    _firstCommitFired = true
    posthog.capture(FIRST_CELL_COMMIT, {
      project_id: input.projectId,
      file_id: input.fileId,
      ai_suggestion: input.aiSuggestion ?? false,
    })
  }
  const parentId = input.parentId
  // A first-time commit on a cell that has never been written before is a
  // genesis target write — but in our model, the cell came from the source
  // side first, so even the first target.cell.commit has a chain head (the
  // source.cell.create or the most recent source.cell.commit). If parentId
  // is null here, it means the local read-model row has never been written
  // to; we fall back to genesis semantics rather than failing — the server
  // will reject with a 409 if it disagrees, and the outbox will dead-letter.
  //
  // Once we wire useCells against `cells.event_id` (2c-β), parentId is
  // always concrete here.
  const { eventId } = await enqueueEvent({
    kind: "target.cell.commit",
    projectId: input.projectId,
    fileId: input.fileId,
    cellId: input.cellId,
    parentId: parentId ?? null,
    author: input.author,
    payload: {
      value: input.value,
      ...(input.valueHtml !== undefined ? { valueHtml: input.valueHtml } : {}),
      ...(input.sourceEventId !== undefined
        ? { sourceEventId: input.sourceEventId }
        : {}),
      ...(input.aiSuggestion ? { ai_suggestion: true } : {}),
      ...(input.searchQuery !== undefined ? { search_query: input.searchQuery } : {}),
      ...(input.replaceString !== undefined ? { replace_string: input.replaceString } : {}),
    },
    clientTs: input.clientTs,
  })
  return eventId
}

export interface CellValidateInput {
  projectId: string
  fileId: string
  cellId: string
  /** The target.cell.commit (or target.cell.create) event being validated. */
  editEventId: string
  author: string
  clientTs?: number
}

/**
 * Emit a `cell.validate` event. Validation events don't compete for the
 * chain head — the server's projection treats them as additive (write to
 * `cell_validators`), so parentId is omitted.
 */
export async function emitCellValidate(input: CellValidateInput): Promise<string> {
  // FRO-267: once-per-session first-validate funnel event.
  if (!_firstValidateFired) {
    _firstValidateFired = true
    posthog.capture(FIRST_CELL_VALIDATE, {
      project_id: input.projectId,
      file_id: input.fileId,
    })
  }
  const { eventId } = await enqueueEvent({
    kind: "cell.validate",
    projectId: input.projectId,
    fileId: input.fileId,
    cellId: input.cellId,
    parentId: null,
    author: input.author,
    payload: { editEventId: input.editEventId },
    clientTs: input.clientTs,
  })
  return eventId
}

/** Mirror of `emitCellValidate` for the un-validate gesture. */
export async function emitCellUnvalidate(input: CellValidateInput): Promise<string> {
  const { eventId } = await enqueueEvent({
    kind: "cell.unvalidate",
    projectId: input.projectId,
    fileId: input.fileId,
    cellId: input.cellId,
    parentId: null,
    author: input.author,
    payload: { editEventId: input.editEventId },
    clientTs: input.clientTs,
  })
  return eventId
}

// ── Cell waiver helpers ───────────────────────────────────────────────────
// Non-chain-mutating (parentId omitted), like validation. A waiver dismisses
// one QA rule's infraction on a cell; the projection keys on (cell, ruleId).

export interface CellWaiveInput {
  projectId: string
  fileId: string
  cellId: string
  /** Stable id of the QA rule whose infraction is being dismissed. */
  ruleId: string
  /** Optional human-entered justification. */
  reason?: string
  author: string
  clientTs?: number
}

/** Emit a `cell.waive` event — dismiss a QA rule infraction on a cell. */
export async function emitCellWaive(input: CellWaiveInput): Promise<string> {
  const { eventId } = await enqueueEvent({
    kind: "cell.waive",
    projectId: input.projectId,
    fileId: input.fileId,
    cellId: input.cellId,
    parentId: null,
    author: input.author,
    payload: {
      ruleId: input.ruleId,
      ...(input.reason ? { reason: input.reason } : {}),
    },
    clientTs: input.clientTs,
  })
  return eventId
}

export interface CellUnwaiveInput {
  projectId: string
  fileId: string
  cellId: string
  ruleId: string
  author: string
  clientTs?: number
}

/** Mirror of `emitCellWaive` for the un-waive gesture. */
export async function emitCellUnwaive(input: CellUnwaiveInput): Promise<string> {
  const { eventId } = await enqueueEvent({
    kind: "cell.unwaive",
    projectId: input.projectId,
    fileId: input.fileId,
    cellId: input.cellId,
    parentId: null,
    author: input.author,
    payload: { ruleId: input.ruleId },
    clientTs: input.clientTs,
  })
  return eventId
}

// ── Cell audio helpers ────────────────────────────────────────────────────
// Non-chain-mutating (parentId omitted), like validation. Bytes are uploaded
// to R2 first (uploadCellAudio / the voice-convert worker), then the attach
// event records the metadata + selects the clip in its slot.

export interface CellAudioAttachInput {
  projectId: string
  fileId: string
  cellId: string
  audioId: string
  url: string
  slot: "recording" | "generatedVoice"
  mimeType?: string
  voiceId?: string
  referenceAudioId?: string
  durationMs?: number
  /** Non-destructive playback trim window into the clip, in ms. */
  trimStartMs?: number
  trimEndMs?: number
  timings?: { word: string; t0: number; t1: number; start: number; end: number }[]
  author: string
  clientTs?: number
}

/** Emit a `cell.audio.attach` — records a clip and selects it in its slot. */
export async function emitCellAudioAttach(input: CellAudioAttachInput): Promise<string> {
  const { eventId } = await enqueueEvent({
    kind: "cell.audio.attach",
    projectId: input.projectId,
    fileId: input.fileId,
    cellId: input.cellId,
    parentId: null,
    author: input.author,
    payload: {
      audioId: input.audioId,
      url: input.url,
      slot: input.slot,
      ...(input.mimeType !== undefined ? { mimeType: input.mimeType } : {}),
      ...(input.voiceId !== undefined ? { voiceId: input.voiceId } : {}),
      ...(input.referenceAudioId !== undefined ? { referenceAudioId: input.referenceAudioId } : {}),
      ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
      ...(input.trimStartMs !== undefined ? { trimStartMs: input.trimStartMs } : {}),
      ...(input.trimEndMs !== undefined ? { trimEndMs: input.trimEndMs } : {}),
      ...(input.timings !== undefined ? { timings: input.timings } : {}),
    },
    clientTs: input.clientTs,
  })
  return eventId
}

export interface CellAudioSelectInput {
  projectId: string
  fileId: string
  cellId: string
  audioId: string
  slot: "recording" | "generatedVoice"
  author: string
  clientTs?: number
}

/** Emit a `cell.audio.select` — switch the active clip within a slot. */
export async function emitCellAudioSelect(input: CellAudioSelectInput): Promise<string> {
  const { eventId } = await enqueueEvent({
    kind: "cell.audio.select",
    projectId: input.projectId,
    fileId: input.fileId,
    cellId: input.cellId,
    parentId: null,
    author: input.author,
    payload: { audioId: input.audioId, slot: input.slot },
    clientTs: input.clientTs,
  })
  return eventId
}

export interface CellAudioRemoveInput {
  projectId: string
  fileId: string
  cellId: string
  audioId: string
  author: string
  clientTs?: number
}

/** Emit a `cell.audio.remove` — soft-delete + deselect a clip. */
export async function emitCellAudioRemove(input: CellAudioRemoveInput): Promise<string> {
  const { eventId } = await enqueueEvent({
    kind: "cell.audio.remove",
    projectId: input.projectId,
    fileId: input.fileId,
    cellId: input.cellId,
    parentId: null,
    author: input.author,
    payload: { audioId: input.audioId },
    clientTs: input.clientTs,
  })
  return eventId
}

// ── Back-translation helper ───────────────────────────────────────────────

export interface CellBacktranslationSetInput {
  projectId: string
  fileId: string
  cellId: string
  btText: string
  btHtml?: string
  /** The target.cell.commit event_id this BT describes. */
  targetEventId: string
  polished: boolean
  author: string
  clientTs?: number
}

/**
 * Emit a `cell.backtranslation.set` event — non-chain-mutating (parentId
 * omitted). The payload pins the BT to a specific `targetEventId` so the
 * client can detect staleness when the target cell is later edited.
 */
export async function emitCellBacktranslationSet(
  input: CellBacktranslationSetInput,
): Promise<string> {
  const { eventId } = await enqueueEvent({
    kind: "cell.backtranslation.set",
    projectId: input.projectId,
    fileId: input.fileId,
    cellId: input.cellId,
    parentId: null,
    author: input.author,
    payload: {
      btText: input.btText,
      ...(input.btHtml !== undefined ? { btHtml: input.btHtml } : {}),
      targetEventId: input.targetEventId,
      polished: input.polished,
    },
    clientTs: input.clientTs,
  })
  return eventId
}

// ── Harmonize helper (FRO-186) ────────────────────────────────────────────
// Emits a `target.cell.commit` with a `harmonize_origin` payload field —
// the `cell.commit.harmonize` variant per AD-2. Using a payload field (not
// a new event kind) mirrors how `ai_suggestion` tags the llm-accept variant
// and how `search_query` tags the replace-all variant
// (FRO-177). The server reads `harmonize_origin` to trigger the AD-14
// endorsement-revocation cascade; the projector otherwise treats the commit
// identically to a human commit (chain-mutating, advances cells.event_id).

export interface CellHarmonizeInput {
  projectId: string
  fileId: string
  cellId: string
  /** Current chain-head event_id for this cell row. */
  parentId: string | null
  /** AD-9 staleness pin. */
  sourceEventId?: string | null
  value: string
  valueHtml?: string
  author: string
  /** Stable id of the check or rule that drove the sweep. */
  ruleOrCheckId: string
  /** How the replacement was computed. */
  proposalKind: "cached-regex" | "batch-regex" | "per-cell"
  /** Optional sweep-session linkage. */
  parentProposalId?: string
  clientTs?: number
}

/**
 * Client-side harmonize role gate. Returns true iff the current user's known
 * role meets the effective harmonize floor (PROJECT_LEAD 500 by default,
 * configurable up via harmonize_min_role project setting).
 *
 * Fails open when role is unknown (bridge unset) — server is authoritative.
 */
export function canHarmonize(
  harmonizeMinRole?: "project_lead" | "maintainer",
): boolean {
  const roleLevel = getCqrsOutboxBridge()?.roleLevel ?? null
  if (roleLevel == null) return true
  const floorMap: Record<string, number> = {
    project_lead: ROLE.PROJECT_LEAD,
    maintainer: ROLE.MAINTAINER,
  }
  const floor = floorMap[harmonizeMinRole ?? "project_lead"] ?? ROLE.PROJECT_LEAD
  return roleLevel >= floor
}

/**
 * Emit a `target.cell.commit` tagged as a harmonize sweep (`harmonize_origin`
 * payload field = the `cell.commit.harmonize` variant per AD-2).
 * The server enforces `harmonize_min_role` (project_lead 500 floor) before
 * accepting. Client-side gate: PROJECT_LEAD minimum (configurable up).
 */
export async function emitCellHarmonize(
  input: CellHarmonizeInput,
  harmonizeMinRole?: "project_lead" | "maintainer",
): Promise<string> {
  // Client-side harmonize role gate (mirrors server enforcement).
  const roleLevel = getCqrsOutboxBridge()?.roleLevel ?? null
  if (roleLevel != null) {
    const floorMap: Record<string, number> = {
      project_lead: ROLE.PROJECT_LEAD,
      maintainer: ROLE.MAINTAINER,
    }
    const floor = floorMap[harmonizeMinRole ?? "project_lead"] ?? ROLE.PROJECT_LEAD
    if (roleLevel < floor) {
      throw new InsufficientRoleError("target.cell.commit[harmonize]", roleLevel, floor)
    }
  }

  const { eventId } = await enqueueEvent({
    kind: "target.cell.commit",
    projectId: input.projectId,
    fileId: input.fileId,
    cellId: input.cellId,
    parentId: input.parentId ?? null,
    author: input.author,
    payload: {
      value: input.value,
      ...(input.valueHtml !== undefined ? { valueHtml: input.valueHtml } : {}),
      ...(input.sourceEventId !== undefined ? { sourceEventId: input.sourceEventId } : {}),
      harmonize_origin: {
        rule_or_check_id: input.ruleOrCheckId,
        proposal_kind: input.proposalKind,
        ...(input.parentProposalId !== undefined ? { parent_proposal_id: input.parentProposalId } : {}),
      },
    },
    clientTs: input.clientTs,
  })
  return eventId
}

// ── Importer helpers (consumed by Phase 2c-β `import.ts` rewrite) ─────────

export interface SourceCellCreateInput {
  projectId: string
  fileId: string
  cellId: string
  anchorCellId: string | null
  value: string
  valueHtml?: string
  type?: string
  canonicalRef?: string
  metadata?: Record<string, unknown>
  startMs?: number
  endMs?: number
  // Timeline-segment-model (Scope A) — segment metadata, set at create.
  medium?: string
  sequenceIndex?: number
  transcription?: string
  cameraState?: string
  /** Authorship — the admin/importer-bot user. */
  author: string
  clientTs?: number
}

/**
 * Emit a `source.cell.create` event. Always genesis (`parentId = null`).
 * The importer chains cells by passing the previous cell's `cellId` as
 * `anchorCellId`; the projection walks the anchor chain to reconstruct
 * file-internal order (AD-2 anchor-pointer ordering).
 */
export async function emitSourceCellCreate(
  input: SourceCellCreateInput,
): Promise<string> {
  const { eventId } = await enqueueEvent({
    kind: "source.cell.create",
    projectId: input.projectId,
    fileId: input.fileId,
    cellId: input.cellId,
    parentId: null,
    author: input.author,
    payload: {
      cellId: input.cellId,
      anchorCellId: input.anchorCellId,
      value: input.value,
      ...(input.valueHtml !== undefined ? { valueHtml: input.valueHtml } : {}),
      ...(input.type !== undefined ? { type: input.type } : {}),
      ...(input.canonicalRef !== undefined ? { canonicalRef: input.canonicalRef } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      ...(input.startMs !== undefined ? { startMs: input.startMs } : {}),
      ...(input.endMs !== undefined ? { endMs: input.endMs } : {}),
      ...(input.medium !== undefined ? { medium: input.medium } : {}),
      ...(input.sequenceIndex !== undefined ? { sequenceIndex: input.sequenceIndex } : {}),
      ...(input.transcription !== undefined ? { transcription: input.transcription } : {}),
      ...(input.cameraState !== undefined ? { cameraState: input.cameraState } : {}),
    },
    clientTs: input.clientTs,
  })
  return eventId
}

export interface SourceCellDeleteInput {
  projectId: string
  fileId: string
  cellId: string
  author: string
  clientTs?: number
}

/**
 * Emit a `source.cell.delete` — removes the source-side cell row from the
 * projection (events stay queryable). Used by diarization to replace a media
 * file's existing segments with freshly diarized ones.
 */
export async function emitSourceCellDelete(input: SourceCellDeleteInput): Promise<string> {
  const { eventId } = await enqueueEvent({
    kind: "source.cell.delete",
    projectId: input.projectId,
    fileId: input.fileId,
    cellId: input.cellId,
    parentId: null,
    author: input.author,
    payload: {},
    clientTs: input.clientTs,
  })
  return eventId
}

export interface FileCreateInput {
  projectId: string
  fileId: string
  name: string
  fileType: string
  sourceLanguage?: string
  targetLanguage?: string
  /** Timeline-segment-model order lens: 'time' | 'sequence'. */
  orderedBy?: string
  author: string
  clientTs?: number
}

/**
 * Emit a `file.create` event. Project-level event — not part of any cell
 * chain (`parentId = null`).
 */
export async function emitFileCreate(input: FileCreateInput): Promise<string> {
  const { eventId } = await enqueueEvent({
    kind: "file.create",
    projectId: input.projectId,
    fileId: input.fileId,
    parentId: null,
    author: input.author,
    payload: {
      name: input.name,
      fileType: input.fileType,
      ...(input.sourceLanguage !== undefined ? { sourceLanguage: input.sourceLanguage } : {}),
      ...(input.targetLanguage !== undefined ? { targetLanguage: input.targetLanguage } : {}),
      ...(input.orderedBy !== undefined ? { orderedBy: input.orderedBy } : {}),
    },
    clientTs: input.clientTs,
  })
  return eventId
}

export interface FileDeleteInput {
  projectId: string
  fileId: string
  author: string
  clientTs?: number
}

/**
 * Emit a `file.delete` event — soft-deletes the file by stamping `files.deleted_at`.
 * Cells and audio are retained; the R2 wipe is deferred to an explicit
 * "Delete forever" action (which calls the hard-delete REST endpoint).
 * File-scoped and non-chain-mutating (`parentId = null`).
 */
export async function emitFileDelete(input: FileDeleteInput): Promise<string> {
  const { eventId } = await enqueueEvent({
    kind: "file.delete",
    projectId: input.projectId,
    fileId: input.fileId,
    parentId: null,
    author: input.author,
    payload: {},
    clientTs: input.clientTs,
  })
  return eventId
}

export interface FileRestoreInput {
  projectId: string
  fileId: string
  author: string
  clientTs?: number
}

/**
 * Emit a `file.restore` event — clears the soft-delete tombstone so the file
 * reappears in normal listings. All cells and audio remain intact.
 * File-scoped and non-chain-mutating (`parentId = null`).
 */
export async function emitFileRestore(input: FileRestoreInput): Promise<string> {
  const { eventId } = await enqueueEvent({
    kind: "file.restore",
    projectId: input.projectId,
    fileId: input.fileId,
    parentId: null,
    author: input.author,
    payload: {},
    clientTs: input.clientTs,
  })
  return eventId
}

export interface FileRenameInput {
  projectId: string
  fileId: string
  /** New display label for the file in the project sidebar. */
  name: string
  author: string
  clientTs?: number
}

/**
 * Emit a `file.rename` event — persists a file's new display label to the
 * server projection so it surfaces for every collaborator, not just the
 * device that applied it. File-scoped and non-chain-mutating (`parentId =
 * null`), like `cell.audio.attach`; the server projects it as a `files`
 * UPDATE keyed on fileId.
 */
export async function emitFileRename(input: FileRenameInput): Promise<string> {
  const { eventId } = await enqueueEvent({
    kind: "file.rename",
    projectId: input.projectId,
    fileId: input.fileId,
    parentId: null,
    author: input.author,
    payload: {
      name: input.name,
    },
    clientTs: input.clientTs,
  })
  return eventId
}
