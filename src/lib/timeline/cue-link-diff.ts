// Turning "what the matcher says" into "what to actually emit".
// (AQU-646 stage 4, 2026-08-14)
//
// The auto-linker runs once at import and writes ordinary link events, and it
// is deliberately never recomputed on its own — that is what makes a hand
// correction stick. But there are two moments when a recompute IS wanted: new
// cues arriving in a reconcile (they have no pairings and would sit unpaired
// forever), and the user explicitly asking for the whole set to be re-derived.
//
// Both need a DIFF rather than a rewrite, for two reasons that pull the same
// way. Re-stating a pairing that already holds is several hundred pointless
// events. And a pairing that no longer holds has to be UNLINKED OUT LOUD —
// simply not re-stating it would leave it standing, because an unlink is a
// tombstone and silence means nothing.
//
// This lived inline inside the reconcile handler, where it could not be tested
// at all, which is a bad place for the one piece of logic whose failure mode is
// "quietly wrong pairings across a whole episode".

import type { CueLinkIndex } from "@/lib/sync/cell-links-read"
import type { CueLinkPlan } from "./cue-links"

export interface CueLinkEdge {
  textCellId: string
  cueCellId: string
  /** The matcher's score for a new pairing; null when removing one. */
  confidence: number | null
}

export interface CueLinkDiff {
  /** Emit with `linked: true`. */
  link: CueLinkEdge[]
  /** Emit with `linked: false`. */
  unlink: CueLinkEdge[]
  /** Pairings the matcher agrees with, left entirely alone. */
  unchanged: number
}

export interface DiffCueLinksArgs {
  /** What the server currently holds. */
  current: CueLinkIndex
  /** What the matcher says the pairings should be. */
  wanted: readonly CueLinkPlan[]
  /**
   * Restrict the diff to these cues. This is what makes "pair the newly added
   * cues and leave everything else alone" expressible: outside the set, nothing
   * is linked and — critically — nothing is UNLINKED either, so a reconcile can
   * never quietly undo a correction on a cue it did not touch.
   *
   * Absent = the whole set, which is the explicit "re-pair everything" the user
   * has to tick a box for.
   */
  onlyCues?: ReadonlySet<string>
}

const key = (textCellId: string, cueCellId: string): string => `${textCellId} ${cueCellId}`

export function diffCueLinks({ current, wanted, onlyCues }: DiffCueLinksArgs): CueLinkDiff {
  const inScope = (cueCellId: string) => !onlyCues || onlyCues.has(cueCellId)

  const wantedByKey = new Map<string, CueLinkPlan>()
  for (const p of wanted) {
    if (!inScope(p.cueCellId)) continue
    wantedByKey.set(key(p.textCellId, p.cueCellId), p)
  }

  const link: CueLinkEdge[] = []
  const unlink: CueLinkEdge[] = []
  let unchanged = 0

  const held = new Set<string>()
  for (const [textCellId, cueIds] of current.cuesForText) {
    for (const cueCellId of cueIds) {
      if (!inScope(cueCellId)) continue
      const k = key(textCellId, cueCellId)
      held.add(k)
      if (wantedByKey.has(k)) unchanged++
      else unlink.push({ textCellId, cueCellId, confidence: null })
    }
  }

  for (const [k, p] of wantedByKey) {
    if (held.has(k)) continue
    link.push({ textCellId: p.textCellId, cueCellId: p.cueCellId, confidence: p.confidence })
  }

  return { link, unlink, unchanged }
}
