/**
 * RefineApplicabilityDialog — AI-proposed, human-confirmed applicability rows
 * (AQU-934 phase 3c).
 *
 * The refiner itself is mocked (it has its own suite); these tests are about
 * the dialog's contract: what it inspects, what it shows, that a run can be
 * cancelled, and — the point of the whole surface — that NOTHING is written
 * until a person confirms, and what is written is marked as theirs.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react"

vi.mock("@/lib/rules/applicability-refiner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rules/applicability-refiner")>()),
  refineApplicability: vi.fn(),
}))

import {
  MAX_CELLS_PER_RUN,
  refineApplicability,
  type ProposedApplicability,
  type RefineApplicabilityInput,
} from "@/lib/rules/applicability-refiner"
import type { CompletionSettings } from "@/lib/parsers/types"
import type { RuleApplicability, StyleRule } from "@/lib/rules/style-rule-types"
import {
  RefineApplicabilityDialog,
  type RefineSegment,
} from "./RefineApplicabilityDialog"

const refineMock = vi.mocked(refineApplicability)
const onClose = vi.fn()
const onConfirm = vi.fn()
const loadSegments = vi.fn<(fileId: string | null, signal: AbortSignal) => Promise<readonly RefineSegment[]>>()

const SETTINGS = { model: "test-model", maxTokens: 8192, temperature: 0.7 } as CompletionSettings

const RULE: StyleRule = {
  id: "rule-1",
  orgId: null,
  projectId: "proj-1",
  instruction: "Keep direct speech in the vernacular register",
  category: "register",
  scope: "global",
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
}

const FILES = [
  { id: "f-luk", name: "Luke" },
  { id: "f-notes", name: "Leader notes" },
]

function segment(id: string, ref: string): RefineSegment {
  return {
    id,
    text: `Text of ${id}`,
    ref,
    coords: { segment: id, file: "f-luk", passageRef: ref, section: ref.split(":")[0] },
  }
}

const PROPOSALS: ProposedApplicability[] = [
  {
    targetType: "section",
    targetId: "LUK 1",
    relationship: "applies",
    confidence: 0.9,
    reason: "every verse is quoted speech",
    coveredCellIds: ["c1", "c2", "c3"],
  },
  {
    targetType: "segment",
    targetId: "c9",
    relationship: "excluded",
    confidence: 0.4,
    reason: "a narrative aside, no speech",
    coveredCellIds: ["c9"],
  },
]

function renderDialog(overrides: Partial<Parameters<typeof RefineApplicabilityDialog>[0]> = {}) {
  return render(
    <RefineApplicabilityDialog
      rule={RULE}
      files={FILES}
      loadSegments={loadSegments}
      rows={[]}
      settings={SETTINGS}
      session={{ jwt: "tok", username: "alice", createdAt: "2026-01-01T00:00:00.000Z" }}
      canManage
      onClose={onClose}
      onConfirm={onConfirm}
      {...overrides}
    />,
  )
}

/** Base UI commits a Select option on Enter after it is pointed at. */
async function chooseScope(optionName: string) {
  fireEvent.click(screen.getByLabelText("Segments to inspect"))
  const option = await screen.findByRole("option", { name: optionName })
  fireEvent.pointerMove(option)
  fireEvent.mouseMove(option)
  fireEvent.keyDown(option, { key: "Enter" })
}

/** Run to completion and land in the review list. */
async function runToReview() {
  fireEvent.click(screen.getByRole("button", { name: /Start inspection/ }))
  await waitFor(() => expect(refineMock).toHaveBeenCalled())
  return screen.findByText("LUK 1")
}

beforeEach(() => {
  vi.clearAllMocks()
  loadSegments.mockResolvedValue([segment("c1", "LUK 1:1"), segment("c2", "LUK 1:2")])
  refineMock.mockResolvedValue(PROPOSALS)
})

// ── Opening and scope ──────────────────────────────────────────────────────

describe("RefineApplicabilityDialog — scope", () => {
  it("stays closed without a rule", () => {
    renderDialog({ rule: null })
    expect(screen.queryByText("Refine where this rule applies")).not.toBeInTheDocument()
  })

  it("names the rule it is refining and offers the project plus each file", async () => {
    renderDialog()

    expect(screen.getByText("Refine where this rule applies")).toBeInTheDocument()
    expect(screen.getByText(RULE.instruction)).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText("Segments to inspect"))
    expect(await screen.findByRole("option", { name: "All documents" })).toBeInTheDocument()
    expect(screen.getByRole("option", { name: "Luke" })).toBeInTheDocument()
    expect(screen.getByRole("option", { name: "Leader notes" })).toBeInTheDocument()
  })

  it("inspects the whole project by default", async () => {
    renderDialog()
    await runToReview()

    expect(loadSegments.mock.calls[0][0]).toBeNull()
  })

  it("inspects only the chosen file", async () => {
    renderDialog()
    await chooseScope("Luke")
    await runToReview()

    expect(loadSegments.mock.calls[0][0]).toBe("f-luk")
  })

  it("refines against this rule's own rows only", async () => {
    const rows: RuleApplicability[] = [
      {
        id: "app-1",
        ruleId: "rule-2",
        targetType: "book",
        targetId: "PSA",
        relationship: "applies",
        confidence: null,
        reason: null,
        assignedBy: "human",
        createdBy: "alice",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]
    renderDialog({ rows })
    await runToReview()

    const input = refineMock.mock.calls[0][0] as RefineApplicabilityInput
    expect(input.existingIndex.byRule.has("rule-2")).toBe(false)
  })

  it("cannot start without a model configured", () => {
    renderDialog({ settings: undefined })

    expect(screen.getByRole("button", { name: /Start inspection/ })).toBeDisabled()
    expect(
      screen.getByText("Set up an AI model for this project before inspecting segments."),
    ).toBeInTheDocument()
  })
})

// ── Running ────────────────────────────────────────────────────────────────

describe("RefineApplicabilityDialog — running", () => {
  it("reports progress while the run walks the segments", async () => {
    refineMock.mockImplementation(async (input) => {
      input.onProgress?.(0, 120, 0)
      input.onProgress?.(60, 120, 7)
      await new Promise<void>((resolve) => {
        input.signal?.addEventListener("abort", () => resolve())
      })
      return PROPOSALS
    })
    renderDialog()

    fireEvent.click(screen.getByRole("button", { name: /Start inspection/ }))

    expect(await screen.findByText("Segment 60 of 120")).toBeInTheDocument()
    expect(screen.getByText("7 matches so far")).toBeInTheDocument()
  })

  it("cancels a running pass and reviews what it found", async () => {
    refineMock.mockImplementation(async (input) => {
      input.onProgress?.(0, 120, 0)
      await new Promise<void>((resolve) => {
        input.signal?.addEventListener("abort", () => resolve())
      })
      return [PROPOSALS[0]]
    })
    renderDialog()

    fireEvent.click(screen.getByRole("button", { name: /Start inspection/ }))
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }))

    expect(await screen.findByText("LUK 1")).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })

  it("says so when the scope was too big to inspect whole", async () => {
    loadSegments.mockResolvedValue(
      Array.from({ length: MAX_CELLS_PER_RUN + 1 }, (_, i) => segment(`c${i}`, `LUK 1:${i + 1}`)),
    )
    renderDialog()
    await runToReview()

    expect(
      screen.getByText(`Only the first ${MAX_CELLS_PER_RUN} segments of this scope were inspected.`),
    ).toBeInTheDocument()
  })

  it("surfaces a failed run without proposing anything", async () => {
    refineMock.mockRejectedValue(new Error("model unavailable"))
    renderDialog()

    fireEvent.click(screen.getByRole("button", { name: /Start inspection/ }))

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Inspection stopped: model unavailable",
    )
    expect(screen.queryByRole("button", { name: /Confirm/ })).not.toBeInTheDocument()
  })

  it("reports a run that has nothing new to propose", async () => {
    refineMock.mockResolvedValue([])
    renderDialog()

    fireEvent.click(screen.getByRole("button", { name: /Start inspection/ }))

    expect(await screen.findByText(/Nothing new to propose/)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Confirm/ })).not.toBeInTheDocument()
  })
})

// ── Reviewing and confirming ───────────────────────────────────────────────

describe("RefineApplicabilityDialog — review", () => {
  it("groups proposals by relationship with their evidence", async () => {
    renderDialog()
    await runToReview()

    expect(screen.getByText("Applies")).toBeInTheDocument()
    expect(screen.getByText("Excluded")).toBeInTheDocument()

    const applies = screen.getByText("LUK 1").closest("li") as HTMLElement
    expect(within(applies).getByText("Chapter or section")).toBeInTheDocument()
    expect(within(applies).getByText("3 segments")).toBeInTheDocument()
    expect(within(applies).getByText("90% confident")).toBeInTheDocument()
    expect(within(applies).getByText("every verse is quoted speech")).toBeInTheDocument()

    const excluded = screen.getByText("c9").closest("li") as HTMLElement
    expect(within(excluded).getByText("Segment")).toBeInTheDocument()
    expect(within(excluded).getByText("1 segment")).toBeInTheDocument()
  })

  it("writes nothing until the proposals are confirmed", async () => {
    renderDialog()
    await runToReview()

    expect(onConfirm).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "Confirm 2 targets" }))

    expect(onConfirm).toHaveBeenCalledWith([
      {
        targetType: "section",
        targetId: "LUK 1",
        relationship: "applies",
        assignedBy: "human",
        confidence: 0.9,
        reason: "every verse is quoted speech",
      },
      {
        targetType: "segment",
        targetId: "c9",
        relationship: "excluded",
        assignedBy: "human",
        confidence: 0.4,
        reason: "a narrative aside, no speech",
      },
    ])
    expect(onClose).toHaveBeenCalled()
  })

  it("saves only the proposals still ticked", async () => {
    renderDialog()
    await runToReview()

    fireEvent.click(screen.getByRole("checkbox", { name: "Include c9" }))
    fireEvent.click(screen.getByRole("button", { name: "Confirm 1 target" }))

    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onConfirm.mock.calls[0][0]).toHaveLength(1)
    expect(onConfirm.mock.calls[0][0][0].targetId).toBe("LUK 1")
  })

  it("clears and restores the whole selection in one act", async () => {
    renderDialog()
    await runToReview()

    fireEvent.click(screen.getByRole("button", { name: "Clear" }))
    expect(screen.getByRole("button", { name: "Confirm 0 targets" })).toBeDisabled()

    fireEvent.click(screen.getByRole("button", { name: "Select all" }))
    expect(screen.getByRole("button", { name: "Confirm 2 targets" })).toBeEnabled()
  })

  it("discards the proposals without writing", async () => {
    renderDialog()
    await runToReview()

    fireEvent.click(screen.getByRole("button", { name: "Discard" }))

    expect(onConfirm).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it("keeps the confirm action locked below the applicability floor", async () => {
    renderDialog({ canManage: false })
    await runToReview()

    expect(screen.getByRole("button", { name: "Confirm 2 targets" })).toBeDisabled()
  })
})
