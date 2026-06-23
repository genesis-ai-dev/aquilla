// Pure planning for the fast R2→R2 audio import (scripts/migrate-audio-copy.ts
// is the I/O shell around this). Two responsibilities:
//   1. Resolve each cell attachment to its LFS oid via the pointers tree, so the
//      copy endpoint can locate the bytes already in R2.
//   2. Decide the events to emit per cell: one cell.audio.attach per *copied*
//      take, then one cell.audio.select to pin the legacy active take.
// Everything here is a pure function of its inputs — deterministic + unit-tested.

import type { CodexCell } from "../codex-editor/types"
import { collectAllCellAudio, audioAttachEvent, audioSelectEvent } from "./audio"
import type { AudioImport, AudioEventOptions } from "./audio"
import type { DiscoveredPointer } from "./gitlab/lfs"
import { pointersToFilesPath } from "./gitlab/lfs"
import type { IngestEvent } from "./types"

/** Normalize an attachment url / files-path to a canonical repo-relative key:
 *  forward slashes, no leading "./" or "/". */
export function normalizeAttachmentPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.?\/+/, "")
}

/** Index files-tree path → LFS oid. `discoverPointers` yields pointers/ paths;
 *  cell metadata references the parallel files/ path, so we bridge via
 *  pointersToFilesPath. */
export function buildOidIndex(pointers: DiscoveredPointer[]): Map<string, string> {
  const idx = new Map<string, string>()
  for (const p of pointers) {
    const filesPath = pointersToFilesPath(p.relativePath)
    idx.set(normalizeAttachmentPath(filesPath), p.pointer.oid)
  }
  return idx
}

/** Resolve a cell attachment url to its oid, or undefined if no pointer matches. */
export function oidForAttachmentUrl(index: Map<string, string>, url: string): string | undefined {
  return index.get(normalizeAttachmentPath(url))
}

/** One take paired with the LFS oid that locates its bytes. */
export interface PlannedCopy {
  take: AudioImport
  oid: string
}

export interface CellAudioPlan {
  /** Takes whose bytes we can copy (oid resolved). */
  copies: PlannedCopy[]
  /** Non-deleted takes whose oid could not be resolved — surfaced, not dropped. */
  missingOid: AudioImport[]
  /** aquillaAudioId of the legacy active recording, if it is among `copies`. */
  selectedAquillaAudioId: string | null
}

/** Plan one cell: pair every non-deleted take with its oid, and identify the
 *  active take (the legacy selectedAudioId, but only if that take is copyable). */
export function planCellAudio(cell: CodexCell, oidIndex: Map<string, string>): CellAudioPlan {
  const takes = collectAllCellAudio(cell)
  const copies: PlannedCopy[] = []
  const missingOid: AudioImport[] = []
  for (const take of takes) {
    const oid = oidForAttachmentUrl(oidIndex, take.diskRelPath)
    if (oid) copies.push({ take, oid })
    else missingOid.push(take)
  }

  const md = cell.metadata as unknown as { selectedAudioId?: string }
  const selected = md.selectedAudioId
    ? copies.find((c) => c.take.legacyAudioId === md.selectedAudioId)
    : undefined
  return {
    copies,
    missingOid,
    selectedAquillaAudioId: selected ? selected.take.aquillaAudioId : null,
  }
}

/** Build the events for one cell after its takes have been copied: an attach per
 *  copied take (clientTs = createdAt so TakesStrip's created_ts order reproduces
 *  "Take 1..N"), then a single select to pin the active take — omitted when the
 *  active take wasn't copied (e.g. an lfs-miss) or there is none. */
export function buildCellAudioEvents(
  cellId: string,
  copiedTakes: AudioImport[],
  selectedAquillaAudioId: string | null,
  opts: AudioEventOptions,
): IngestEvent[] {
  const events: IngestEvent[] = copiedTakes.map((take) => audioAttachEvent(cellId, take, opts))
  if (
    selectedAquillaAudioId &&
    copiedTakes.some((t) => t.aquillaAudioId === selectedAquillaAudioId)
  ) {
    events.push(audioSelectEvent(cellId, selectedAquillaAudioId, opts))
  }
  return events
}
