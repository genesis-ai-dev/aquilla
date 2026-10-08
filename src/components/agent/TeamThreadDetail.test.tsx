import { beforeAll, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, useLocation } from "react-router-dom"
import { buildRunFeed } from "@/lib/agent/social-feed"
import type { ContextualActivityEvent, ContextualRunRecord } from "@/lib/contextual/transport"
import { TeamThreadDetail } from "./TeamThreadDetail"
import { runReviewOf } from "@/hooks/useRunReview"

const spanLabel = "MRK 4:1–4:8"
const run: ContextualRunRecord = {
  runId: "run-1",
  fileId: "file-1",
  status: "running",
  phase: "reading",
  spanLabel,
  done: 0,
  total: 2,
  failed: 0,
  unitsSpent: 0,
  callsSpent: 0,
  lastError: null,
  createdAt: "2026-08-28T12:00:00Z",
  updatedAt: "2026-08-28T12:00:00Z",
  activeDirections: [],
  proposedDrafts: 0,
  targetLang: "",
}

const first: ContextualActivityEvent = {
  id: "read-1",
  projectId: "p1",
  runId: run.runId,
  fileId: run.fileId,
  kind: "phase",
  phase: "reading",
  spanId: "s1",
  spanLabel,
  summary: "",
  details: { step: "first" },
  createdAt: "2026-08-28T12:00:01Z",
}
// Same passage as `first`: routine updates fold per passage (a passage is one
// PR-timeline section), so two updates must share a passage to share a
// disclosure. A different region (same Drafter persona), because repeats of
// one region collapse.
const second: ContextualActivityEvent = {
  ...first,
  id: "draft-2",
  phase: "drafting",
  details: { step: "second" },
  createdAt: "2026-08-28T12:00:02Z",
}

function LocationProbe() {
  const location = useLocation()
  return <output data-testid="location">{location.pathname}{location.search}</output>
}

function detail(events: ContextualActivityEvent[], inspectedId?: string, onInspect = vi.fn()) {
  return (
    <MemoryRouter>
      <TeamThreadDetail
        projectId="p1"
        run={run}
        feed={buildRunFeed({ events, sceneBriefs: [] })}
        feedLoading={false}
        inspectedId={inspectedId}
        inspectorId="step-inspector"
        onInspect={onInspect}
      />
      <LocationProbe />
    </MemoryRouter>
  )
}

beforeAll(() => {
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  })
})

describe("TeamThreadDetail activity groups", () => {
  it("keeps message text passive and sends the original message plus trigger through the details action", async () => {
    const user = userEvent.setup()
    const onInspect = vi.fn()
    render(detail([first], undefined, onInspect))
    const text = screen.getByText(/Reading the situation/)
    fireEvent.click(text)
    expect(onInspect).not.toHaveBeenCalled()
    expect(text.closest("[data-feed-kind]")).not.toHaveAttribute("role")
    expect(text.closest("[data-feed-kind]")).not.toHaveAttribute("tabindex")
    // App chrome disables selection globally; message content must opt back in.
    expect(text.parentElement).toHaveClass("select-text")

    const trigger = screen.getByRole("button", { name: /^View details: Reading/ })
    expect(trigger.closest(".select-text")).toBeNull()
    await user.click(trigger)
    expect(onInspect).toHaveBeenCalledWith(
      expect.objectContaining({
        id: first.id,
        raw: expect.objectContaining({ kind: "phase", details: first.details, runId: first.runId }),
      }),
      trigger,
    )
  })

  it("lets keyboard activation of Review drafts navigate without opening the inspector", async () => {
    const user = userEvent.setup()
    const onInspect = vi.fn()
    render(detail([{ ...first, kind: "drafts_staged", details: { count: 3 } }], undefined, onInspect))
    screen.getByRole("link", { name: "Review drafts" }).focus()
    await user.keyboard("{Enter}")
    expect(screen.getByTestId("location")).toHaveTextContent("/project/p1/agent?conversation=run%3Arun-1&view=review")
    expect(onInspect).not.toHaveBeenCalled()
  })

  it("keeps a single routine update visible without adding an expander", () => {
    render(detail([first]))
    expect(screen.getByRole("group", { name: "Drafter" })).toHaveTextContent("Drafter")
    expect(screen.getByText(/Reading the situation/)).toBeVisible()
    expect(screen.queryByRole("button", { name: /activity updates/ })).not.toBeInTheDocument()
  })

  it("preserves expansion when polling refreshes and appends activity", () => {
    const view = render(detail([first, second]))
    fireEvent.click(screen.getByRole("button", { name: "Show 2 activity updates" }))

    view.rerender(detail([{ ...first }, { ...second }]))
    expect(screen.getByRole("button", { name: "Hide 2 activity updates" })).toHaveAttribute("aria-expanded", "true")
    expect(document.querySelectorAll('[data-feed-kind="phase"]')).toHaveLength(2)

    view.rerender(detail([
      first,
      second,
      { ...first, id: "read-3", createdAt: "2026-08-28T12:00:03Z" },
    ]))
    expect(screen.getByRole("button", { name: "Hide 3 activity updates" })).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByText(/Drafting MRK/)).toBeVisible()
  })

  it("supports keyboard disclosure without losing the trigger focus", async () => {
    const user = userEvent.setup()
    render(detail([first, second]))
    const trigger = screen.getByRole("button", { name: "Show 2 activity updates" })
    trigger.focus()

    await user.keyboard("{Enter}")
    expect(trigger).toHaveAttribute("aria-expanded", "true")
    expect(trigger).toHaveFocus()
    const contentId = trigger.getAttribute("aria-controls")
    expect(contentId).not.toBeNull()
    expect(document.getElementById(contentId!)).toHaveTextContent("Reading the situation")

    await user.keyboard(" ")
    expect(trigger).toHaveAttribute("aria-expanded", "false")
    expect(trigger).toHaveFocus()
    expect(screen.queryByText(/Reading the situation/)).not.toBeInTheDocument()
  })

  it("does not hide an inspected step when another routine update arrives", () => {
    const view = render(detail([first], first.id))
    view.rerender(detail([first, second], first.id))

    expect(screen.getByRole("button", { name: "Hide 2 activity updates" })).toHaveAttribute("aria-expanded", "true")
    const trigger = screen.getByRole("button", { name: /^Hide details: Reading the situation around MRK 4:1/ })
    expect(trigger).toHaveAttribute("aria-expanded", "true")
    expect(trigger).toHaveAttribute("aria-controls", "step-inspector")
  })
})

describe("TeamThreadDetail as a PR timeline", () => {
  const passage = (span: string, id: string, outcome: "complete" | "failed"): ContextualActivityEvent[] => [
    { ...first, id: `${id}-start`, kind: "span_started", phase: undefined, spanId: id, spanLabel: span, createdAt: "2026-08-28T12:00:01Z" },
    { ...first, id: `${id}-staged`, kind: "drafts_staged", phase: undefined, spanId: id, spanLabel: span, details: { count: 3 }, createdAt: "2026-08-28T12:00:02Z" },
    { ...first, id: `${id}-out`, kind: "span_outcome", phase: undefined, spanId: id, spanLabel: span, status: outcome, details: {}, createdAt: "2026-08-28T12:00:03Z" },
  ]
  const withReview = (events: ContextualActivityEvent[], review: ReturnType<typeof runReviewOf>) => (
    <MemoryRouter>
      <TeamThreadDetail
        projectId="p1"
        run={run}
        feed={buildRunFeed({ events, sceneBriefs: [] })}
        feedLoading={false}
        review={{ ...review, loading: false }}
      />
      <LocationProbe />
    </MemoryRouter>
  )

  // The point of the PR view: a long run's finished, clean passages fold to
  // one line each, so the passage that needs a person is what you see.
  it("folds a finished clean passage and keeps one that needs you open, with the Reviewer's review", () => {
    const events = [...passage("MRK 1:1–1:8", "p1", "complete"), ...passage("MRK 1:9–1:15", "p2", "complete")]
    const review = runReviewOf([{
      draftId: "d1", runId: run.runId, cellId: "c9", text: "t", spanLabel: "MRK 1:9–1:15",
      review: { findings: [{ code: "unsupported", kind: "unsupported", detail: null }], triage: "human", severity: 3 },
    }])
    render(withReview(events, review))

    const clean = document.querySelector('[data-passage="MRK 1:1–1:8"]')
    expect(clean).toHaveAttribute("data-notable", "false")
    expect(screen.getByRole("button", { name: /MRK 1:1–1:8 · 3 drafts · no issues/ })).toHaveAttribute("aria-expanded", "false")

    const flagged = document.querySelector('[data-passage="MRK 1:9–1:15"]')
    expect(flagged).toHaveAttribute("data-notable", "true")
    const entry = screen.getByTestId("passage-review")
    expect(entry).toHaveTextContent("Reviewed MRK 1:9–1:15: 1 finding · 1 needs you")
    fireEvent.click(screen.getByRole("link", { name: "View checks" }))
    expect(screen.getByTestId("location")).toHaveTextContent("view=checks")
  })

  it("keeps a failed passage open even with nothing flagged", () => {
    render(withReview(passage("MRK 2:1–2:4", "p3", "failed"), runReviewOf([])))
    expect(document.querySelector('[data-passage="MRK 2:1–2:4"]')).toHaveAttribute("data-notable", "true")
    expect(screen.queryByTestId("passage-review")).not.toBeInTheDocument()
  })
})
