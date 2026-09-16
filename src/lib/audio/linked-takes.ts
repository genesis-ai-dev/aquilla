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

// ---------------------------------------------------------------------------
// What a bulk voice generation actually does (2026-08-27)
// ---------------------------------------------------------------------------

/** One subtitle's translation, trimmed, or null when there is nothing to say. */
function saidText(cell: CellData): string | null {
  const t = cell.translated?.trim()
  return t ? t : null
}

/**
 * THE WORDS A HEARD LINE SPEAKS: every subtitle it performs, joined in film
 * order.
 *
 * One join, in one place. `resolveCueReadAloud` shows this same string to the
 * performer in the recorder, and the bulk run now generates it — two copies of
 * the rule would let what a person reads and what the machine says drift apart,
 * which is the whole failure this function exists to prevent.
 */
export function joinCueText(
  textIds: readonly string[],
  subtitleById: ReadonlyMap<string, CellData>,
): { text: string; linked: readonly CellData[] } {
  const linked = textIds
    .map((id) => subtitleById.get(id))
    .filter((c): c is CellData => Boolean(c))
    .sort((a, b) => (a.startTime ?? 0) - (b.startTime ?? 0))
  return {
    text: linked.map(saidText).filter((t): t is string => Boolean(t)).join(" "),
    linked,
  }
}

/** What a bulk synth would do, per DESTINATION. */
export interface SynthTargetPlan {
  /** The cell the generated clip attaches to — a cue, or the source itself. */
  cell: CellData
  /** The words it will say. Never empty; an empty one is not a target. */
  text: string
  /** Whose cast assignment picks the voice: the first subtitle in film order.
   *  Cues carry no assignment of their own — see `generateCellVoice`. */
  voiceCellId: string
  /** EVERY subtitle this destination performs, film-ordered. One entry in the
   *  ordinary case. More means the caller should check whether they agree
   *  about the character before trusting `voiceCellId`. */
  linkedTextIds: readonly string[]
}

export interface ResolveSynthTargetsArgs extends ResolveAudioHomesArgs {
  /** cue id → the subtitle cells it performs. THE DIRECTION THAT MATTERS HERE
   *  — see the function's own note. */
  textForCue: ReadonlyMap<string, readonly string[]>
}

/**
 * Everything a "generate a voice for every line" run should do, once.
 *
 * ITERATES DESTINATIONS, NOT SOURCES, and that inversion is the entire fix.
 * Fanning out over subtitles (what stage 3f did) emits one target per
 * subtitle→cue EDGE, so a heard line performing two subtitles was generated
 * twice, concurrently, into its single `generatedVoice` slot: both paid for,
 * the server's per-(cell, slot) deselect keeping whichever finished last, and
 * the loser stored but silent. Keying on the destination makes that
 * impossible by construction rather than by a de-duplication step somebody has
 * to remember — the same race `handleTranscribeSections` had to patch by hand.
 *
 * Both directions of the many-to-many stay correct:
 *   - several subtitles → ONE cue: one target, speaking all of them joined
 *     (Sam, 2026-08-27);
 *   - one subtitle → SEVERAL cues: still one target each, every one speaking
 *     the whole line, which is Sam's August ruling and unchanged.
 *
 * With no cue sibling every cell is its own destination, which is every
 * arrangement that is not a dubbing file and is byte-for-byte what shipped.
 */
export function resolveSynthTargets(
  sourceCells: readonly CellData[],
  // `cuesForText` is in the args type so callers hand over one link index
  // rather than picking it apart, but this walks the OTHER direction — that
  // inversion is the fix, so taking only `textForCue` here is deliberate.
  { cueCells, textForCue }: ResolveSynthTargetsArgs,
): SynthTargetPlan[] {
  // No cue arrangement: each cell speaks its own words onto itself.
  if (!cueCells || cueCells.length === 0) {
    const out: SynthTargetPlan[] = []
    for (const cell of sourceCells) {
      const text = saidText(cell)
      if (!text || cell.selectedGeneratedVoiceAudioId) continue
      out.push({ cell, text, voiceCellId: cell.id, linkedTextIds: [cell.id] })
    }
    return out
  }

  const subtitleById = new Map(sourceCells.map((c) => [c.id, c]))
  const out: SynthTargetPlan[] = []
  for (const cue of cueCells) {
    // Each destination keeps its own "already voiced" test: one cue of a pair
    // may have been generated and the other not.
    if (cue.selectedGeneratedVoiceAudioId) continue
    const textIds = textForCue.get(cue.id) ?? []
    // A cue nothing is linked to — about ten an episode. There are no words
    // for it, and its own transcript is reference, not a translation.
    if (textIds.length === 0) continue
    const { text, linked } = joinCueText(textIds, subtitleById)
    // Linked only to lines nobody has translated yet.
    if (!text || linked.length === 0) continue
    out.push({
      cell: cue,
      text,
      voiceCellId: linked[0].id,
      linkedTextIds: linked.map((c) => c.id),
    })
  }
  return out
}

/**
 * The destinations whose subtitles do NOT agree about who is speaking.
 *
 * Sam, 2026-08-27: generate in the first character's voice, then say which
 * lines disagreed. `assignedVoiceIdFor` must be the function that can tell an
 * ASSIGNMENT from a fallback (`assignedCastVoiceId`) — resolving the voice
 * instead would make every unassigned line look like it agreed with the
 * project default.
 */
export function divergentVoiceTargets(
  targets: readonly SynthTargetPlan[],
  assignedVoiceIdFor: (cellId: string) => string | undefined,
): SynthTargetPlan[] {
  return targets.filter((t) => {
    if (t.linkedTextIds.length < 2) return false
    const assigned = new Set(
      t.linkedTextIds.map(assignedVoiceIdFor).filter((v): v is string => Boolean(v)),
    )
    return assigned.size > 1
  })
}
