// AQU-1690: the wave's Bible data. Autopilot must load nothing while its
// Bible data enrichment is off, keep running when the pack fails, and give
// scene construal the speakers as known facts — the question it otherwise
// parks a run to ask.

import { describe, expect, it, vi } from "vitest"
import { agreedRenderings, needsTextLayer, prepareBibleRun, prepareBibleWave } from "./bible-run"
import { construeScene, windowBlock, initialWindow } from "./closure"
import { ENGLISH_QUOTES, jhn4BibleData, jhn4Pack, jhn4Pairs } from "./bible-test-helpers"
import { construalJson, pair, scriptedLlm } from "./test-helpers"
import { createRunBudget, type SpanSeed } from "./types"
import type { BkpResult, BookPack } from "../bkp/pack-loader"

const ready = async (): Promise<BkpResult<BookPack>> => ({ ok: true, value: jhn4Pack() })

describe("prepareBibleRun — gating", () => {
  it("loads nothing while the autopilot enrichment is off", async () => {
    const loadPack = vi.fn(ready)
    const run = await prepareBibleRun({
      pairs: jhn4Pairs(),
      profile: {},
      concepts: [],
      flags: { autopilot: false, checks: true },
      loadPack,
    })
    expect(run).toEqual({ state: "off" })
    expect(loadPack).not.toHaveBeenCalled()
  })

  it("loads nothing for a file without verse refs", async () => {
    const loadPack = vi.fn(ready)
    const run = await prepareBibleRun({
      pairs: [pair("p1"), pair("p2")],
      profile: {},
      concepts: [],
      flags: { autopilot: true, checks: true },
      loadPack,
    })
    expect(run).toEqual({ state: "off" })
    expect(loadPack).not.toHaveBeenCalled()
  })

  it("reports a pack that did not load as unavailable, with the loader's reason", async () => {
    const run = await prepareBibleRun({
      pairs: jhn4Pairs(),
      profile: {},
      concepts: [],
      flags: { autopilot: true, checks: true },
      loadPack: async () => ({ ok: false, reason: "invalid" }),
    })
    expect(run).toEqual({ state: "unavailable", reason: "invalid" })
  })

  it("turns a throw while compiling (malformed layer insides) into unavailable, never a failed wave", async () => {
    const broken = jhn4Pack({ voices: { book: "JHN", narrator: { kind: "narrator" }, speeches: [], verses: { "JHN 4:7": 7 } } as unknown as BookPack["voices"] })
    const run = await prepareBibleWave(
      { flags: async () => ({ autopilot: true, checks: true }), loadPack: async () => ({ ok: true, value: broken }) },
      { pairs: jhn4Pairs(), profile: {}, concepts: [] },
    )
    expect(run).toEqual({ state: "unavailable", reason: "invalid" })
  })

  it("asks for the text layer only while second-person facts can matter", () => {
    expect(needsTextLayer({})).toBe(true)
    expect(needsTextLayer({ pronouns: { secondPerson: { numberDistinction: true } } })).toBe(true)
    expect(needsTextLayer({ pronouns: { secondPerson: { numberDistinction: false } } })).toBe(false)
  })
})

describe("prepareBibleRun — facts for each cell", () => {
  it("compiles every verse cell, and its draft line names speaker → addressee with ids", async () => {
    const data = await jhn4BibleData()
    expect([...data.facts.keys()]).toEqual(["c7", "c8", "c9", "c10"])
    expect(data.draftLines.get("c7")).toContain(
      "Jesus [person:Jesus.2] → Samaritan woman [local:JHN:n43004007002], quote level 1 opens and closes here",
    )
    expect(data.checks).toBe(true)
    expect(data.profile).toBe(ENGLISH_QUOTES)
  })

  it("uses the termbase's agreed rendering for a name it decides", () => {
    const renderings = agreedRenderings(jhn4Pack(), [
      { id: "k1", sourceTerm: "Jesus", status: "active", renderings: [{ rendering: "Yesu", status: "preferred" }] },
      { id: "k2", sourceTerm: "water", status: "deprecated", renderings: [{ rendering: "maji", status: "preferred" }] },
    ])
    expect(renderings.get("person:Jesus.2")).toBe("Yesu")
    expect(renderings.has("local:JHN:n43004010029")).toBe(false)
  })
})

describe("construe gets the facts as given", () => {
  const seed: SpanSeed = {
    id: "span-jhn4",
    fileId: "f1",
    anchorCellId: "c7",
    startCellId: "c7",
    endCellId: "c10",
    seedSource: "canonical-ref",
  }

  it("puts each cell's speakers and participants in the construe window, and says not to ask about them", async () => {
    const data = await jhn4BibleData()
    const context = { orderedPairs: jhn4Pairs(), neighborBriefs: [], layerAbove: [], facts: data.construeLines }
    const block = windowBlock(initialWindow(seed, context), context)
    expect(block).toContain("Treat them as known and do not list them as open questions")
    expect(block).toContain("[c7] (JHN 4:7) A woman of Samaria")
    expect(block).toContain("Given facts: speech Jesus → Samaritan woman; named: Samaritan woman, Jesus")
    expect(block).toContain("Given facts: speech Samaritan woman → Jesus")

    const { llm, calls } = scriptedLlm([construalJson({ closed: true })])
    await construeScene({ seed, llm, budget: createRunBudget(), context })
    expect(calls[0].user).toContain("Given facts: speech Jesus → Samaritan woman")
  })

  it("leaves the window exactly as before when there are no facts", () => {
    const context = { orderedPairs: jhn4Pairs(), neighborBriefs: [], layerAbove: [] }
    const block = windowBlock(initialWindow(seed, context), context)
    expect(block).not.toContain("Given facts")
    expect(block.startsWith("Cells:\n")).toBe(true)
  })
})
