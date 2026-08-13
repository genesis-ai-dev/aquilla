import { describe, expect, it } from "vitest"
import type { CellData } from "@/hooks/useCells"
import type { AiDraftProvenance } from "@/lib/sync/outbox-types"
import {
  hasMateriallyBetterEvidence,
  measureTranslationEvidence,
  translateAsReadAction,
  withTranslateAsReadClaim,
} from "./translate-as-read"

function cell(overrides: Partial<CellData> = {}): CellData {
  return {
    id: "c1",
    fileId: "f1",
    original: "The quick fox",
    translated: "",
    context: "",
    group: "",
    type: "text",
    status: "empty",
    validationStatus: "empty",
    activeValidators: [],
    validationHistory: [],
    history: [],
    threads: [],
    ...overrides,
  }
}

function provenance(coverage = 0.3, weight = 0.2): AiDraftProvenance {
  return {
    model: "luna",
    provider: "frontier",
    promptVersion: "v1",
    exampleIds: ["e1"],
    generatedAt: 1,
    mode: "read",
    projectState: {
      sourceLanguage: "en",
      targetLanguage: "es",
      approvedExampleCount: 1,
      evidenceCoverage: coverage,
      evidenceWeight: weight,
    },
  }
}

describe("translateAsReadAction", () => {
  it("drafts empty cells and refreshes only untouched AI drafts", () => {
    expect(translateAsReadAction(cell())).toBe("draft")
    expect(translateAsReadAction(cell({ targetEventId: "older-empty-head" }))).toBe("draft")
    expect(translateAsReadAction(cell({ translated: "AI", status: "unvalidated", aiDrafted: true }))).toBe("refresh")
    expect(translateAsReadAction(cell({ translated: "Human", status: "unvalidated", aiDrafted: false }))).toBeNull()
  })

  it("never touches validated or actively endorsed cells", () => {
    expect(translateAsReadAction(cell({ translated: "Done", status: "validated", aiDrafted: true }))).toBeNull()
    expect(translateAsReadAction(cell({ translated: "Draft", status: "unvalidated", aiDrafted: true, activeValidators: ["reviewer"] }))).toBeNull()
  })
})

describe("translation evidence", () => {
  it("measures union coverage from the examples used by the prompt", () => {
    expect(measureTranslationEvidence("the quick brown fox", [
      { cellId: "a", source: "quick fox", target: "x" },
      { cellId: "b", source: "brown", target: "y" },
    ])).toEqual({ coverage: 0.75, weight: 0.4, approvedExampleCount: 2, exampleIds: ["a", "b"] })
  })

  it("requires a material coverage or independent-evidence gain", () => {
    expect(hasMateriallyBetterEvidence(provenance(), {
      coverage: 0.36, weight: 0.2, approvedExampleCount: 1, exampleIds: ["e2"],
    })).toBe(true)
    expect(hasMateriallyBetterEvidence(provenance(), {
      coverage: 0.3, weight: 0.4, approvedExampleCount: 2, exampleIds: ["e1", "e2"],
    })).toBe(true)
    expect(hasMateriallyBetterEvidence(provenance(), {
      coverage: 0.31, weight: 0.2, approvedExampleCount: 1, exampleIds: ["e2"],
    })).toBe(false)
  })

  it("handles older provenance conservatively", () => {
    const old = provenance()
    delete old.projectState.evidenceCoverage
    delete old.projectState.evidenceWeight
    expect(hasMateriallyBetterEvidence(old, {
      coverage: 0.8, weight: 0.2, approvedExampleCount: 1, exampleIds: ["e2"],
    })).toBe(false)
    expect(hasMateriallyBetterEvidence(old, {
      coverage: 0.8, weight: 0.4, approvedExampleCount: 2, exampleIds: ["e2", "e3"],
    })).toBe(true)
  })

  it("upgrades a legacy AI head once validated evidence is available", () => {
    expect(hasMateriallyBetterEvidence(undefined, {
      coverage: 0, weight: 0, approvedExampleCount: 0, exampleIds: [],
    })).toBe(false)
    expect(hasMateriallyBetterEvidence(undefined, {
      coverage: 0.5, weight: 0.2, approvedExampleCount: 1, exampleIds: ["e1"],
    })).toBe(true)
  })
})

describe("cross-tab translate-as-read claims", () => {
  it("allows one tab to draft a cell and suppresses the same attempt in another tab", async () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
      removeItem: (key: string) => { values.delete(key) },
    }
    let busy = false
    const locks = {
      async request<T>(
        _name: string,
        _options: { ifAvailable: true },
        callback: (lock: unknown | null) => Promise<T>,
      ): Promise<T> {
        if (busy) return callback(null)
        busy = true
        try {
          return await callback({})
        } finally {
          busy = false
        }
      },
    }
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    let runs = 0
    const environment = { locks, storage, now: () => 1000 }
    const first = withTranslateAsReadClaim("p/f/lane/cell", "empty-head", async () => {
      runs++
      await held
      return { remember: true, committed: true }
    }, environment)
    const overlapping = await withTranslateAsReadClaim(
      "p/f/lane/cell",
      "empty-head",
      async () => ({ remember: true, committed: true }),
      environment,
    )
    expect(overlapping).toEqual({ ran: false })

    release()
    await expect(first).resolves.toEqual({
      ran: true,
      outcome: { remember: true, committed: true },
    })
    const repeated = await withTranslateAsReadClaim(
      "p/f/lane/cell",
      "empty-head",
      async () => { runs++; return { remember: true, committed: true } },
      environment,
    )
    expect(repeated).toEqual({ ran: false })
    expect(runs).toBe(1)

    const humanClearedAgain = await withTranslateAsReadClaim(
      "p/f/lane/cell",
      "new-empty-head",
      async () => { runs++; return { remember: true, committed: true } },
      environment,
    )
    expect(humanClearedAgain.ran).toBe(true)
    expect(runs).toBe(2)
  })
})
