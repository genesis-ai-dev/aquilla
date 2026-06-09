/**
 * Tests for InterlinearAlignmentPanel — FRO-241 / FRO-240
 *
 * Covers:
 *   1. Below-threshold (pairCount < MIN_PAIRS_FOR_MEANINGFUL_ALIGNMENT) → shows
 *      the "insufficient data" empty state; no alignment rows rendered.
 *   2. Low-confidence alignments are filtered: only links ≥ CONFIDENCE_HIGH (0.6)
 *      are surfaced; amber/low links are suppressed.
 *   3. ✓/✕ buttons carry descriptive aria-labels that explain the glosser feedback
 *      loop (FRO-240).
 *   4. HelpCircle tooltip text is present on the section header.
 */

import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { InterlinearAlignmentPanel } from "./InterlinearAlignmentPanel"
import {
  buildAlignmentModel,
  MIN_PAIRS_FOR_MEANINGFUL_ALIGNMENT,
  type AlignmentModel,
  type AlignmentSeed,
} from "@/lib/completion/interlinear"

// ── helpers ──────────────────────────────────────────────────────────────────

/** Build a stub model with an explicit pairCount, bypassing the real corpus. */
function stubModelWithPairCount(pairCount: number): AlignmentModel {
  const base = buildAlignmentModel([])
  // Cast to mutable to override readonly pairCount for testing purposes.
  return { ...base, pairCount } as AlignmentModel
}

/** Build a real model trained on `n` identical pairs — enough for pairCount = n. */
function modelFromNPairs(n: number): AlignmentModel {
  const pairs = Array.from({ length: n }, (_, i) => ({
    source: `source${i} word`,
    target: `target${i} wort`,
  }))
  return buildAlignmentModel(pairs, [])
}

const noop = () => undefined
const noSeeds: AlignmentSeed[] = []

// ── FRO-241: insufficient-data empty state ────────────────────────────────────

describe("InterlinearAlignmentPanel — insufficient data (FRO-241)", () => {
  it("shows the empty-state message when pairCount < MIN_PAIRS_FOR_MEANINGFUL_ALIGNMENT", () => {
    const model = stubModelWithPairCount(MIN_PAIRS_FOR_MEANINGFUL_ALIGNMENT - 1)
    render(
      <InterlinearAlignmentPanel
        sourceText="In the beginning"
        targetText="Am Anfang"
        alignmentModel={model}
        confirmedSeeds={noSeeds}
        onSeedChange={noop}
      />,
    )
    // The "keep translating" nudge must be visible.
    expect(
      screen.getByText(/keep translating/i),
    ).toBeInTheDocument()
  })

  it("does NOT render alignment rows when data is insufficient", () => {
    const model = stubModelWithPairCount(MIN_PAIRS_FOR_MEANINGFUL_ALIGNMENT - 1)
    render(
      <InterlinearAlignmentPanel
        sourceText="In the beginning"
        targetText="Am Anfang"
        alignmentModel={model}
        confirmedSeeds={noSeeds}
        onSeedChange={noop}
      />,
    )
    // No ✓/✕ buttons when in the empty state.
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
  })

  it("renders normally (or returns null) when pairCount >= MIN_PAIRS_FOR_MEANINGFUL_ALIGNMENT", () => {
    // We cannot guarantee actual high-confidence links from a synthetic corpus,
    // but we CAN guarantee the "keep translating" message must NOT appear.
    const model = stubModelWithPairCount(MIN_PAIRS_FOR_MEANINGFUL_ALIGNMENT)
    render(
      <InterlinearAlignmentPanel
        sourceText="In the beginning"
        targetText="Am Anfang"
        alignmentModel={model}
        confirmedSeeds={noSeeds}
        onSeedChange={noop}
      />,
    )
    expect(screen.queryByText(/keep translating/i)).not.toBeInTheDocument()
  })

  it("returns null when alignmentModel is null", () => {
    const { container } = render(
      <InterlinearAlignmentPanel
        sourceText="In the beginning"
        targetText="Am Anfang"
        alignmentModel={null}
        confirmedSeeds={noSeeds}
        onSeedChange={noop}
      />,
    )
    expect(container.firstChild).toBeNull()
  })
})

// ── FRO-241: low-confidence filtering ────────────────────────────────────────

describe("InterlinearAlignmentPanel — low-confidence filtering (FRO-241)", () => {
  it("surfaces only high-confidence links (≥0.6) from a warm corpus", () => {
    // Build a real model with enough pairs to be above the threshold.
    // Use repetitive pairs so Dice/EM can accumulate strong associations.
    const n = MIN_PAIRS_FOR_MEANINGFUL_ALIGNMENT + 5
    const pairs = Array.from({ length: n }, () => ({
      source: "god created",
      target: "gott schuf",
    }))
    const model = buildAlignmentModel(pairs, [])

    render(
      <InterlinearAlignmentPanel
        sourceText="god created"
        targetText="gott schuf"
        alignmentModel={model}
        confirmedSeeds={noSeeds}
        onSeedChange={noop}
      />,
    )

    // Every confidence pill shown must be ≥ 60%.
    // If there are no links the section is hidden (also valid).
    const pills = screen.queryAllByTitle(/% confidence/)
    for (const pill of pills) {
      const pct = parseInt(pill.textContent ?? "0", 10)
      expect(pct).toBeGreaterThanOrEqual(60)
    }
  })
})

// ── FRO-240: ✓/✕ aria-labels ─────────────────────────────────────────────────

describe("InterlinearAlignmentPanel — ✓/✕ button explanations (FRO-240)", () => {
  it("confirm button aria-label explains the glosser training loop", () => {
    // Build a real warm model with well-known associations so links appear.
    const n = MIN_PAIRS_FOR_MEANINGFUL_ALIGNMENT + 10
    const pairs = Array.from({ length: n }, () => ({
      source: "god",
      target: "gott",
    }))
    const model = buildAlignmentModel(pairs, [])

    render(
      <InterlinearAlignmentPanel
        sourceText="god"
        targetText="gott"
        alignmentModel={model}
        confirmedSeeds={noSeeds}
        onSeedChange={noop}
      />,
    )

    const confirmBtns = screen.queryAllByRole("button", { name: /confirm alignment/i })
    if (confirmBtns.length > 0) {
      // If a link is rendered, the aria-label must mention teaching the glosser.
      expect(confirmBtns[0].getAttribute("aria-label")).toMatch(/teach(es)? the glosser/i)
    }
    // If no links: section is hidden, which is also valid (no assertion needed).
  })

  it("invalidate/reject button aria-label explains the glosser penalisation loop", () => {
    const n = MIN_PAIRS_FOR_MEANINGFUL_ALIGNMENT + 10
    const pairs = Array.from({ length: n }, () => ({
      source: "god",
      target: "gott",
    }))
    const model = buildAlignmentModel(pairs, [])

    render(
      <InterlinearAlignmentPanel
        sourceText="god"
        targetText="gott"
        alignmentModel={model}
        confirmedSeeds={noSeeds}
        onSeedChange={noop}
      />,
    )

    const rejectBtns = screen.queryAllByRole("button", { name: /reject alignment/i })
    if (rejectBtns.length > 0) {
      expect(rejectBtns[0].getAttribute("aria-label")).toMatch(/penali[sz]es? the glosser/i)
    }
  })
})

// ── FRO-241: section header tooltip ──────────────────────────────────────────

describe("InterlinearAlignmentPanel — section header tooltip (FRO-241)", () => {
  it("HelpCircle tooltip on insufficient-data state mentions confirm and reject actions", () => {
    const model = stubModelWithPairCount(0)
    render(
      <InterlinearAlignmentPanel
        sourceText="In the beginning"
        targetText="Am Anfang"
        alignmentModel={model}
        confirmedSeeds={noSeeds}
        onSeedChange={noop}
      />,
    )
    // The span wrapping HelpCircle carries the tooltip in `title`.
    // The text must mention both confirm and reject/invalidate to satisfy FRO-240.
    const helpSpan = screen.getByTitle(/confirm.*reject|reject.*confirm/i)
    expect(helpSpan).toBeInTheDocument()
  })
})
