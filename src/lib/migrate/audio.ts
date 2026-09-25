// Pure mapping: a legacy Codex cell's audio attachments → the active clips to
// upload + their cell.audio.attach events. The actual byte upload to R2 is a
// side-effect performed by the CLI (scripts/migrate.ts); this module only
// decides WHAT to import and produces the deterministic attach events.
//
// Policy: import the cell's SELECTED recording + selected generated voice
// (skipping soft-deleted clips). If nothing is explicitly selected but exactly
// one non-deleted audio exists, take that. Multi-clip history is out of scope
// for now (only the active clip per slot).

import type { CodexCell } from "../codex-editor/types"
import { audioAttachEventId, audioSelectEventId, audioValidateEventId } from "./ids"
import type { IngestEvent } from "./types"

export interface AudioImport {
  legacyAudioId: string
  /** Object name including extension (e.g. "audio-….webm") — the R2 audioId. */
  aquillaAudioId: string
  /** Path to the bytes on disk, relative to the project root (= attachment.url). */
  diskRelPath: string
  slot: "recording" | "generatedVoice"
  createdBy?: string
  createdAt?: number
  mimeType?: string
  durationMs?: number
  /**
   * AQU-490: who signed this take off in Codex.
   *
   * Codex has had per-take validation since 2024 and the field teams have used
   * it heavily — 2,577 validations by named users on the notebooks measured
   * for the research board. Dropping it on the way in would tell the Pattani
   * Malay and Chosen teams that none of that work happened.
   */
  validatedBy?: LegacyValidation[]
}

/** A Codex validation entry. Tombstoned rather than removed, hence isDeleted. */
export interface LegacyValidation {
  username?: string
  creationTimestamp?: number
  updatedTimestamp?: number
  isDeleted?: boolean
}

// The on-disk attachment is richer than this repo's CodexCellAttachment type
// (it carries createdBy + a nested metadata blob), so read it loosely.
interface LegacyAttachment {
  url?: string
  type?: string
  isDeleted?: boolean
  createdBy?: string
  createdAt?: number
  durationMs?: number
  mimeType?: string
  metadata?: { mimeType?: string; durationSec?: number }
  validatedBy?: LegacyValidation[]
}

const basename = (p: string): string => p.split("/").pop() ?? p

function toImport(
  audioId: string,
  att: LegacyAttachment | undefined,
  slot: "recording" | "generatedVoice",
): AudioImport | undefined {
  if (!att || att.isDeleted || (att.type && att.type !== "audio") || !att.url) return undefined
  const durationMs =
    att.durationMs ??
    (att.metadata?.durationSec != null ? Math.round(att.metadata.durationSec * 1000) : undefined)
  return {
    legacyAudioId: audioId,
    aquillaAudioId: basename(att.url),
    diskRelPath: att.url,
    slot,
    createdBy: att.createdBy,
    createdAt: att.createdAt,
    mimeType: att.mimeType ?? att.metadata?.mimeType,
    durationMs,
    ...(att.validatedBy ? { validatedBy: att.validatedBy } : {}),
  }
}

export function collectCellAudio(cell: CodexCell): AudioImport[] {
  const md = cell.metadata as unknown as {
    attachments?: Record<string, LegacyAttachment>
    selectedAudioId?: string
    selectedGeneratedVoiceAudioId?: string
  }
  const atts = md.attachments
  if (!atts) return []
  const out: AudioImport[] = []

  const rec = md.selectedAudioId ? toImport(md.selectedAudioId, atts[md.selectedAudioId], "recording") : undefined
  if (rec) out.push(rec)
  const voice = md.selectedGeneratedVoiceAudioId
    ? toImport(md.selectedGeneratedVoiceAudioId, atts[md.selectedGeneratedVoiceAudioId], "generatedVoice")
    : undefined
  if (voice) out.push(voice)

  if (out.length === 0) {
    const live = Object.entries(atts).filter(
      ([, a]) => !a.isDeleted && (!a.type || a.type === "audio") && a.url,
    )
    if (live.length === 1) {
      const imp = toImport(live[0][0], live[0][1], "recording")
      if (imp) out.push(imp)
    }
  }
  return out
}

// Like collectCellAudio, but returns EVERY non-deleted take (not just the
// active clip per slot). The fast R2→R2 import wants full take history, so it
// copies + attaches all takes; the legacy app had no voice generation, so every
// take is a "recording". The active take is pinned separately by the driver via
// audioSelectEvent (keyed on the cell's selectedAudioId). `legacyAudioId` is
// preserved on each take so the driver can match selectedAudioId → aquillaAudioId.
export function collectAllCellAudio(cell: CodexCell): AudioImport[] {
  const md = cell.metadata as unknown as {
    attachments?: Record<string, LegacyAttachment>
  }
  const atts = md.attachments
  if (!atts) return []
  const out: AudioImport[] = []
  for (const [audioId, att] of Object.entries(atts)) {
    const imp = toImport(audioId, att, "recording")
    if (imp) out.push(imp)
  }
  return out
}

export interface AudioEventOptions {
  projectId: string
  fileId: string
  fallbackAuthor: string
  fallbackTs: number
}

export function audioAttachEvent(cellId: string, a: AudioImport, opts: AudioEventOptions): IngestEvent {
  return {
    id: audioAttachEventId(opts.projectId, opts.fileId, cellId, a.aquillaAudioId),
    kind: "cell.audio.attach",
    fileId: opts.fileId,
    cellId,
    parentId: null,
    author: a.createdBy || opts.fallbackAuthor,
    clientTs: typeof a.createdAt === "number" ? a.createdAt : opts.fallbackTs,
    payload: {
      audioId: a.aquillaAudioId,
      url: `frontier-audio://${a.aquillaAudioId}`,
      slot: a.slot,
      ...(a.mimeType ? { mimeType: a.mimeType } : {}),
      ...(a.durationMs != null ? { durationMs: a.durationMs } : {}),
    },
  }
}

// Pin the legacy active take. Emitted once per cell AFTER all that cell's
// cell.audio.attach events, because each attach auto-selects its own row — so
// without this the last-attached take would end up active. All legacy takes are
// recordings, so the slot is always "recording".
export function audioSelectEvent(
  cellId: string,
  aquillaAudioId: string,
  opts: AudioEventOptions,
): IngestEvent {
  return {
    id: audioSelectEventId(opts.projectId, opts.fileId, cellId, aquillaAudioId),
    kind: "cell.audio.select",
    fileId: opts.fileId,
    cellId,
    parentId: null,
    author: opts.fallbackAuthor,
    clientTs: opts.fallbackTs,
    payload: {
      audioId: aquillaAudioId,
      slot: "recording",
    },
  }
}

/**
 * AQU-490: one `cell.audio.validate` per live validator on a take.
 *
 * Codex has had per-take validation since 2024 and the field teams have used
 * it heavily — 2,577 validations by named users across the notebooks measured
 * for the research board. Without this, a migrated project arrives saying
 * nobody has ever listened to anything, and the Pattani Malay and Chosen teams
 * would be asked to re-do work they finished years ago.
 *
 * Three rules, each mirroring what the text-side mapping already does:
 *
 * - Tombstoned entries are DROPPED. Codex un-validates by setting isDeleted
 *   rather than removing the row, so importing them would resurrect
 *   validations their owners had explicitly withdrawn.
 * - A validator with no username falls back to the migration's author, for
 *   the reason `cell.validate` does: the sync-worker rejects an event with an
 *   empty author and takes the whole ingest chunk down with it.
 * - The event id is keyed on the VALIDATOR, never on the attach event, so a
 *   re-sync converges on the same id even though the take's attach id moves.
 *   Where the username is missing, the entry's own creationTimestamp keys it
 *   instead — otherwise every nameless validator on one take would collide
 *   into a single event, and only one of them would survive.
 */
export function audioValidateEvents(
  cellId: string,
  a: AudioImport,
  opts: AudioEventOptions,
): IngestEvent[] {
  const out: IngestEvent[] = []
  for (const v of a.validatedBy ?? []) {
    if (v.isDeleted) continue
    const username = typeof v.username === "string" ? v.username.trim() : ""
    const validatorKey = username || (
      typeof v.creationTimestamp === "number" ? `~ts:${v.creationTimestamp}` : ""
    )
    if (!validatorKey) continue
    out.push({
      id: audioValidateEventId(opts.projectId, opts.fileId, cellId, a.aquillaAudioId, validatorKey),
      kind: "cell.audio.validate",
      fileId: opts.fileId,
      cellId,
      parentId: null,
      author: username || opts.fallbackAuthor,
      clientTs: typeof v.creationTimestamp === "number" ? v.creationTimestamp : opts.fallbackTs,
      payload: { audioId: a.aquillaAudioId },
    })
  }
  return out
}
