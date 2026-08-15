// The pairing review drawer. (AQU-646 stage 4)
//
// The list exists because the timeline's amber chips tell you WHERE unpaired
// cells are and nothing about whether they matter. So what is worth testing is
// that the drawer preserves the distinction the analysis draws: a near-certain
// pairing and a there-is-nothing-else-nearby guess must not read as the same
// kind of decision, and the hopeless cases must not compete with either.

import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent, within } from "@testing-library/react"

import { CueLinkDrawer } from "./CueLinkDrawer"
import type { CueLinkReview } from "@/lib/timeline/cue-link-review"
import type { LinkableCue } from "@/lib/timeline/cue-links"

const cue = (id: string, startTime: number, original: string): LinkableCue => ({
  id,
  startTime,
  endTime: startTime + 1,
  original,
})

const textById = new Map([
  ["s1", cue("s1", 73.2, "No.")],
  ["s2", cue("s2", 480.1, "Right here.")],
  ["s3", cue("s3", 23, "THE CHOSEN IS BASED ON")],
  ["s4", cue("s4", 984, "Messiah will destroy the Romans")],
])
const cueById = new Map([
  ["c1", cue("c1", 73.9, "No.")],
  ["c2", cue("c2", 480.3, "Matthew! Psst.")],
  ["c3", cue("c3", 313, "Whoa!")],
  ["c4", cue("c4", 984.2, "המשיח יהרוס את הרומאים")],
])

const review = (over: Partial<CueLinkReview> = {}): CueLinkReview => ({
  confident: [],
  crossScriptCandidates: [],
  weakCandidates: [],
  uncertain: [],
  unpairedCues: [],
  unpairedText: [],
  lowConfidence: [],
  crossScript: [],
  actionable: 0,
  ...over,
})

function renderDrawer(r: CueLinkReview | null, over: Record<string, unknown> = {}) {
  const onPair = vi.fn()
  const onReject = vi.fn()
  const onNavigate = vi.fn()
  const onNavigateText = vi.fn()
  const onRepairAll = vi.fn()
  const onClose = vi.fn()
  render(
    <CueLinkDrawer
      review={r}
      textById={textById}
      cueById={cueById}
      onClose={onClose}
      onNavigate={onNavigate}
      onNavigateText={onNavigateText}
      onPair={onPair}
      onReject={onReject}
      onRepairAll={onRepairAll}
      {...over}
    />,
  )
  return { onPair, onReject, onNavigate, onNavigateText, onRepairAll, onClose }
}

const confidentRow = { cueCellId: "c1", textCellId: "s1", similarity: 1, gapSec: 0.7 }
const uncertainRow = { cueCellId: "c2", textCellId: "s2", similarity: 0, gapSec: 0.2 }

describe("the two kinds of proposal", () => {
  it("keeps them in separate groups with different headings", () => {
    // Same evidence — the only candidate in a gap — but a 100% and a 0% are
    // not the same decision, and ranking them on one axis would say they are.
    renderDrawer(review({ confident: [confidentRow], uncertain: [uncertainRow], actionable: 2 }))
    expect(screen.getByText(/Almost certainly the same line/)).toBeInTheDocument()
    expect(screen.getByText(/The only candidate nearby/)).toBeInTheDocument()
  })

  it("shows both lines of a proposal so it can be judged without leaving", () => {
    renderDrawer(review({ confident: [confidentRow], actionable: 1 }))
    const row = screen.getByTestId("cue-link-candidate-c1")
    // Both sides are shown, and here they are the same words — which is
    // exactly the evidence that makes this row a near-certain accept.
    expect(within(row).getAllByText(/No\./)).toHaveLength(2)
    expect(within(row).getByText(/heard/)).toBeInTheDocument()
    expect(within(row).getByText(/line/)).toBeInTheDocument()
    expect(within(row).getByText(/100% · 0\.7s/)).toBeInTheDocument()
  })

  it("offers both answers, and they are the same event with a different boolean", () => {
    const { onPair, onReject } = renderDrawer(review({ confident: [confidentRow], actionable: 1 }))
    fireEvent.click(screen.getByTestId("cue-link-pair-c1"))
    expect(onPair).toHaveBeenCalledWith("s1", "c1")
    fireEvent.click(screen.getByTestId("cue-link-reject-c1"))
    expect(onReject).toHaveBeenCalledWith("s1", "c1")
  })

  it("navigates from ANYWHERE on the card, carrying the proposed line", () => {
    // Clicking the padding beside the words used to do nothing, and the
    // proposed subtitle has to travel with it: the pairing does not exist yet,
    // so following the cue's links would find none and clear the selection —
    // which is exactly the "nothing happens" this row used to produce.
    const { onNavigate } = renderDrawer(review({ confident: [confidentRow], actionable: 1 }))
    fireEvent.click(screen.getByTestId("cue-link-candidate-c1"))
    expect(onNavigate).toHaveBeenCalledWith("c1", ["s1"])
  })

  it("does not navigate when an action button is pressed", () => {
    // A click that both pairs and scrolls would make the list jump under the
    // pointer as it shortens.
    const { onNavigate, onPair } = renderDrawer(review({ confident: [confidentRow], actionable: 1 }))
    fireEvent.click(screen.getByTestId("cue-link-pair-c1"))
    expect(onPair).toHaveBeenCalledOnce()
    expect(onNavigate).not.toHaveBeenCalled()
  })
})

describe("the cases with no answer", () => {
  it("collapses them into a count rather than competing with the rows", () => {
    // "Whoa!" and the opening screen cards are facts, not problems.
    renderDrawer(review({ unpairedCues: ["c3"], unpairedText: ["s3"] }))
    expect(screen.getByTestId("cue-link-orphan-cues")).toHaveTextContent(
      "1 heard line with no subtitle nearby",
    )
    expect(screen.getByTestId("cue-link-orphan-text")).toHaveTextContent(
      "1 line with no speech nearby",
    )
    // Collapsed: the text itself is not on screen until asked for.
    expect(screen.queryByText(/Whoa!/)).not.toBeInTheDocument()
  })

  it("opens on demand", () => {
    renderDrawer(review({ unpairedCues: ["c3"] }))
    fireEvent.click(screen.getByTestId("cue-link-orphan-cues"))
    expect(screen.getByText(/Whoa!/)).toBeInTheDocument()
  })

  it("navigates from an orphan HEARD line", () => {
    // These used to be inert, which made the count feel like a dead end.
    const { onNavigate } = renderDrawer(review({ unpairedCues: ["c3"] }))
    fireEvent.click(screen.getByTestId("cue-link-orphan-cues"))
    fireEvent.click(screen.getByText(/Whoa!/))
    expect(onNavigate).toHaveBeenCalledWith("c3")
  })

  it("navigates an orphan SUBTITLE through its own path", () => {
    // A subtitle has a row of its own, so it does not go through the cue
    // navigation — that one follows pairings this line has none of.
    const { onNavigateText, onNavigate } = renderDrawer(review({ unpairedText: ["s3"] }))
    fireEvent.click(screen.getByTestId("cue-link-orphan-text"))
    fireEvent.click(screen.getByText(/THE CHOSEN IS BASED ON/))
    expect(onNavigateText).toHaveBeenCalledWith("s3")
    expect(onNavigate).not.toHaveBeenCalled()
  })

  it("says nothing at all when there are none", () => {
    renderDrawer(review())
    expect(screen.queryByTestId("cue-link-orphan-cues")).not.toBeInTheDocument()
  })
})

describe("what the matcher found but would not pair", () => {
  // Sam, 2026-08-15: a cross-script or weak-wording match should be FLAGGED,
  // not written. Nothing verified what those two lines say, so pairing them
  // silently makes the person's job noticing what was decided for them.
  const row = { cueCellId: "c4", textCellId: "s4", similarity: 0, gapSec: 0.2 }

  it("offers a cross-script match as its own group", () => {
    renderDrawer(review({ crossScriptCandidates: [row], actionable: 1 }))
    expect(screen.getByText(/Different writing systems/)).toBeInTheDocument()
    expect(screen.getByTestId("cue-link-pair-c4")).toBeInTheDocument()
  })

  it("offers a weak-wording match as a different group", () => {
    renderDrawer(review({ weakCandidates: [{ ...row, similarity: 0.3 }], actionable: 1 }))
    expect(screen.getByText(/Overlapping, words barely agree/)).toBeInTheDocument()
  })

  it("counts them in the size of the job", () => {
    renderDrawer(review({ crossScriptCandidates: [row], weakCandidates: [row], actionable: 2 }))
    expect(screen.getByTestId("cue-link-actionable")).toHaveTextContent("2 to review")
  })
})

describe("existing pairings worth a look", () => {
  it("separates the cross-script ones — nothing compared their words", () => {
    renderDrawer(
      review({ crossScript: [{ cueCellId: "c4", textCellId: "s4", confidence: 0.8 }], actionable: 1 }),
    )
    expect(screen.getByText(/Paired on timing alone/)).toBeInTheDocument()
    expect(screen.getByTestId("cue-link-pair-row-c4")).toBeInTheDocument()
  })

  it("navigates an existing pairing to both surfaces too", () => {
    const { onNavigate } = renderDrawer(
      review({ crossScript: [{ cueCellId: "c4", textCellId: "s4", confidence: 0.8 }], actionable: 1 }),
    )
    fireEvent.click(screen.getByTestId("cue-link-pair-row-c4"))
    expect(onNavigate).toHaveBeenCalledWith("c4", ["s4"])
  })

  it("lets an existing pairing be undone from here too", () => {
    const { onReject } = renderDrawer(
      review({ lowConfidence: [{ cueCellId: "c2", textCellId: "s2", confidence: 0.3 }], actionable: 1 }),
    )
    fireEvent.click(screen.getByText("Not a pair"))
    expect(onReject).toHaveBeenCalledWith("s2", "c2")
  })

  it("does not navigate when undoing one", () => {
    const { onNavigate } = renderDrawer(
      review({ lowConfidence: [{ cueCellId: "c2", textCellId: "s2", confidence: 0.3 }], actionable: 1 }),
    )
    fireEvent.click(screen.getByText("Not a pair"))
    expect(onNavigate).not.toHaveBeenCalled()
  })
})

describe("the drawer's own state", () => {
  it("reports the size of the job", () => {
    renderDrawer(review({ confident: [confidentRow], uncertain: [uncertainRow], actionable: 2 }))
    expect(screen.getByTestId("cue-link-actionable")).toHaveTextContent("2 to review")
  })

  it("says so when there is nothing to do", () => {
    renderDrawer(review())
    expect(screen.getByTestId("cue-link-actionable")).toHaveTextContent("nothing to review")
  })

  it("shows the matcher working instead of a count", () => {
    renderDrawer(review(), { pending: true })
    expect(screen.getByText(/working…/)).toBeInTheDocument()
    expect(screen.queryByTestId("cue-link-actionable")).not.toBeInTheDocument()
  })

  it("asks twice before re-pairing everything", () => {
    // It discards hand corrections, so it does not get to be one click.
    const { onRepairAll } = renderDrawer(review())
    fireEvent.click(screen.getByTestId("cue-link-repair"))
    expect(onRepairAll).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("cue-link-repair-go"))
    expect(onRepairAll).toHaveBeenCalledOnce()
  })

  it("closes", () => {
    const { onClose } = renderDrawer(review())
    fireEvent.click(screen.getByLabelText("Close"))
    expect(onClose).toHaveBeenCalledOnce()
  })
})
