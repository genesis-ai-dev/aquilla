// Which recordings a subtitle line owns when they live on another cell.
//
// The bug this answers (review feedback, 2026-08-22): a take hangs off the
// HEARD LINE that performs a subtitle, so the expanded row's Recording tab —
// which reads only its own file — showed "No audio yet" over lines that
// plainly had recordings on the timeline. What is pinned here is the pair of
// rules that decide what the tab draws.

import { describe, it, expect } from "vitest"
import {
  buildLinkedTakes,
  divergentVoiceTargets,
  primaryAudioHome,
  resolveAudioHomes,
  resolveSynthTargets,
} from "./linked-takes"
import type { CellData } from "@/hooks/useCells"

/** A cue with a selected take, as `mergeCellsWithAudio` leaves one. The audio
 *  id must be SEEDED WITH THE CELL ID or `resolveTargetAudio` reads it as the
 *  imported source clip rather than as somebody's take. */
const cue = (id: string, opts: { take?: boolean } = {}): CellData => {
  const audioId = `audio-${id}-1700000000-take.webm`
  return {
    id,
    fileId: "cue-sibling",
    original: "",
    translated: "",
    medium: "media",
    ...(opts.take === false
      ? { attachments: {} }
      : {
          selectedAudioId: audioId,
          attachments: { [audioId]: { type: "audio", url: "frontier-audio://take" } },
        }),
  } as unknown as CellData
}

const index = (pairs: [text: string, cues: string[]][]) => {
  const cuesForText = new Map<string, readonly string[]>(pairs)
  const textForCue = new Map<string, string[]>()
  for (const [text, cues] of pairs) {
    for (const c of cues) {
      const list = textForCue.get(c)
      if (list) list.push(text)
      else textForCue.set(c, [text])
    }
  }
  return { cuesForText, textForCue: textForCue as ReadonlyMap<string, readonly string[]> }
}

describe("buildLinkedTakes", () => {
  it("gives a subtitle line the cue that performs it", () => {
    const cueCells = [cue("c1")]
    const out = buildLinkedTakes({ cueCells, ...index([["s1", ["c1"]]]) })
    expect(out.get("s1")).toHaveLength(1)
    expect(out.get("s1")![0].cell.id).toBe("c1")
    // Its file is the SIBLING's — that is what makes a write land on the cue.
    expect(out.get("s1")![0].cell.fileId).toBe("cue-sibling")
  })

  it("orders several takes by their position on the film, not by link order", () => {
    // `cuesForText` promises no order (see buildCueLinkIndex), so a line
    // performed as two heard lines would otherwise list them however the edges
    // came back. Handing the cues in REVERSE proves the sort is real.
    const cueCells = [cue("first"), cue("second"), cue("third")]
    const out = buildLinkedTakes({ cueCells, ...index([["s1", ["third", "first"]]]) })
    expect(out.get("s1")!.map((t) => t.cell.id)).toEqual(["first", "third"])
  })

  it("skips a cue nobody has recorded yet", () => {
    // The tab would have nothing to draw, and its empty state already offers
    // the way to record it.
    const cueCells = [cue("c1", { take: false })]
    const out = buildLinkedTakes({ cueCells, ...index([["s1", ["c1"]]]) })
    expect(out.has("s1")).toBe(false)
  })

  it("counts how many lines share one heard line", () => {
    // Real in the client's data — up to seven. Re-recording that take changes
    // every one of them, which the tab says out loud.
    const cueCells = [cue("shared")]
    const out = buildLinkedTakes({
      cueCells,
      ...index([
        ["s1", ["shared"]],
        ["s2", ["shared"]],
        ["s3", ["shared"]],
      ]),
    })
    expect(out.get("s1")![0].sharedWith).toBe(3)
    expect(out.get("s3")![0].sharedWith).toBe(3)
  })

  it("reports a take performed by one line as unshared", () => {
    const out = buildLinkedTakes({ cueCells: [cue("c1")], ...index([["s1", ["c1"]]]) })
    expect(out.get("s1")![0].sharedWith).toBe(1)
  })

  it("is empty when the file has no cue sibling at all", () => {
    // Every non-dubbing arrangement — an mp3 import, a plain subtitle file,
    // scripture — must be untouched by this.
    expect(buildLinkedTakes({ cueCells: null, ...index([["s1", ["c1"]]]) }).size).toBe(0)
    expect(buildLinkedTakes({ cueCells: [], ...index([["s1", ["c1"]]]) }).size).toBe(0)
  })

  it("ignores a link pointing at a cue that is not there", () => {
    // A stale edge must not crash the row it belongs to.
    const out = buildLinkedTakes({ cueCells: [cue("c1")], ...index([["s1", ["ghost", "c1"]]]) })
    expect(out.get("s1")!.map((t) => t.cell.id)).toEqual(["c1"])
  })
})

// AQU-646 stage 3f — where a NEW recording belongs, which is a different
// question from where the existing ones are.
//
// THESE PIN BEHAVIOUR THAT ALREADY SHIPPED. `openRecordingTarget` has been the
// de-facto authority since stage 4 and now delegates here, so these cases are
// written from what it did, not from what would be nice — a refactor of working
// code is only safe if the tests describe the code as it was.
describe("resolveAudioHomes", () => {
  const cues = [cue("c1"), cue("c2"), cue("c3")]
  /** Deliberately OUT of film order: `cuesForText` promises no ordering, and
   *  sorting it is the rule under test. */
  const links = new Map<string, readonly string[]>([
    ["sub-a", ["c3", "c1"]],
    ["sub-b", ["c2"]],
    ["sub-unlinked", []],
  ])

  it("says SELF when the file has no cue sibling at all", () => {
    // Every other arrangement — an mp3 import, a plain subtitle file,
    // scripture — has to be untouched by any of this.
    expect(resolveAudioHomes("sub-a", { cueCells: null, cuesForText: links })).toEqual({ kind: "self" })
    expect(resolveAudioHomes("sub-a", { cueCells: [], cuesForText: links })).toEqual({ kind: "self" })
    expect(primaryAudioHome("sub-a", { cueCells: null, cuesForText: links })).toBe("sub-a")
  })

  it("says SELF for a cue, which owns its own audio", () => {
    expect(resolveAudioHomes("c2", { cueCells: cues, cuesForText: links })).toEqual({ kind: "self" })
    expect(primaryAudioHome("c2", { cueCells: cues, cuesForText: links })).toBe("c2")
  })

  // THE ORDERING RULE. "The first cue" has to mean the same thing to every
  // caller, or the mic and a TTS button put two takes in two different places
  // for the same line.
  it("returns the performing cues in FILM order, not link order", () => {
    const homes = resolveAudioHomes("sub-a", { cueCells: cues, cuesForText: links })
    expect(homes.kind).toBe("cues")
    if (homes.kind !== "cues") return
    expect(homes.cells.map((c) => c.id)).toEqual(["c1", "c3"])
    expect(primaryAudioHome("sub-a", { cueCells: cues, cuesForText: links })).toBe("c1")
  })

  // About ten an episode: a line that needs dubbing with no subtitle behind it.
  // NOT "self" — putting the audio on the subtitle cell is exactly the bug, and
  // it would be invisible on the timeline rather than merely absent.
  it("says NONE when a cue sibling exists but nothing is linked", () => {
    expect(resolveAudioHomes("sub-unlinked", { cueCells: cues, cuesForText: links })).toEqual({ kind: "none" })
    expect(resolveAudioHomes("sub-never-seen", { cueCells: cues, cuesForText: links })).toEqual({ kind: "none" })
    expect(primaryAudioHome("sub-unlinked", { cueCells: cues, cuesForText: links })).toBeNull()
  })

  // A stale index mid-import can name cues this build has not loaded. There is
  // still nowhere to put the audio; saying "itself" would put it somewhere
  // nothing reads.
  it("says NONE when every linked cue is unknown to this build", () => {
    const stale = new Map<string, readonly string[]>([["sub-a", ["ghost-1", "ghost-2"]]])
    expect(resolveAudioHomes("sub-a", { cueCells: cues, cuesForText: stale })).toEqual({ kind: "none" })
  })

  // A cue with no recording yet is not a TAKE, but it is very much a HOME —
  // which is the whole distinction between this and buildLinkedTakes.
  it("counts a cue nobody has recorded yet", () => {
    const empty = [cue("e1", { take: false })]
    const homes = resolveAudioHomes("sub-x", {
      cueCells: empty,
      cuesForText: new Map([["sub-x", ["e1"]]]),
    })
    expect(homes.kind).toBe("cues")
    expect(buildLinkedTakes({
      cueCells: empty,
      cuesForText: new Map([["sub-x", ["e1"]]]),
      textForCue: new Map([["e1", ["sub-x"]]]),
    }).get("sub-x")).toBeUndefined()
  })
})

// ── What a bulk voice generation resolves to ────────────────────────────────
//
// This block used to assert against a HAND-COPIED transcription of the
// workspace's `synthTargetsFor`, on the reasoning that the live copy closed
// over React state and could not be reached. The copy had already drifted from
// the real one (it returned nothing in the self case, where the real function
// returns a target), and its fixture only ever had ONE subtitle — so the
// many-to-many direction, where the bug actually lived, was never constructed.
// The resolver is a pure exported function now and these test IT.
describe("resolveSynthTargets", () => {
  /** A subtitle line, with a translation and no generated voice yet. */
  const sub = (id: string, translated: string, startTime: number): CellData =>
    ({ id, fileId: "f1", original: "", translated, startTime, medium: "media" }) as unknown as CellData

  it("with no cue sibling, every line speaks its own words onto itself", () => {
    const cells = [sub("a", "Sit down.", 0), sub("b", "Now.", 1)]
    expect(resolveSynthTargets(cells, { cueCells: null, cuesForText: new Map(), textForCue: new Map() }))
      .toEqual([
        { cell: cells[0], text: "Sit down.", voiceCellId: "a", linkedTextIds: ["a"] },
        { cell: cells[1], text: "Now.", voiceCellId: "b", linkedTextIds: ["b"] },
      ])
  })

  it("skips a line with no translation, and one already voiced", () => {
    const blank = sub("a", "   ", 0)
    const voiced = { ...sub("b", "Now.", 1), selectedGeneratedVoiceAudioId: "gen-1" } as CellData
    expect(resolveSynthTargets([blank, voiced], { cueCells: null, cuesForText: new Map(), textForCue: new Map() }))
      .toEqual([])
  })

  // THE BUG THIS GROUP EXISTS FOR. Two subtitles performed by ONE heard line
  // used to emit two targets for that one cue — two paid generations racing
  // into a single slot, the loser stored and silent.
  it("generates ONCE for a heard line that performs several subtitles, speaking all of them", () => {
    const cues = [cue("c1", { take: false })]
    const subs = [sub("s2", "Now.", 10), sub("s1", "Sit down.", 5)]
    const links = index([["s1", ["c1"]], ["s2", ["c1"]]])
    const out = resolveSynthTargets(subs, { cueCells: cues, ...links })

    expect(out).toHaveLength(1)
    expect(out[0].cell.id).toBe("c1")
    // Joined in FILM order, not the order the subtitles were handed in.
    expect(out[0].text).toBe("Sit down. Now.")
    // The voice follows the first line in film order (Sam, 2026-08-27).
    expect(out[0].voiceCellId).toBe("s1")
    expect(out[0].linkedTextIds).toEqual(["s1", "s2"])
  })

  // The other direction, which was already right and must stay right: Sam's
  // August ruling that one subtitle performed by two heard lines voices BOTH,
  // each speaking the whole line.
  it("still voices every heard line that performs one subtitle", () => {
    const cues = [cue("c1", { take: false }), cue("c2", { take: false })]
    const subs = [sub("s1", "Sit down.", 5)]
    const out = resolveSynthTargets(subs, { cueCells: cues, ...index([["s1", ["c1", "c2"]]]) })
    expect(out.map((t) => [t.cell.id, t.text])).toEqual([
      ["c1", "Sit down."],
      ["c2", "Sit down."],
    ])
  })

  it("leaves an already-voiced heard line alone while doing its unvoiced neighbour", () => {
    const done = { ...cue("c1", { take: false }), selectedGeneratedVoiceAudioId: "gen-1" } as CellData
    const cues = [done, cue("c2", { take: false })]
    const subs = [sub("s1", "Sit down.", 5), sub("s2", "Now.", 10)]
    const out = resolveSynthTargets(subs, { cueCells: cues, ...index([["s1", ["c1"]], ["s2", ["c2"]]]) })
    expect(out.map((t) => t.cell.id)).toEqual(["c2"])
  })

  it("generates nothing for a heard line nothing is linked to, or whose lines are untranslated", () => {
    const cues = [cue("c1", { take: false }), cue("c2", { take: false })]
    const subs = [sub("s1", "   ", 5)]
    // c1 is linked to an untranslated line; c2 is linked to nothing at all.
    const out = resolveSynthTargets(subs, { cueCells: cues, ...index([["s1", ["c1"]]]) })
    expect(out).toEqual([])
  })

  it("ignores a subtitle the cue index points at but this build cannot see", () => {
    const cues = [cue("c1", { take: false })]
    const subs = [sub("s1", "Sit down.", 5)]
    const out = resolveSynthTargets(subs, { cueCells: cues, ...index([["s1", ["c1"]], ["ghost", ["c1"]]]) })
    expect(out).toHaveLength(1)
    expect(out[0].text).toBe("Sit down.")
    expect(out[0].linkedTextIds).toEqual(["s1"])
  })
})

describe("divergentVoiceTargets", () => {
  const sub = (id: string, translated: string, startTime: number): CellData =>
    ({ id, fileId: "f1", original: "", translated, startTime, medium: "media" }) as unknown as CellData
  const plan = (linkedTextIds: string[]) =>
    ({ cell: sub("c1", "x", 0), text: "x", voiceCellId: linkedTextIds[0], linkedTextIds })

  it("reports a heard line whose subtitles are assigned different characters", () => {
    const assigned = (id: string) => ({ s1: "v-peter", s2: "v-andrew" })[id]
    expect(divergentVoiceTargets([plan(["s1", "s2"])], assigned)).toHaveLength(1)
  })

  it("says nothing when they agree, or when only one is assigned at all", () => {
    const agree = (id: string) => ({ s1: "v-peter", s2: "v-peter" })[id]
    expect(divergentVoiceTargets([plan(["s1", "s2"])], agree)).toEqual([])
    // An UNASSIGNED line does not count as disagreeing — it has no opinion.
    const partial = (id: string) => ({ s1: "v-peter" })[id]
    expect(divergentVoiceTargets([plan(["s1", "s2"])], partial)).toEqual([])
  })

  it("says nothing about an ordinary one-subtitle line", () => {
    expect(divergentVoiceTargets([plan(["s1"])], () => "v-peter")).toEqual([])
  })
})
