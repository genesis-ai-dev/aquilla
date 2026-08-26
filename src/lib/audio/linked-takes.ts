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

// ---------------------------------------------------------------------------
// Where a line's audio BELONGS — the other direction, and the other question.
// AQU-646 stage 3f.
// ---------------------------------------------------------------------------
//
// `buildLinkedTakes` above answers "where are this line's recordings?". This
// answers "where would a NEW one go?", which is a different question with a
// different answer: a cue that nobody has recorded yet is not a take, but it is
// very much a home.
//
// IT EXISTS BECAUSE FOUR SURFACES ANSWERED IT SEPARATELY AND TWO GOT IT WRONG.
// The microphone redirects to the performing cue; the table's TTS button, ten
// pixels away in the same row, did not — so a generated voice landed on the
// subtitle cell, where the timeline cannot draw it. Bulk synth did the same 650
// times. One place to ask, so the next surface has one obvious import rather
// than three patterns to notice.

/** Where a line's audio belongs. Three outcomes, because they are genuinely
 *  three different situations and collapsing any two of them is how this went
 *  wrong in the first place. */
export type AudioHomes =
  /** No cue arrangement — or this cell IS a cue. The audio belongs on it. */
  | { kind: "self" }
  /** The heard lines that perform it, in FILM ORDER. Callers that can only
   *  write one take (the mic, a play button) take the first. */
  | { kind: "cues"; cells: readonly CellData[] }
  /** A cue sibling exists but nothing is linked to this line — about ten an
   *  episode. There is nowhere for audio to go, and saying "itself" would put
   *  it somewhere nothing can read it. */
  | { kind: "none" }

export interface ResolveAudioHomesArgs {
  /** The cue sibling's cells, in film order. Null when the file has none. */
  cueCells: readonly CellData[] | null
  /** subtitle cell id → the cues performing it. Explicitly UNORDERED, which is
   *  why this sorts. */
  cuesForText: ReadonlyMap<string, readonly string[]>
}

/**
 * Transcribed from `openRecordingTarget`, which has been the de-facto authority
 * since stage 4 and stays behaviourally identical — it now delegates here and
 * takes `cells[0]`.
 *
 * Film order comes from the cue list's own index, not from `cuesForText`, which
 * makes no ordering promise (see `buildCueLinkIndex`). The same sort as
 * `buildLinkedTakes`, for the same reason: "the first cue" has to mean the same
 * thing to every caller or two surfaces disagree about where one take lives.
 */
export function resolveAudioHomes(
  cellId: string,
  { cueCells, cuesForText }: ResolveAudioHomesArgs,
): AudioHomes {
  if (!cueCells || cueCells.length === 0) return { kind: "self" }
  // Already a cue: its audio is its own. Checked BEFORE the links, because a
  // cue is never in `cuesForText` as a key and would otherwise read as unlinked.
  if (cueCells.some((c) => c.id === cellId)) return { kind: "self" }

  const cueIds = cuesForText.get(cellId) ?? []
  if (cueIds.length === 0) return { kind: "none" }

  const order = new Map(cueCells.map((c, i) => [c.id, i]))
  const byId = new Map(cueCells.map((c) => [c.id, c]))
  const cells = [...cueIds]
    .sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
    .map((id) => byId.get(id))
    .filter((c): c is CellData => Boolean(c))
  // Linked only to cues this build cannot see (a stale index mid-import) is
  // "nowhere to put it", not "put it on itself".
  return cells.length > 0 ? { kind: "cues", cells } : { kind: "none" }
}

/** The one cell a single-take caller should write to — the mic, a play button —
 *  or null when there is nowhere. Exactly `openRecordingTarget`'s contract. */
export function primaryAudioHome(
  cellId: string,
  args: ResolveAudioHomesArgs,
): string | null {
  const homes = resolveAudioHomes(cellId, args)
  if (homes.kind === "self") return cellId
  if (homes.kind === "none") return null
  return homes.cells[0].id
}
