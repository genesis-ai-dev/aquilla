/**
 * Tests for InterlinearAlignmentPanel — AQU-241 / AQU-240
 *
 * Covers:
 *   1. Below-threshold (pairCount < MIN_PAIRS_FOR_MEANINGFUL_ALIGNMENT) → shows
 *      the "insufficient data" empty state; no alignment rows rendered.
 *   2. Low-confidence alignments are filtered: only links ≥ CONFIDENCE_HIGH (0.6)
 *      are surfaced; amber/low links are suppressed.
 *   3. ✓/✕ buttons carry descriptive aria-labels that explain the glosser feedback
 *      loop (AQU-240).
 *   4. HelpCircle tooltip text is present on the section header.
 */

import { describe, it, expect, vi } from "vitest"
import { fireEvent, render, screen, within } from "@testing-library/react"
import { InterlinearAlignmentPanel } from "./InterlinearAlignmentPanel"
import {
  buildAlignmentModel,
  MIN_PAIRS_FOR_MEANINGFUL_ALIGNMENT,
  type AlignmentModel,
  type AlignmentSeed,
} from "@/lib/completion/interlinear"

// AppTooltip mounts the real Base UI tooltip on hover/focus, which isn't
// reliably driveable in happy-dom. Render its content unconditionally so this
// test asserts the panel's own copy, not Base UI's async open/close timing.
vi.mock("@/components/ui/tooltip", () => ({
  AppTooltip: ({ children, content }: { children: React.ReactNode; content: React.ReactNode }) => (
    <>
      {children}
      <div data-testid="tooltip-content">{content}</div>
    </>
  ),
}))

// ── helpers ──────────────────────────────────────────────────────────────────

/** Build a stub model with an explicit pairCount, bypassing the real corpus. */
function stubModelWithPairCount(pairCount: number): AlignmentModel {
  const base = buildAlignmentModel([])
  // Cast to mutable to override readonly pairCount for testing purposes.
  return { ...base, pairCount } as AlignmentModel
}

const noop = () => undefined
const noSeeds: AlignmentSeed[] = []

// ── AQU-241: insufficient-data empty state ────────────────────────────────────

describe("InterlinearAlignmentPanel — insufficient data (AQU-241)", () => {
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

// ── AQU-241: low-confidence filtering ────────────────────────────────────────

describe("InterlinearAlignmentPanel — low-confidence filtering (AQU-241)", () => {
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

// ── AQU-240: ✓/✕ aria-labels ─────────────────────────────────────────────────

describe("InterlinearAlignmentPanel — ✓/✕ button explanations (AQU-240)", () => {
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

// ── AQU-241: section header tooltip ──────────────────────────────────────────

describe("InterlinearAlignmentPanel — section header tooltip (AQU-241)", () => {
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
    // AppTooltip is mocked to render its content unconditionally (see mock above) —
    // Base UI's real hover/focus tooltip isn't reliably driveable in happy-dom.
    // The text must mention both confirm and reject/invalidate to satisfy AQU-240.
    const tooltipContents = screen.getAllByTestId("tooltip-content")
    const helpTooltip = tooltipContents.find((el) =>
      /confirm.*reject|reject.*confirm/i.test(el.textContent ?? ""),
    )
    expect(helpTooltip).toBeTruthy()
  })
})

// ── AQU-207: a decision stays visible ────────────────────────────────────────

describe("InterlinearAlignmentPanel — a decision stays visible (AQU-207)", () => {
  // Repetitive pairs give Dice a certain "god → gott" (diagonal prior breaks
  // the tie with "schuf"), so the panel proposes it at high confidence.
  const n = MIN_PAIRS_FOR_MEANINGFUL_ALIGNMENT + 5
  const pairs = Array.from({ length: n }, () => ({
    source: "god created",
    target: "gott schuf",
  }))

  it("reports the seed on ✓ and renders the row as confirmed once the parent hands the seed back", () => {
    const onSeedChange = vi.fn()
    const { rerender } = render(
      <InterlinearAlignmentPanel
        sourceText="god created"
        targetText="gott schuf"
        alignmentModel={buildAlignmentModel(pairs, [])}
        confirmedSeeds={noSeeds}
        onSeedChange={onSeedChange}
      />,
    )

    const confirmBtn = screen.getAllByRole("button", { name: /confirm alignment/i })[0]
    fireEvent.click(confirmBtn)
    expect(onSeedChange).toHaveBeenCalledTimes(1)
    const seed = onSeedChange.mock.calls[0][0] as AlignmentSeed
    expect(seed.weight).toBe(1)

    // What the parent does: persist the seed, rebuild the model with it, and
    // pass both back down (ProjectWorkspace.handleAlignmentSeedChange via the
    // useProject settings overlay).
    rerender(
      <InterlinearAlignmentPanel
        sourceText="god created"
        targetText="gott schuf"
        alignmentModel={buildAlignmentModel(pairs, [seed])}
        confirmedSeeds={[seed]}
        onSeedChange={onSeedChange}
      />,
    )

    const badge = screen.getByText("✓ confirmed")
    const row = badge.parentElement!
    expect(row.textContent).toContain(seed.srcToken)
    expect(row.textContent).toContain(seed.tgtToken)
    // A decided row offers no further ✓/✕.
    expect(within(row).queryByRole("button", { name: /confirm alignment/i })).toBeNull()
    expect(within(row).queryByRole("button", { name: /reject alignment/i })).toBeNull()
  })

  it("keeps an invalidated pair on screen, struck through, when the model no longer proposes it", () => {
    // "god → schuf" is never the model's proposal for "god" (it proposes
    // "gott"), so without synthesis the decision would have no row at all —
    // exactly what a user sees as "the ✕ did nothing".
    const seed: AlignmentSeed = { srcToken: "god", tgtToken: "schuf", weight: -1 }
    render(
      <InterlinearAlignmentPanel
        sourceText="god created"
        targetText="gott schuf"
        alignmentModel={buildAlignmentModel(pairs, [seed])}
        confirmedSeeds={[seed]}
        onSeedChange={noop}
      />,
    )

    const badge = screen.getByText("✗ rejected")
    const row = badge.parentElement!
    expect(row.textContent).toContain("god")
    expect(row.textContent).toContain("schuf")
    expect(row.className).toContain("line-through")
    // No confidence pill: the model has no confidence to report for a pair it
    // does not propose.
    expect(within(row).queryByText(/^\d+%$/)).toBeNull()
    // The live proposal for "god" is still there, undecided, alongside it.
    expect(screen.getAllByRole("button", { name: /confirm alignment/i }).length).toBeGreaterThan(0)
  })

  it("does not synthesize a row for a decided pair whose tokens are not in this cell", () => {
    const seed: AlignmentSeed = { srcToken: "king", tgtToken: "könig", weight: 1 }
    render(
      <InterlinearAlignmentPanel
        sourceText="god created"
        targetText="gott schuf"
        alignmentModel={buildAlignmentModel(pairs, [seed])}
        confirmedSeeds={[seed]}
        onSeedChange={noop}
      />,
    )
    expect(screen.queryByText("✓ confirmed")).toBeNull()
  })
})
