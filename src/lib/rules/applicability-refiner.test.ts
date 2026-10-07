/**
 * applicability-refiner — verdict parsing, the coalescing pass, and the run.
 *
 * The coalescing pass is the heart of phase 3c: it is what keeps a run that
 * inspected 184 segments from writing 184 rows, so it is exercised here
 * directly and exhaustively. The completion service is mocked — no network,
 * no model.
 */

import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/completion/completion-service", () => ({ complete: vi.fn() }))

import { complete } from "@/lib/completion/completion-service"
import type { CompletionSettings } from "@/lib/parsers/types"
import { buildApplicabilityIndex } from "./applicability"
import {
  CELLS_PER_BATCH,
  MAX_CELLS_PER_RUN,
  coalesceProposals,
  parseCellVerdicts,
  refineApplicability,
  type CellVerdict,
  type ProposedApplicability,
} from "./applicability-refiner"
import type {
  CellCoordinates,
  RuleApplicability,
  StyleRule,
  StyleRuleScope,
} from "./style-rule-types"

const completeMock = vi.mocked(complete)

const SETTINGS = { model: "test-model", maxTokens: 8192, temperature: 0.7 } as CompletionSettings

// ── Fixtures ───────────────────────────────────────────────────────────────

function makeRule(scope: StyleRuleScope = "global", overrides: Partial<StyleRule> = {}): StyleRule {
  return {
    id: "rule-1",
    orgId: null,
    projectId: "proj-1",
    instruction: "Keep direct speech in the vernacular register",
    category: "register",
    scope,
    conditions: null,
    examples: null,
    exceptions: null,
    source: null,
    checkSpec: null,
    severity: "minor",
    enabled: true,
    status: "approved",
    humanEdited: false,
    provenance: null,
    createdBy: "alice",
    reviewedBy: null,
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }
}

function makeRow(overrides: Partial<RuleApplicability> = {}): RuleApplicability {
  return {
    id: `app-${overrides.targetId ?? "1"}`,
    ruleId: "rule-1",
    targetType: "book",
    targetId: "LUK",
    relationship: "applies",
    confidence: null,
    reason: null,
    assignedBy: "human",
    createdBy: "alice",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }
}

/** Same derivation as `cellCoordinates`, spelled out so fixtures stay obvious. */
function coordsOf(id: string, ref?: string, file = "f-luk"): CellCoordinates {
  const coords: CellCoordinates = { segment: id, file }
  if (!ref) return coords
  coords.passageRef = ref
  const colon = ref.indexOf(":")
  coords.section = colon >= 0 ? ref.slice(0, colon) : ref
  coords.book = ref.split(" ")[0]
  return coords
}

/** `[cellId, matches, ref?]` tuples → the two inputs the coalescer takes. */
function judged(
  rows: Array<[string, boolean, string?]>,
): { verdicts: CellVerdict[]; coords: Map<string, CellCoordinates> } {
  const verdicts = rows.map(([cellId, matches]) => ({
    cellId,
    matches,
    reason: `${cellId} reason`,
    confidence: 0.8,
  }))
  const coords = new Map(rows.map(([cellId, , ref]) => [cellId, coordsOf(cellId, ref)]))
  return { verdicts, coords }
}

function coalesce(
  rows: Array<[string, boolean, string?]>,
  options: { scope?: StyleRuleScope; existing?: RuleApplicability[] } = {},
): ProposedApplicability[] {
  const { verdicts, coords } = judged(rows)
  return coalesceProposals({
    rule: makeRule(options.scope ?? "genre"),
    verdicts,
    coords,
    existing: buildApplicabilityIndex(options.existing ?? []),
  })
}

/** The comparable shape of a proposal, without its evidence fields. */
function shapeOf(row: ProposedApplicability) {
  return {
    targetType: row.targetType,
    targetId: row.targetId,
    relationship: row.relationship,
    coveredCellIds: row.coveredCellIds,
  }
}

beforeEach(() => {
  completeMock.mockReset()
})

// ── Verdict parsing ────────────────────────────────────────────────────────

describe("parseCellVerdicts", () => {
  const raw = JSON.stringify([{ id: "c1", matches: true, confidence: 0.9, reason: "direct speech" }])

  it("parses a plain JSON array", () => {
    expect(parseCellVerdicts(raw)).toEqual([
      { cellId: "c1", matches: true, confidence: 0.9, reason: "direct speech" },
    ])
  })

  it("strips code fences and surrounding prose", () => {
    expect(parseCellVerdicts("```json\n" + raw + "\n```")).toHaveLength(1)
    expect(parseCellVerdicts(`Here you go:\n${raw}\nHope that helps.`)).toHaveLength(1)
  })

  it("returns [] for invalid JSON, a non-array, or no array at all", () => {
    expect(parseCellVerdicts("[{oops}]")).toEqual([])
    expect(parseCellVerdicts('{"id":"c1"}')).toEqual([])
    expect(parseCellVerdicts("no json here")).toEqual([])
  })

  it("drops entries with no id or a non-boolean verdict", () => {
    const messy = JSON.stringify([
      { id: "c1", matches: "yes" },
      { matches: true },
      { id: "  ", matches: true },
      { id: "c2", matches: false },
    ])
    expect(parseCellVerdicts(messy)).toEqual([{ cellId: "c2", matches: false }])
  })

  it("drops ids that were not in the batch", () => {
    const answer = JSON.stringify([
      { id: "c1", matches: true },
      { id: "hallucinated", matches: true },
    ])
    expect(parseCellVerdicts(answer, ["c1"])).toEqual([{ cellId: "c1", matches: true }])
  })

  it("keeps the first verdict for a repeated id and clamps confidence", () => {
    const answer = JSON.stringify([
      { id: "c1", matches: true, confidence: 4 },
      { id: "c1", matches: false },
      { id: "c2", matches: true, confidence: -1 },
      { id: "c3", matches: true, confidence: "high" },
    ])
    expect(parseCellVerdicts(answer)).toEqual([
      { cellId: "c1", matches: true, confidence: 1 },
      { cellId: "c2", matches: true, confidence: 0 },
      { cellId: "c3", matches: true },
    ])
  })
})

// ── Coalescing: the positive side ──────────────────────────────────────────

describe("coalesceProposals — coarsening matches", () => {
  it("collapses a fully matching section into one section row", () => {
    const rows = coalesce([
      ["c1", true, "LUK 1:1"],
      ["c2", true, "LUK 1:2"],
      ["c3", true, "LUK 1:3"],
    ])

    expect(rows.map(shapeOf)).toEqual([
      {
        targetType: "section",
        targetId: "LUK 1",
        relationship: "applies",
        coveredCellIds: ["c1", "c2", "c3"],
      },
    ])
  })

  it("collapses a contiguous verse run inside a partly matching section", () => {
    const rows = coalesce([
      ["c1", true, "LUK 1:1"],
      ["c2", true, "LUK 1:2"],
      ["c3", true, "LUK 1:3"],
      ["c4", false, "LUK 1:4"],
    ])

    expect(rows.map(shapeOf)).toEqual([
      {
        targetType: "passage",
        targetId: "LUK 1:1-3",
        relationship: "applies",
        coveredCellIds: ["c1", "c2", "c3"],
      },
    ])
  })

  it("joins multi-verse cells into one span and splits on a gap", () => {
    const rows = coalesce([
      ["c1", true, "LUK 1:1-2"],
      ["c2", true, "LUK 1:3"],
      ["c3", false, "LUK 1:4"],
      ["c4", true, "LUK 1:5"],
      ["c5", true, "LUK 1:6"],
    ])

    expect(rows.map(shapeOf)).toEqual([
      {
        targetType: "passage",
        targetId: "LUK 1:1-3",
        relationship: "applies",
        coveredCellIds: ["c1", "c2"],
      },
      {
        targetType: "passage",
        targetId: "LUK 1:5-6",
        relationship: "applies",
        coveredCellIds: ["c4", "c5"],
      },
    ])
  })

  it("never runs a span across chapters", () => {
    const rows = coalesce([
      ["c1", true, "LUK 1:1"],
      ["c2", false, "LUK 1:2"],
      ["c3", true, "LUK 2:1"],
      ["c4", false, "LUK 2:2"],
    ])

    expect(rows.map((row) => [row.targetType, row.targetId])).toEqual([
      ["segment", "c1"],
      ["segment", "c3"],
    ])
  })

  it("emits segment rows for scattered, non-contiguous matches", () => {
    const rows = coalesce([
      ["c1", true, "LUK 1:1"],
      ["c2", false, "LUK 1:2"],
      ["c3", true, "LUK 1:3"],
      ["c4", false, "LUK 1:4"],
      ["c5", true, "LUK 1:5"],
    ])

    expect(rows.map(shapeOf)).toEqual([
      { targetType: "segment", targetId: "c1", relationship: "applies", coveredCellIds: ["c1"] },
      { targetType: "segment", targetId: "c3", relationship: "applies", coveredCellIds: ["c3"] },
      { targetType: "segment", targetId: "c5", relationship: "applies", coveredCellIds: ["c5"] },
    ])
  })

  it("emits a segment row for a single match, never a section or passage row", () => {
    const rows = coalesce([
      ["c1", true, "LUK 1:1"],
      ["c2", false, "LUK 1:2"],
    ])

    expect(rows.map(shapeOf)).toEqual([
      { targetType: "segment", targetId: "c1", relationship: "applies", coveredCellIds: ["c1"] },
    ])
  })

  it("does not coarsen a section the run only saw one cell of", () => {
    const rows = coalesce([["c1", true, "LUK 5:1"]])

    expect(rows.map((row) => [row.targetType, row.targetId])).toEqual([["segment", "c1"]])
  })

  it("handles mixed sections independently", () => {
    const rows = coalesce([
      ["c1", true, "LUK 1:1"],
      ["c2", true, "LUK 1:2"],
      ["c3", false, "LUK 2:1"],
      ["c4", true, "LUK 2:2"],
      ["c5", false, "LUK 2:3"],
    ])

    expect(rows.map(shapeOf)).toEqual([
      {
        targetType: "section",
        targetId: "LUK 1",
        relationship: "applies",
        coveredCellIds: ["c1", "c2"],
      },
      { targetType: "segment", targetId: "c4", relationship: "applies", coveredCellIds: ["c4"] },
    ])
  })

  it("degrades cells with no parseable ref to segment rows instead of dropping them", () => {
    const rows = coalesce([
      ["c1", true],
      ["c2", true],
      ["c3", false],
    ])

    expect(rows.map(shapeOf)).toEqual([
      { targetType: "segment", targetId: "c1", relationship: "applies", coveredCellIds: ["c1"] },
      { targetType: "segment", targetId: "c2", relationship: "applies", coveredCellIds: ["c2"] },
    ])
  })

  it("ignores verdicts for cells the run has no coordinates for", () => {
    const rows = coalesceProposals({
      rule: makeRule("genre"),
      verdicts: [
        { cellId: "c1", matches: true },
        { cellId: "ghost", matches: true },
      ],
      coords: new Map([["c1", coordsOf("c1", "LUK 1:1")]]),
      existing: buildApplicabilityIndex([]),
    })

    expect(rows.map((row) => row.targetId)).toEqual(["c1"])
  })

  it("carries the weakest confidence and the first reason onto a coalesced row", () => {
    const coords = new Map([
      ["c1", coordsOf("c1", "LUK 1:1")],
      ["c2", coordsOf("c2", "LUK 1:2")],
    ])
    const [row] = coalesceProposals({
      rule: makeRule("genre"),
      verdicts: [
        { cellId: "c1", matches: true, confidence: 0.9, reason: "quoted speech" },
        { cellId: "c2", matches: true, confidence: 0.4, reason: "reported speech" },
      ],
      coords,
      existing: buildApplicabilityIndex([]),
    })

    expect(row.targetType).toBe("section")
    expect(row.confidence).toBe(0.4)
    expect(row.reason).toBe("quoted speech")
  })
})

// ── Coalescing: exclusions ─────────────────────────────────────────────────

describe("coalesceProposals — exclusions", () => {
  it("proposes an exclusion where a project-wide rule reaches the cell today", () => {
    const rows = coalesce(
      [
        ["c1", true, "LUK 1:1"],
        ["c2", false, "LUK 1:2"],
        ["c3", true, "LUK 1:3"],
        ["c4", false, "LUK 1:4"],
      ],
      { scope: "global" },
    )

    expect(rows.map(shapeOf)).toEqual([
      { targetType: "segment", targetId: "c1", relationship: "applies", coveredCellIds: ["c1"] },
      { targetType: "segment", targetId: "c3", relationship: "applies", coveredCellIds: ["c3"] },
      { targetType: "segment", targetId: "c2", relationship: "excluded", coveredCellIds: ["c2"] },
      { targetType: "segment", targetId: "c4", relationship: "excluded", coveredCellIds: ["c4"] },
    ])
  })

  it("proposes an exclusion where the rule reaches the cell through a broader row", () => {
    const rows = coalesce(
      [
        ["c1", true, "LUK 1:1"],
        ["c2", false, "LUK 1:2"],
      ],
      { scope: "document", existing: [makeRow({ targetType: "book", targetId: "LUK" })] },
    )

    expect(rows.map(shapeOf)).toEqual([
      { targetType: "segment", targetId: "c1", relationship: "applies", coveredCellIds: ["c1"] },
      { targetType: "segment", targetId: "c2", relationship: "excluded", coveredCellIds: ["c2"] },
    ])
  })

  it("proposes no exclusion where the rule is dormant on that cell anyway", () => {
    const rows = coalesce([
      ["c1", true, "LUK 1:1"],
      ["c2", false, "LUK 1:2"],
    ])

    expect(rows.every((row) => row.relationship === "applies")).toBe(true)
  })

  it("coarsens exclusions the same way, so a rejected chapter is one row", () => {
    const rows = coalesce(
      [
        ["c1", false, "LUK 1:1"],
        ["c2", false, "LUK 1:2"],
        ["c3", false, "LUK 1:3"],
      ],
      { scope: "global" },
    )

    expect(rows.map(shapeOf)).toEqual([
      {
        targetType: "section",
        targetId: "LUK 1",
        relationship: "excluded",
        coveredCellIds: ["c1", "c2", "c3"],
      },
    ])
  })

  it("leaves a cell already excluded by an explicit row alone", () => {
    const rows = coalesce(
      [
        ["c1", false, "LUK 1:1"],
        ["c2", false, "LUK 1:2"],
      ],
      {
        scope: "global",
        existing: [
          makeRow({ targetType: "segment", targetId: "c1", relationship: "excluded" }),
          makeRow({ targetType: "segment", targetId: "c2", relationship: "excluded" }),
        ],
      },
    )

    expect(rows).toEqual([])
  })
})

// ── Coalescing: dedupe against the existing graph ──────────────────────────

describe("coalesceProposals — dedupe", () => {
  it("drops a section row the rule already carries, without falling back to segments", () => {
    const rows = coalesce(
      [
        ["c1", true, "LUK 1:1"],
        ["c2", true, "LUK 1:2"],
      ],
      { existing: [makeRow({ targetType: "section", targetId: "LUK 1" })] },
    )

    expect(rows).toEqual([])
  })

  it("drops a passage row that matches an existing span written differently", () => {
    const rows = coalesce(
      [
        ["c1", true, "LUK 1:1"],
        ["c2", true, "LUK 1:2"],
        ["c3", false, "LUK 1:3"],
      ],
      { existing: [makeRow({ targetType: "passage", targetId: " LUK 1:1 - 2 " })] },
    )

    expect(rows).toEqual([])
  })

  it("still proposes a confirmed row where the graph only holds a model hint", () => {
    const rows = coalesce(
      [
        ["c1", true, "LUK 1:1"],
        ["c2", true, "LUK 1:2"],
      ],
      {
        existing: [
          makeRow({
            targetType: "section",
            targetId: "LUK 1",
            relationship: "likely_applies",
            assignedBy: "model",
          }),
        ],
      },
    )

    expect(rows.map(shapeOf)).toEqual([
      {
        targetType: "section",
        targetId: "LUK 1",
        relationship: "applies",
        coveredCellIds: ["c1", "c2"],
      },
    ])
  })

  it("proposes an exclusion over a target the graph currently includes", () => {
    const rows = coalesce(
      [
        ["c1", false, "LUK 1:1"],
        ["c2", false, "LUK 1:2"],
      ],
      { scope: "document", existing: [makeRow({ targetType: "section", targetId: "LUK 1" })] },
    )

    expect(rows.map(shapeOf)).toEqual([
      {
        targetType: "section",
        targetId: "LUK 1",
        relationship: "excluded",
        coveredCellIds: ["c1", "c2"],
      },
    ])
  })
})

// ── The run ────────────────────────────────────────────────────────────────

function verdictJson(ids: readonly string[], matches = true): string {
  return JSON.stringify(ids.map((id) => ({ id, matches, confidence: 0.9, reason: "speech" })))
}

function cellsFor(count: number, chapter = 1) {
  return Array.from({ length: count }, (_, i) => ({
    id: `c${i + 1}`,
    text: `Segment ${i + 1}`,
    ref: `LUK ${chapter}:${i + 1}`,
  }))
}

describe("refineApplicability", () => {
  it("judges in batches, at low temperature, under a capped output budget", async () => {
    const cells = cellsFor(CELLS_PER_BATCH + 1)
    completeMock.mockImplementation(async (options) => {
      const ids = cells
        .map((cell) => cell.id)
        .filter((id) => String(options.messages[1].content).includes(`id: ${id}\n`))
      return verdictJson(ids)
    })

    await refineApplicability({
      rule: makeRule("genre"),
      cells,
      coordsFor: (cell) => coordsOf(cell.id, cell.ref),
      existingIndex: buildApplicabilityIndex([]),
      settings: SETTINGS,
    })

    expect(completeMock).toHaveBeenCalledTimes(2)
    expect(completeMock.mock.calls[0][0].settings.temperature).toBe(0.1)
    expect(completeMock.mock.calls[0][0].settings.maxTokens).toBe(4096)
  })

  it("coalesces the verdicts it collected into rows", async () => {
    const cells = cellsFor(3)
    completeMock.mockResolvedValue(verdictJson(["c1", "c2", "c3"]))

    const rows = await refineApplicability({
      rule: makeRule("genre"),
      cells,
      coordsFor: (cell) => coordsOf(cell.id, cell.ref),
      existingIndex: buildApplicabilityIndex([]),
      settings: SETTINGS,
    })

    expect(rows.map(shapeOf)).toEqual([
      {
        targetType: "section",
        targetId: "LUK 1",
        relationship: "applies",
        coveredCellIds: ["c1", "c2", "c3"],
      },
    ])
  })

  it("reports progress and the usage kind", async () => {
    completeMock.mockResolvedValue(verdictJson(["c1", "c2"]))
    const onProgress = vi.fn()
    const onLlmCall = vi.fn()

    await refineApplicability({
      rule: makeRule("genre"),
      cells: cellsFor(2),
      coordsFor: (cell) => coordsOf(cell.id, cell.ref),
      existingIndex: buildApplicabilityIndex([]),
      settings: SETTINGS,
      onProgress,
      onLlmCall,
    })

    expect(onProgress.mock.calls).toEqual([
      [0, 2, 0],
      [2, 2, 2],
    ])
    expect(onLlmCall).toHaveBeenCalledWith({
      kind: "applicability-refine",
      model: "test-model",
      provider: "frontier",
    })
  })

  it("inspects at most MAX_CELLS_PER_RUN cells, so the caller can say it truncated", async () => {
    completeMock.mockResolvedValue("[]")
    const onProgress = vi.fn()

    await refineApplicability({
      rule: makeRule("genre"),
      cells: cellsFor(MAX_CELLS_PER_RUN + 5),
      coordsFor: (cell) => coordsOf(cell.id, cell.ref),
      existingIndex: buildApplicabilityIndex([]),
      settings: SETTINGS,
      onProgress,
    })

    expect(onProgress.mock.calls[0]).toEqual([0, MAX_CELLS_PER_RUN, 0])
    expect(completeMock).toHaveBeenCalledTimes(MAX_CELLS_PER_RUN / CELLS_PER_BATCH)
  })

  it("stops on abort and keeps the verdicts already collected", async () => {
    const controller = new AbortController()
    const cells = cellsFor(CELLS_PER_BATCH * 3)
    completeMock.mockImplementation(async () => {
      controller.abort()
      return verdictJson(cells.slice(0, CELLS_PER_BATCH).map((cell) => cell.id))
    })

    const rows = await refineApplicability({
      rule: makeRule("genre"),
      cells,
      coordsFor: (cell) => coordsOf(cell.id, cell.ref),
      existingIndex: buildApplicabilityIndex([]),
      settings: SETTINGS,
      signal: controller.signal,
    })

    expect(completeMock).toHaveBeenCalledTimes(1)
    // Only the first batch was judged, so only its cells can be coalesced.
    expect(rows.map((row) => [row.targetType, row.targetId])).toEqual([["section", "LUK 1"]])
    expect(rows[0].coveredCellIds).toHaveLength(CELLS_PER_BATCH)
  })

  it("propagates a completion failure that is not an abort", async () => {
    completeMock.mockRejectedValue(new Error("model unavailable"))

    await expect(
      refineApplicability({
        rule: makeRule("genre"),
        cells: cellsFor(2),
        coordsFor: (cell) => coordsOf(cell.id, cell.ref),
        existingIndex: buildApplicabilityIndex([]),
        settings: SETTINGS,
      }),
    ).rejects.toThrow("model unavailable")
  })

  it("never calls the model with no cells", async () => {
    const rows = await refineApplicability({
      rule: makeRule("genre"),
      cells: [],
      coordsFor: (cell) => coordsOf(cell.id),
      existingIndex: buildApplicabilityIndex([]),
      settings: SETTINGS,
    })

    expect(completeMock).not.toHaveBeenCalled()
    expect(rows).toEqual([])
  })
})
