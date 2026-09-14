import { beforeAll, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, useLocation } from "react-router-dom"
import { buildRunFeed } from "@/lib/agent/social-feed"
import type { ContextualActivityEvent, ContextualRunRecord } from "@/lib/contextual/transport"
import { TeamThreadDetail } from "./TeamThreadDetail"

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
const second: ContextualActivityEvent = {
  ...first,
  id: "read-2",
  spanId: "s2",
  spanLabel: "MRK 4:9–4:12",
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
      expect.objectContaining({ id: first.id, raw: { kind: "phase", details: first.details } }),
      trigger,
    )
  })

  it("lets keyboard activation of Review drafts navigate without opening the inspector", async () => {
    const user = userEvent.setup()
    const onInspect = vi.fn()
    render(detail([{ ...first, kind: "drafts_staged", details: { count: 3 } }], undefined, onInspect))
    screen.getByRole("link", { name: "Review drafts" }).focus()
    await user.keyboard("{Enter}")
    expect(screen.getByTestId("location")).toHaveTextContent("/project/p1/editor/file/file-1?lane=")
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
    expect(screen.getAllByText(/Reading the situation/)).toHaveLength(2)

    view.rerender(detail([
      first,
      second,
      { ...first, id: "draft-1", phase: "drafting", createdAt: "2026-08-28T12:00:03Z" },
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
