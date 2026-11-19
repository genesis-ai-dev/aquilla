// Pure planning for the fast R2→R2 audio import — the I/O shells around this
// are scripts/migrate-daemon/stages/audio.ts and scripts/migrate-all.ts. Two
// responsibilities:
//   1. Resolve each cell attachment to its LFS oid via the pointers tree, so the
//      copy endpoint can locate the bytes already in R2.
//   2. Decide the events to emit per cell: one cell.audio.attach per *copied*
//      take, of which only the cell's current take may become the active one,
//      then one cell.audio.select to pin Codex's explicit selection.
// Everything here is a pure function of its inputs — deterministic + unit-tested.

import type { CodexCell } from "../codex-editor/types"
import { collectAllCellAudio, audioAttachEvent, audioValidateEvents, audioSelectEvent } from "./audio"
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

/**
 * The files a batch of events touches, each once: the scope a caller hands
 * `POST /migrate/finalize` after ingesting them.
 *
 * Every migration ingest defers the file counters, and `/migrate/ingest` never
 * writes a progress row, so an audio pass that ingests and stops leaves its
 * takes attached and playable while the book reads "0% recorded" in the sidebar
 * and on the dashboard. Each audio pass therefore finalizes what it touched.
 * An empty result means "nothing to finalize" — the route reads an empty list
 * as the whole project, so callers must not pass one on.
 */
export function touchedFileIds(events: IngestEvent[]): string[] {
  return [...new Set(events.flatMap((event) => (event.fileId ? [event.fileId] : [])))]
}

/**
 * The one copied take an import pass may make active: Codex's explicit
 * selection when its bytes were copied, otherwise the newest copied take.
 *
 * Codex resolves a cell's audio the same way (`selectedAudioId`, else the
 * newest non-deleted attachment by `createdAt`, the earlier one on a tie), so
 * this is the take a Codex user sees marked current.
 */
export function currentTakeOf(
  copiedTakes: AudioImport[],
  selectedAquillaAudioId: string | null,
): string | null {
  if (
    selectedAquillaAudioId &&
    copiedTakes.some((t) => t.aquillaAudioId === selectedAquillaAudioId)
  ) {
    return selectedAquillaAudioId
  }
  let newest: AudioImport | undefined
  for (const take of copiedTakes) {
    if (!newest || (take.createdAt ?? 0) > (newest.createdAt ?? 0)) newest = take
  }
  return newest?.aquillaAudioId ?? null
}

/**
 * Build the events for one cell after its takes have been copied: an attach per
 * copied take (clientTs = createdAt so TakesStrip's created_ts order reproduces
 * "Take 1..N"), then a single select to pin Codex's explicit selection — omitted
 * when that take wasn't copied (e.g. an lfs-miss) or there is none.
 *
 * Only the cell's current take (`currentTakeOf`) is an ordinary attach, the
 * kind that selects its own row. Every other take is `historyOnly`: it joins
 * the cell's takes unselected and moves nothing.
 *
 * Every attach used to be ordinary, on the reasoning that the select behind
 * them puts the choice back. That holds for a cell's first import and fails on
 * every later one. The select's id is keyed on (cell, take), so once it has
 * been ingested a re-run's copy is dropped as a replay; a take whose bytes only
 * became copyable since then is a NEW attach, and it selected itself with
 * nothing left to undo it. That is how an old recording arriving late became a
 * verse's active take and left the validated one deselected beside it, and why
 * running the import again never repaired it.
 *
 * `preserveUnselectedHistory` is the stricter form the audited recovery needs:
 * nothing but the explicit selection may select, so a lone recovered take stays
 * unselected even on a cell where nothing is chosen.
 *
 * Not covered: a Codex user switching BACK to a take that was pinned before.
 * That select's id is already in the log too, so the switch does not arrive.
 */
export function buildCellAudioEvents(
  cellId: string,
  copiedTakes: AudioImport[],
  selectedAquillaAudioId: string | null,
  opts: AudioEventOptions & { preserveUnselectedHistory?: boolean },
): IngestEvent[] {
  const events: IngestEvent[] = []
  const mayBecomeActive = opts.preserveUnselectedHistory === true
    ? selectedAquillaAudioId
    : currentTakeOf(copiedTakes, selectedAquillaAudioId)
  for (const take of copiedTakes) {
    events.push(audioAttachEvent(cellId, take, {
      ...opts,
      historyOnly: take.aquillaAudioId !== mayBecomeActive,
    }))
    // AQU-490: the take's Codex validations ride immediately behind its
    // attach, so a validate can never precede the row it votes on.
    events.push(...audioValidateEvents(cellId, take, opts))
  }
  if (
    selectedAquillaAudioId &&
    copiedTakes.some((t) => t.aquillaAudioId === selectedAquillaAudioId)
  ) {
    events.push(audioSelectEvent(cellId, selectedAquillaAudioId, opts))
  }
  return events
}
