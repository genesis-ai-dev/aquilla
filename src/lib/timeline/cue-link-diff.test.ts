// The re-pair diff. (AQU-646 stage 4)
//
// Sam asked for real coverage here specifically, because this is the part that
// is miserable to check by hand — verifying it manually means scouring the
// events table and the cell_links projection and holding several hundred
// pairings in your head. Its failure mode is also the worst kind: quietly
// wrong pairings across a whole episode, with nothing on screen to say so.
//
// Two properties carry everything. A pairing that already holds must be left
// ALONE rather than re-stated (several hundred pointless events otherwise), and
// a pairing that no longer holds must be unlinked OUT LOUD — silence leaves it
// standing, because an unlink is a tombstone.

import { describe, it, expect } from "vitest"

import { diffCueLinks } from "./cue-link-diff"
import { buildCueLinkIndex, type CueLink } from "@/lib/sync/cell-links-read"
import type { CueLinkPlan } from "./cue-links"

const edge = (textCellId: string, cueCellId: string): CueLink => ({
  kind: "text-audio",
  fromFileId: "f-subs",
  fromCellId: textCellId,
  toFileId: "f-cues",
  toCellId: cueCellId,
  origin: "auto",
  confidence: 0.9,
})

const want = (textCellId: string, cueCellId: string, confidence = 0.8): CueLinkPlan => ({
  textCellId,
  cueCellId,
  confidence,
})

const index = (...edges: CueLink[]) => buildCueLinkIndex(edges)

const pairs = (list: { textCellId: string; cueCellId: string }[]) =>
  list.map((e) => `${e.textCellId}→${e.cueCellId}`).sort()

describe("diffCueLinks", () => {
  it("leaves a pairing that already holds completely alone", () => {
    // Not "re-state it harmlessly": ~650 pairings an episode, one event each.
    const d = diffCueLinks({ current: index(edge("s1", "c1")), wanted: [want("s1", "c1")] })
    expect(d.link).toEqual([])
    expect(d.unlink).toEqual([])
    expect(d.unchanged).toBe(1)
  })

  it("links a pairing the matcher found and the server does not have", () => {
    const d = diffCueLinks({ current: index(), wanted: [want("s1", "c1", 0.77)] })
    expect(d.link).toEqual([{ textCellId: "s1", cueCellId: "c1", confidence: 0.77 }])
    expect(d.unlink).toEqual([])
  })

  it("UNLINKS a pairing the matcher no longer wants, rather than going quiet", () => {
    // The one that would rot silently: not re-stating an edge leaves it live,
    // because an unlink is a tombstone and absence means nothing.
    const d = diffCueLinks({ current: index(edge("s1", "c1")), wanted: [] })
    expect(d.unlink).toEqual([{ textCellId: "s1", cueCellId: "c1", confidence: null }])
    expect(d.link).toEqual([])
  })

  it("handles a re-pairing as one unlink and one link", () => {
    const d = diffCueLinks({
      current: index(edge("s1", "c1")),
      wanted: [want("s2", "c1")],
    })
    expect(pairs(d.unlink)).toEqual(["s1→c1"])
    expect(pairs(d.link)).toEqual(["s2→c1"])
  })

  it("keeps many-to-many straight — the normal case, not an edge case", () => {
    // One subtitle performed as two heard lines, and one heard line covering
    // two subtitles. 93 and 154 cues respectively on episode 101.
    const d = diffCueLinks({
      current: index(edge("s1", "c1"), edge("s1", "c2"), edge("s2", "c3")),
      wanted: [want("s1", "c1"), want("s3", "c3"), want("s2", "c3")],
    })
    expect(d.unchanged).toBe(2) // s1→c1 and s2→c3
    expect(pairs(d.unlink)).toEqual(["s1→c2"])
    expect(pairs(d.link)).toEqual(["s3→c3"])
  })

  describe("scoped to newly added cues", () => {
    it("pairs the new cue and does not touch anything else", () => {
      // What a reconcile does on its own: new cues would otherwise sit unpaired
      // forever, but a cue the reconcile never touched must keep its pairing —
      // including one somebody fixed by hand.
      const d = diffCueLinks({
        current: index(edge("s1", "c1")),
        wanted: [want("s2", "c-new")],
        onlyCues: new Set(["c-new"]),
      })
      expect(pairs(d.link)).toEqual(["s2→c-new"])
      expect(d.unlink).toEqual([])
      expect(d.unchanged).toBe(0)
    })

    it("REFUSES to unlink outside the scope even when the matcher disagrees", () => {
      // The protection that makes scoping worth having: the matcher would drop
      // s1→c1 here, and a hand correction on an untouched cue must survive that.
      const d = diffCueLinks({
        current: index(edge("s1", "c1")),
        wanted: [want("s2", "c-new")],
        onlyCues: new Set(["c-new"]),
      })
      expect(d.unlink).toEqual([])
    })

    it("still corrects a pairing INSIDE the scope", () => {
      const d = diffCueLinks({
        current: index(edge("s1", "c-new")),
        wanted: [want("s2", "c-new")],
        onlyCues: new Set(["c-new"]),
      })
      expect(pairs(d.unlink)).toEqual(["s1→c-new"])
      expect(pairs(d.link)).toEqual(["s2→c-new"])
    })

    it("does nothing at all for an empty scope", () => {
      // A reconcile that added no cues must emit no link traffic whatsoever.
      const d = diffCueLinks({
        current: index(edge("s1", "c1")),
        wanted: [want("s9", "c9")],
        onlyCues: new Set(),
      })
      expect(d).toEqual({ link: [], unlink: [], unchanged: 0 })
    })
  })

  it("is idempotent — running it twice proposes nothing the second time", () => {
    // Applying the diff and re-diffing is the cheapest proof the two halves
    // agree about what "already holds" means.
    const current = index(edge("s1", "c1"), edge("s2", "c2"))
    const wanted = [want("s1", "c1"), want("s3", "c3")]
    const first = diffCueLinks({ current, wanted })
    const applied = index(
      ...[
        ...[...current.cuesForText].flatMap(([t, cs]) => cs.map((c) => edge(t, c))),
        ...first.link.map((e) => edge(e.textCellId, e.cueCellId)),
      ].filter(
        (e) =>
          !first.unlink.some(
            (u) => u.textCellId === e.fromCellId && u.cueCellId === e.toCellId,
          ),
      ),
    )
    const second = diffCueLinks({ current: applied, wanted })
    expect(second.link).toEqual([])
    expect(second.unlink).toEqual([])
    expect(second.unchanged).toBe(2)
  })

  it("survives an empty everything", () => {
    expect(diffCueLinks({ current: index(), wanted: [] })).toEqual({
      link: [],
      unlink: [],
      unchanged: 0,
    })
  })
})
