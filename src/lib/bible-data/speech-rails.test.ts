// AQU-1687 — speech rails: where quotations open, continue and close.
//
// What these tests protect (see-who-is-speaking.md, Acceptance criteria):
//   • a cell where a speech opens shows an opening cap, a cell where it
//     closes shows a closing cap, and the cells between show a continuing
//     rail — across real multi-verse speeches (JHN 4:34–38);
//   • nested quotations get one rail per level;
//   • a self-projected "I tell you that …" adds no level and does not make
//     the speaker's rail look closed and reopened.

import { describe, expect, it } from "vitest"
import { DISCIPLES, JESUS, jhn4Voices } from "./__fixtures__/jhn4"
import { railSegments, type RailSegment } from "./speech-rails"
import { buildVoiceIndex, cellVoicesFor } from "./voice-index"

const index = buildVoiceIndex(jhn4Voices())

function rails(ref: string): RailSegment[] {
  const cell = cellVoicesFor(index, { ref, type: "text" }, new Set())
  if (!cell) throw new Error(`no voices for ${ref}`)
  return railSegments(index, cell)
}

/** "level:shape" per segment, e.g. ["1:continue", "2:both"]. */
function shapes(ref: string): string[] {
  return rails(ref).map(({ level, shape }) => `${level}:${shape}`)
}

describe("a level-1 speech across several cells (Jesus, JHN 4:34–38)", () => {
  it("opens in 4:34, continues through 4:35–37 and closes in 4:38", () => {
    expect(shapes("JHN 4:34")).toEqual(["1:begin"])
    expect(shapes("JHN 4:36")).toEqual(["1:continue"])
    expect(shapes("JHN 4:37")).toEqual(["1:continue"])
    expect(shapes("JHN 4:38")).toEqual(["1:end"])

    const states = ["JHN 4:34", "JHN 4:36", "JHN 4:38"].map((ref) => rails(ref)[0].speeches[0])
    expect(states.map(({ state }) => state)).toEqual(["begins", "continues", "ends"])
    expect(states.every(({ speech }) => speech.speaker === JESUS)).toBe(true)
  })

  it("draws a speech that opens and closes in one cell with both caps (4:7)", () => {
    expect(shapes("JHN 4:7")).toEqual(["1:both"])
    expect(rails("JHN 4:7")[0].speeches[0].state).toBe("begins-and-ends")
  })

  it("draws no rail for narration (4:8)", () => {
    expect(rails("JHN 4:8")).toEqual([])
  })

  it("carries a two-verse speech across a cell boundary (4:11 → 4:12)", () => {
    expect(shapes("JHN 4:11")).toEqual(["1:begin"])
    expect(shapes("JHN 4:12")).toEqual(["1:end"])
    // In one bridge cell the same speech opens and closes.
    expect(shapes("JHN 4:11-12")).toEqual(["1:both"])
  })
})

describe("nested quotations", () => {
  it("gives the quotation inside Jesus' reply its own level-2 rail (4:10)", () => {
    expect(shapes("JHN 4:10")).toEqual(["1:both", "2:both"])
    expect(rails("JHN 4:10")[1].speeches[0].speech.speaker).toBe(JESUS)
  })

  it("keeps the outer rail open around a level-2 quotation (4:35)", () => {
    const [outer, inner] = rails("JHN 4:35")
    expect(outer).toMatchObject({ level: 1, shape: "continue" })
    expect(inner).toMatchObject({ level: 2, shape: "both" })
    expect(inner.speeches[0].speech.speaker).toBe(DISCIPLES)
  })
})

describe("self-projected speech", () => {
  it("adds no level and no caps: 'I tell you …' in 4:35 is still Jesus' one level-1 speech", () => {
    // The pack has a self-projected speech at level 1 in this verse...
    const selfProjected = [...index.speeches.values()].find(
      (speech) => speech.selfProjected && speech.from.startsWith("n43004035"),
    )
    expect(selfProjected?.level).toBe(1)
    // ...yet level 1 holds only the outer speech, so its rail continues
    // unbroken instead of closing and reopening mid-verse.
    const level1 = rails("JHN 4:35")[0]
    expect(level1.speeches.map(({ speech }) => speech.id)).toEqual(["sp:n43004034005-n43004038017"])
    expect(level1.shape).toBe("continue")
  })
})
