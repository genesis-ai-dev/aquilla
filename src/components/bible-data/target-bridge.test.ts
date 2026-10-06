// AQU-1694 — Bridge 2 for one editor: source → target links per chapter.
//
// The translator scrolls a chapter; its rows ask for links once, and get
// them for the texts they show. An edited target is not tinted with links
// computed on the old wording.

import { describe, expect, it, vi } from "vitest"
import type { TargetAligner } from "@/lib/bible-data/bridge-align-client"
import { alignTargetCells, trainTargetModel } from "@/lib/bible-data/target-alignment"
import { createTargetBridge, type TargetCorpusCell } from "./target-bridge"

function corpus(count: number, chapter = "JHN 4"): TargetCorpusCell[] {
  return Array.from({ length: count }, (_, k) => ({
    cellId: `c${k}`,
    chapter,
    source: `Jesus said to her verse ${k}`,
    target: `Yesus berkata kepadanya ayat ${k}`,
  }))
}

/** The real Bridge 2, inline, with a call counter. */
function countingAligner(): TargetAligner & { calls: number } {
  const aligner = {
    calls: 0,
    async align(all: Parameters<TargetAligner["align"]>[0], wanted: Parameters<TargetAligner["align"]>[1]) {
      aligner.calls++
      return alignTargetCells(trainTargetModel(all), wanted)
    },
    dispose: vi.fn(),
  }
  return aligner
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("Bridge 2 per chapter", () => {
  it("answers a chapter once however many of its rows ask", async () => {
    const cells = corpus(30)
    const aligner = countingAligner()
    const bridge = createTargetBridge({ corpus: () => cells, aligner })
    bridge.request("JHN 4")
    bridge.request("JHN 4")
    await flush()
    bridge.request("JHN 4")
    await flush()
    expect(aligner.calls).toBe(1)
    const links = bridge.linksFor("c3", cells[3].source, cells[3].target)
    expect(links?.trainedPairs).toBe(30)
    expect(links?.links.length).toBeGreaterThan(0)
  })

  it("has no links for a target that changed since, and recomputes it on the next request", async () => {
    const cells = corpus(30)
    const aligner = countingAligner()
    const bridge = createTargetBridge({ corpus: () => cells, aligner })
    bridge.request("JHN 4")
    await flush()
    cells[3] = { ...cells[3], target: "Yesus menjawab dia ayat 3" }
    expect(bridge.linksFor("c3", cells[3].source, cells[3].target)).toBeUndefined()
    bridge.request("JHN 4")
    await flush()
    expect(aligner.calls).toBe(2)
    expect(bridge.linksFor("c3", cells[3].source, cells[3].target)).toBeDefined()
  })

  it("records a chapter it cannot cover yet (too few translated verses) without links, so rows stop asking", async () => {
    const cells = corpus(10)
    const aligner = countingAligner()
    const bridge = createTargetBridge({ corpus: () => cells, aligner })
    bridge.request("JHN 4")
    await flush()
    expect(bridge.linksFor("c0", cells[0].source, cells[0].target)).toEqual({ links: [], trainedPairs: 10 })
    bridge.request("JHN 4")
    await flush()
    expect(aligner.calls).toBe(1)
  })

  it("tells its subscribers when links arrive", async () => {
    const cells = corpus(30)
    const bridge = createTargetBridge({ corpus: () => cells, aligner: countingAligner() })
    const listener = vi.fn()
    bridge.subscribe(listener)
    const before = bridge.version()
    bridge.request("JHN 4")
    await flush()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(bridge.version()).toBe(before + 1)
  })
})
