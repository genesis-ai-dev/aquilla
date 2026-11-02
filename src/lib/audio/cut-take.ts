/**
 * Cutting a dub take into independent pieces — the client's half of
 * `cell.audio.cut`. (AQU-1767 phase 1)
 *
 * Everything here is pure, so the blade, the "cut at the playhead" button and
 * the undo step all ask the same questions the same way, and the projection's
 * own refusal rule (sync-worker event-projection.ts) has exactly one mirror.
 */
import { buildAudioId } from "./upload"
import { pieceGroupOf, type AudioAttachmentOut } from "@/lib/sync/cell-audio-read-types"
import type { CodexCellAttachment } from "@/lib/codex-editor/types"

/**
 * The shortest piece a cut may leave on either side, in ms. MUST equal the
 * server's CUT_MIN_PIECE_MS, or the blade would offer cuts the server refuses.
 */
export const CUT_MIN_PIECE_MS = 100

export interface CuttableTake {
  trimStartMs?: number | null
  trimEndMs?: number | null
  durationMs?: number | null
  role?: "dub" | "source"
  label?: string | null
  pieceOf?: string | null
  slot?: string
  isDeleted?: boolean
}

/** The audible window of a take in its own audio, or null when its end is unknown. */
export function audibleWindowMs(att: CuttableTake): { startMs: number; endMs: number } | null {
  const startMs = att.trimStartMs != null && att.trimStartMs > 0 ? att.trimStartMs : 0
  const endMs = att.trimEndMs ?? att.durationMs ?? null
  if (endMs == null || !Number.isFinite(endMs) || endMs <= startMs) return null
  return { startMs, endMs }
}

/**
 * May this take be cut at `atMs` (a position in its own audio)? Only a live
 * DUB with a known end, and only at least CUT_MIN_PIECE_MS inside its window —
 * the same rule the projection enforces. Source audio is never cut: it stays
 * split the way the import split it (Sam, 2026-10-12).
 */
export function canCutAt(att: CuttableTake | undefined, atMs: number): boolean {
  if (!att || att.isDeleted || (att.role ?? "dub") !== "dub") return false
  const win = audibleWindowMs(att)
  if (!win || !Number.isFinite(atMs)) return false
  return atMs >= win.startMs + CUT_MIN_PIECE_MS && atMs <= win.endMs - CUT_MIN_PIECE_MS
}

/**
 * The second piece's id. Seeded with the CELL (buildAudioId), so every reader
 * that still tells a take from the source clip by its seed reads a piece as
 * the take it is; the piece GROUP is stated by the server (`pieceOf`), never
 * guessed from this. Keeps the original's extension, as every stored id does.
 */
export function newPieceAudioId(cellId: string, fromAudioId: string): string {
  const ext = /\.[a-z0-9]{2,5}$/i.exec(fromAudioId)?.[0] ?? ""
  return `${buildAudioId(cellId)}${ext}`
}

/** "Take 3 · 2" → "Take 3". A label with no piece number is its own base. */
function baseLabel(label: string | null | undefined): string | null {
  if (!label) return null
  return label.replace(/\s·\s\d+$/, "")
}

/**
 * Names for the two pieces: the group's base name and a number in clip order
 * — "Take 3 · 1", "Take 3 · 2". The number is the piece COUNT, not a position,
 * so cutting a piece again never renames a sibling (a take's name is permanent
 * and deleting one must not renumber the rest — AQU-646 round 8). The first
 * piece is renamed only on the take's first cut.
 */
export function pieceLabels(
  cutAudioId: string,
  attachments: Record<string, CuttableTake> | undefined,
): { firstLabel?: string; newLabel?: string } {
  const att = attachments?.[cutAudioId]
  const base = baseLabel(att?.label)
  if (!base) return {}
  const group = pieceGroupOf(att, cutAudioId)
  const pieces = Object.entries(attachments ?? {}).filter(
    ([id, a]) => a.slot === att?.slot && pieceGroupOf(a, id) === group,
  ).length
  const firstCut = pieces <= 1
  return {
    ...(firstCut ? { firstLabel: `${base} · 1` } : {}),
    newLabel: `${base} · ${pieces + 1}`,
  }
}

/**
 * A take as the optimistic overlay wants it — the read shape, rebuilt from the
 * merged cell's attachment. The overlay REPLACES an attachment rather than
 * merging into it, so every field the editor reads has to be listed here or it
 * blinks out while the write is in flight.
 */
export function attachmentOutFrom(audioId: string, att: CodexCellAttachment, slot: string): AudioAttachmentOut {
  return {
    audioId,
    url: att.url,
    slot,
    mimeType: null,
    voiceId: att.voiceId ?? null,
    referenceAudioId: att.referenceAudioId ?? null,
    durationMs: att.durationMs ?? null,
    label: att.label ?? null,
    trimStartMs: att.trimStartMs ?? null,
    trimEndMs: att.trimEndMs ?? null,
    targetOffsetMs: att.targetOffsetMs ?? null,
    // AQU-2267: the place following the recordings travels with it.
    recordingsOffsetMs: att.recordingsOffsetMs ?? null,
    ...(att.validatorCount != null ? { validatorCount: att.validatorCount } : {}),
    ...(att.validators ? { validators: att.validators } : {}),
    ...(att.validatorDecidedTs ? { validatorDecidedTs: att.validatorDecidedTs } : {}),
    ...(att.role ? { role: att.role } : {}),
    ...(att.recordedBy != null ? { recordedBy: att.recordedBy } : {}),
    ...(att.pieceOf ? { pieceOf: att.pieceOf } : {}),
  }
}
