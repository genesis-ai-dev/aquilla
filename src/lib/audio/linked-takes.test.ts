// Which recordings a subtitle line owns when they live on another cell.
//
// The bug this answers (review feedback, 2026-08-22): a take hangs off the
// HEARD LINE that performs a subtitle, so the expanded row's Recording tab —
// which reads only its own file — showed "No audio yet" over lines that
// plainly had recordings on the timeline. What is pinned here is the pair of
// rules that decide what the tab draws.

import { describe, it, expect } from "vitest"
import { buildLinkedTakes } from "./linked-takes"
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
