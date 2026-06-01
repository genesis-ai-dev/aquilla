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
import { audioAttachEventId } from "./ids"
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
