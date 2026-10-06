// Voices, adopted as a dubbing project's cast (AQU-1692).
//
// A maintainer can turn the voices of a chapter, or of the whole file, into
// the cast names (`cast_name`) a dubbing project gives its lines. Only a line
// with exactly one voice gets a name; the narrator counts as a voice, so a
// line where the narrator introduces a speaker is not adopted. Everything not
// adopted is listed, so the maintainer can assign it by hand:
//   several     — more than one voice in the line;
//   unnamed     — its one voice has no name in the data;
//   approximate — another cell covers the same verse, so its voices are the
//                 whole verse's, not the line's;
//   kept        — the line already has a cast name, which is never replaced.
// Pure: no React, no i18n. Names come from the caller, who knows the label
// chain and the interface language.

import type { BkpRef } from "./pack-types"
import { cellVerses, cellVoicesFor, distinctVoices, voiceSequence, type Voice, type VoiceCellInput, type VoiceIndex } from "./voice-index"

/** A cell as adopting sees it: where it is, and the cast name it already has. */
export interface VoiceCastCell extends VoiceCellInput {
  cellId: string
  castName: string | null
}

/** A chapter ("RUT 1"), or the whole file. */
export type VoiceCastScope = { kind: "chapter"; chapter: string } | { kind: "file" }

export interface VoiceCastLine {
  cellId: string
  /** The cell's first verse. */
  ref: BkpRef
}

export interface VoiceCastPlan {
  assign: (VoiceCastLine & { castName: string })[]
  /** Each voice's name in reading order; null where the data names nobody. */
  several: (VoiceCastLine & { names: (string | null)[] })[]
  unnamed: VoiceCastLine[]
  approximate: VoiceCastLine[]
  kept: (VoiceCastLine & { castName: string })[]
}

/** The chapter of a verse ref: "RUT 1:10" → "RUT 1". */
export function chapterOf(ref: BkpRef): string {
  const colon = ref.lastIndexOf(":")
  return colon < 0 ? ref : ref.slice(0, colon)
}

export function planVoiceCast(
  index: VoiceIndex,
  cells: readonly VoiceCastCell[],
  shared: ReadonlySet<BkpRef>,
  scope: VoiceCastScope,
  /** A voice's name as the cast should carry it; null when the data names nobody. */
  nameOf: (voice: Voice) => string | null,
): VoiceCastPlan {
  const plan: VoiceCastPlan = { assign: [], several: [], unnamed: [], approximate: [], kept: [] }
  for (const cell of cells) {
    const verses = cellVerses(cell)
    if (!verses) continue
    const ref = verses.refs[0]
    if (scope.kind === "chapter" && chapterOf(ref) !== scope.chapter) continue
    const voices = cellVoicesFor(index, cell, shared)
    if (!voices) continue
    const line = { cellId: cell.cellId, ref }
    if (cell.castName) {
      plan.kept.push({ ...line, castName: cell.castName })
      continue
    }
    if (voices.approximate) {
      plan.approximate.push(line)
      continue
    }
    const distinct = distinctVoices(voiceSequence(index, voices))
    if (distinct.length > 1) {
      plan.several.push({ ...line, names: distinct.map(nameOf) })
      continue
    }
    const name = distinct[0] ? nameOf(distinct[0]) : null
    if (name) plan.assign.push({ ...line, castName: name })
    else plan.unnamed.push(line)
  }
  return plan
}
