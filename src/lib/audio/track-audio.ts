// Track-level audio resolution for media sections (AQU-646 round 5).
//
// A media cell can carry TWO kinds of audio at once:
//   - the SOURCE clip: the one imported file all sections share, seeded with
//     the FILE id at upload (import attaches it into the recording slot with
//     per-section trims — a dedicated source slot is still a later refinement),
//   - TARGET audio: the cell's own dub — a mic/upload take (recording slot,
//     audioId seeded with the CELL id) or a generated voice (generatedVoice
//     slot).
//
// The timeline's Source/Target tracks and the play-queue's master/overlay
// elements all resolve through these two helpers so "what is the source" and
// "what is the dub" have exactly one definition. Provenance rides the audioId
// seeding convention from buildAudioId (see audioIdSeededWith); ambiguous or
// legacy ids default to SOURCE, matching isSourceSegmentSelected.

import type { CellData } from "@/hooks/useCells"
import type { CodexCellAttachment } from "@/lib/codex-editor/types"
import { audioIdSeededWith } from "./upload"

export interface TrackAudioRef {
  audioId: string
  url: string
}

export interface TargetAudioRef extends TrackAudioRef {
  kind: "take" | "generated"
}

function liveAttachment(cell: CellData, id: string | undefined): CodexCellAttachment | undefined {
  if (!id) return undefined
  const att = cell.attachments?.[id]
  if (!att || att.isDeleted) return undefined
  return att
}

/**
 * The section's SOURCE-clip attachment — even when a take is selected in the
 * recording slot. Selection order: a selected non-take id (the source clip,
 * or a legacy id defaulting to source) wins; otherwise scan the attachments
 * for a live fileId-seeded entry (the shared clip a take displaced). Null for
 * non-media cells and take-only sections.
 */
export function sourceClipAudioForCell(cell: CellData): TrackAudioRef | null {
  if (cell.medium !== "media") return null
  const sel = cell.selectedAudioId
  if (sel && !audioIdSeededWith(sel, cell.id)) {
    const att = liveAttachment(cell, sel)
    if (att) return { audioId: sel, url: att.url }
  }
  for (const [id, att] of Object.entries(cell.attachments ?? {})) {
    if (id === sel || att.isDeleted) continue
    if (audioIdSeededWith(id, cell.fileId)) return { audioId: id, url: att.url }
  }
  return null
}

/**
 * The section's active TARGET (dub) audio: the selected recording-slot take
 * when there is one, else the selected generated voice, else null. Drives the
 * Target-audio track's chips and the playback overlay.
 */
export function activeTargetForCell(cell: CellData): TargetAudioRef | null {
  if (cell.medium !== "media") return null
  const sel = cell.selectedAudioId
  if (sel && audioIdSeededWith(sel, cell.id)) {
    const att = liveAttachment(cell, sel)
    if (att) return { audioId: sel, url: att.url, kind: "take" }
  }
  const gen = cell.selectedGeneratedVoiceAudioId
  if (gen) {
    const att = liveAttachment(cell, gen)
    if (att) return { audioId: gen, url: att.url, kind: "generated" }
  }
  return null
}
