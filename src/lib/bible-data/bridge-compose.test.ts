import { describe, expect, it } from "vitest"
import { composeBridges, SOLID_MIN_PAIRS, TINT_SOLID_MIN, tintStyle } from "./bridge-compose"

// JHN 4:7. Greek → source (BSB): Ἰησοῦς → "Jesus" (token 8), αὐτῇ → "to her"
// (10, 11). Source → target (a draft): "Jesus" → "Yesus" (target 3), "her" →
// "dia" (target 6), "to" → nothing.
const bridge1 = [
  { wordId: "n43004007011", token: 8, conf: 0.9 },
  { wordId: "n43004007009", token: 10, conf: 0.2 },
  { wordId: "n43004007009", token: 11, conf: 0.8 },
]
const bridge2 = [
  { src: 8, tgt: 3, conf: 0.7 },
  { src: 11, tgt: 6, conf: 0.5 },
]

describe("composing Bridge 1 and Bridge 2", () => {
  it("multiplies the two confidences along the path", () => {
    // Two uncertain steps are less certain than either: 0.9 × 0.7, 0.8 × 0.5.
    expect(composeBridges(bridge1, bridge2)).toEqual([
      { wordId: "n43004007011", token: 3, conf: 0.9 * 0.7 },
      { wordId: "n43004007009", token: 6, conf: 0.8 * 0.5 },
    ])
  })

  it("keeps the best path when two source tokens reach the same target token", () => {
    const viaBoth = [...bridge2, { src: 10, tgt: 6, conf: 0.9 }]
    // "to" (0.2 × 0.9 = 0.18) loses to "her" (0.8 × 0.5 = 0.4).
    expect(composeBridges(bridge1, viaBoth).find((link) => link.token === 6)).toEqual({
      wordId: "n43004007009",
      token: 6,
      conf: 0.8 * 0.5,
    })
  })

  it("drops a composed link below the floor, as Bridge 1 drops its own", () => {
    const weak = [{ src: 10, tgt: 5, conf: 0.4 }]
    // 0.2 × 0.4 = 0.08, under the floor where Bridge 1's own links were right 28% of the time.
    expect(composeBridges(bridge1, weak)).toEqual([])
  })
})

describe("solid or dotted", () => {
  it("draws solid at the threshold and dotted just below it", () => {
    expect(tintStyle(TINT_SOLID_MIN, SOLID_MIN_PAIRS)).toBe("solid")
    expect(tintStyle(TINT_SOLID_MIN - 0.001, SOLID_MIN_PAIRS)).toBe("dotted")
  })

  it("puts the threshold where the measurement put it: 0.5", () => {
    // On John, Bridge 1 links at ≥ 0.5 were right 92% of the time and links
    // below it about 60%. A threshold moved without re-measuring breaks the
    // promise that a solid tint is a trustworthy one.
    expect(TINT_SOLID_MIN).toBe(0.5)
  })

  it("draws dotted whatever the confidence when a bridge trained on a short book", () => {
    // Philemon (25 verses): its ≥ 0.5 links were right 72–79% of the time.
    expect(tintStyle(0.99, 25)).toBe("dotted")
    expect(tintStyle(0.99, SOLID_MIN_PAIRS - 1)).toBe("dotted")
    expect(tintStyle(0.99, SOLID_MIN_PAIRS)).toBe("solid")
  })

  it("composes into dotted when either step is weak, even if the other is certain", () => {
    const [link] = composeBridges([{ wordId: "w", token: 0, conf: 1 }], [{ src: 0, tgt: 0, conf: 0.45 }])
    expect(tintStyle(link.conf, SOLID_MIN_PAIRS)).toBe("dotted")
  })
})
