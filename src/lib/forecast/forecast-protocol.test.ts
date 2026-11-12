import { describe, expect, it } from "vitest"
import { BiaEngine } from "./bia-engine"
import { createInThreadForecastClient } from "./forecast-client"
import { suggestAtCaret } from "./forecast-protocol"

function engineOf(texts: string[]): BiaEngine {
  const engine = new BiaEngine()
  engine.index.upsert(texts.map((text, i) => ({ id: `c${i}`, text, validated: true })))
  return engine
}

const CORPUS = ["in the beginning god created", "in the end god rested", "god created light", "the beginning of wisdom"]

describe("suggestAtCaret", () => {
  it("adds a leading space after punctuation, none after a space", () => {
    const engine = engineOf(["he said, go now", "she said, go home"])
    expect(suggestAtCaret(engine, "he said,")[0]?.insert.startsWith(" go")).toBe(true)
    expect(suggestAtCaret(engine, "he said, ")[0]?.insert.startsWith("go")).toBe(true)
  })

  it("infills a single word between words, spacing both sides", () => {
    const engine = engineOf(CORPUS)
    const [first] = suggestAtCaret(engine, "in the ", "god created")
    expect(first.word).toBe("beginning")
    expect(first.insert).toBe("beginning ")
  })

  it("suggests nothing with the caret inside a word", () => {
    const engine = engineOf(CORPUS)
    expect(suggestAtCaret(engine, "in the beg", "inning")).toEqual([])
  })
})

describe("ForecastClient (in-thread transport)", () => {
  it("applies incremental upserts/removes and fires onFirstUse once", async () => {
    const client = createInThreadForecastClient()
    let firstUses = 0
    client.onFirstUse = () => { firstUses++ }
    client.upsert([{ id: "a", text: "grace and peace", validated: true }])
    expect((await client.suggest("grace and ", ""))[0]?.word).toBe("peace")
    client.upsert([{ id: "a", text: "grace and truth", validated: true }])
    expect((await client.suggest("grace and ", ""))[0]?.word).toBe("truth")
    client.remove(["a"])
    expect(await client.suggest("grace and ", "")).toEqual([])
    expect(firstUses).toBe(1)
    client.dispose()
  })

  it("answers words-that-fit with the current sentence as context", async () => {
    const client = createInThreadForecastClient(engineOf(["the king went out", "the queen went out", "the king came in"]))
    const fits = await client.wordsThatFit("king", "the ", " went out")
    expect(fits.map((f) => f.word)).toContain("queen")
  })
})
