// Which recordings belong to a subtitle line when they are not ON it.
// (Review feedback, 2026-08-22)
//
// In the dubbing arrangement a take hangs off the HEARD LINE that performs a
// subtitle — a cell in the hidden audio-cue sibling — because one subtitle can
// be performed as two heard lines and `cell_audio.selected` is per cell. Every
// surface that deals in takes already resolves through the cue links (the
// recorder, read-aloud, the character check, the exports). The expanded row's
// Recording tab did not, so a line with a recording showed "No audio yet".
//
// This is the resolution, in one pure function so the ordering rule can be
// tested without a browser.

import { resolveTargetAudio } from "./track-audio"
import type { CellData } from "@/hooks/useCells"

export interface LinkedTake {
  /** The cue that HOLDS the recording. Its `fileId` is the cue sibling's, so
   *  every write aimed at it lands on the right file. */
  cell: CellData
  /**
   * How many subtitle lines this one heard line performs. More than one is
   * legitimate and common enough to matter — measured up to seven on the
   * client's own episode — and it means re-recording this take changes every
   * one of those lines, which the reader should be told before they do it.
   */
  sharedWith: number
}

export interface BuildLinkedTakesArgs {
  /** The cue sibling's cells, already merged with their attachments. Null when
   *  the file has no cue sibling at all. */
  cueCells: readonly CellData[] | null
  /** subtitle cell id → the cues performing it. Explicitly UNORDERED. */
  cuesForText: ReadonlyMap<string, readonly string[]>
  /** cue id → the subtitle cells it performs; the shared count comes from here. */
  textForCue: ReadonlyMap<string, readonly string[]>
}

/**
 * subtitle cell id → its heard lines that actually hold a recording, in FILM
 * ORDER.
 *
 * Two rules earn their place:
 *
 *   - **Film order.** `cuesForText` makes no ordering promise (see
 *     `buildCueLinkIndex`), so a line performed by two heard lines would
 *     otherwise list them in whatever order the edges came back in. The
 *     recorder's target picker sorts the same way for the same reason.
 *   - **Only cues with a take.** A paired cue nobody has recorded yet has
 *     nothing to draw, and the tab's empty state already offers the way to
 *     record it.
 *
 * Returns an empty map when there is no cue sibling, so every other
 * arrangement — an mp3 import, a plain subtitle file, scripture — is untouched.
 */
export function buildLinkedTakes({
  cueCells,
  cuesForText,
  textForCue,
}: BuildLinkedTakesArgs): Map<string, LinkedTake[]> {
  const out = new Map<string, LinkedTake[]>()
  if (!cueCells || cueCells.length === 0) return out

  const byId = new Map(cueCells.map((c) => [c.id, c]))
  const order = new Map(cueCells.map((c, i) => [c.id, i]))

  for (const [textCellId, cueIds] of cuesForText) {
    const takes: LinkedTake[] = []
    for (const cueId of [...cueIds].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))) {
      const cell = byId.get(cueId)
      if (!cell || resolveTargetAudio(cell) == null) continue
      takes.push({ cell, sharedWith: textForCue.get(cueId)?.length ?? 1 })
    }
    if (takes.length > 0) out.set(textCellId, takes)
  }
  return out
}
