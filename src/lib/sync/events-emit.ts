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
import {
  OUTBOX_SCHEMA_VERSION,
  type OutboxEventKind,
  type OutboxPayloadFor,
  type OutboxRawEvent,
  isGenesisKind,
} from "./outbox-types"

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
export async function enqueueEvent<K extends OutboxEventKind>(
  input: BuildEventInput<K>,
): Promise<{ event: OutboxRawEvent<K>; eventId: string }> {
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
}

/**
 * Emit a `target.cell.commit` event — translator-side commit on blur, idle,
 * or lock release. The caller supplies the current chain head; the returned
 * eventId becomes the next parent for follow-up commits.
 */
export async function emitTargetCellCommit(
  input: CellCommitInput,
): Promise<string> {
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
    },
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
    },
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
