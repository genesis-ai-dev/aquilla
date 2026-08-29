/**
 * TeamStepInspector tests — the Team surface's third column.
 *
 * The v3 live review (2026-08-28) asked for two things this file guards:
 *
 *  - the column is USER-SIZED. It opens wider than the old fixed 288px, and a
 *    reader who needs more room can drag its inline-start edge or nudge it
 *    with the arrow keys; the size is remembered for next time. The handle is
 *    a focusable separator, so this is reachable without a pointer at all.
 *  - no opaque machine token is rendered as PROSE. Outcome reasons arrive as
 *    codes ("span_failed"), so they are typed as codes — muted mono — while
 *    the sentence and the situation note stay plain language.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest"
import { render, screen, fireEvent, within } from "@testing-library/react"
import type { TeamFeedMessage } from "@/lib/agent/social-feed"
import { TeamStepInspector } from "./TeamStepInspector"

const WIDTH_KEY = "aquilla:team-step-inspector-width"
const DEFAULT_WIDTH = 320
const MIN_WIDTH = 260
const MAX_WIDTH = 560

function message(overrides: Partial<TeamFeedMessage> = {}): TeamFeedMessage {
  return {
    id: "e1",
    persona: "coordinator",
    at: "2026-08-28T12:00:05Z",
    body: { kind: "draftsStaged", spanLabel: "Mark 4:1–4:8", count: 3 },
    raw: { kind: "drafts_staged", details: { count: 3 } },
    ...overrides,
  }
}

function renderInspector(overrides: Partial<TeamFeedMessage> = {}) {
  return render(
    <TeamStepInspector
      message={message(overrides)}
      sentence="Put 3 drafts out for your review."
      onClose={() => {}}
    />,
  )
}

/** The panel element, whose inline `width` is what the drag moves. */
function panel(): HTMLElement {
  return screen.getByTestId("team-step-inspector")
}

function panelWidth(): number {
  return Number.parseInt(panel().style.width, 10)
}

function handle(): HTMLElement {
  return screen.getByTestId("team-step-inspector-resize")
}

/** One pointer drag of the handle, in CSS pixels along the x axis. */
function dragHandleBy(dx: number) {
  const target = handle()
  fireEvent.pointerDown(target, { button: 0, pointerId: 1, clientX: 500 })
  fireEvent.pointerMove(target, { pointerId: 1, clientX: 500 + dx })
  fireEvent.pointerUp(target, { pointerId: 1, clientX: 500 + dx })
}

beforeAll(() => {
  // ScrollArea uses @base-ui/react which calls getAnimations() — not in
  // happy-dom (same shim as TeamThreadsView.test).
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  })
})

beforeEach(() => {
  localStorage.clear()
})

describe("TeamStepInspector width", () => {
  it("opens wider than the old fixed column and exposes its range on the handle", () => {
    renderInspector()
    // 288px (w-72) was the width the review called too narrow.
    expect(panelWidth()).toBe(DEFAULT_WIDTH)
    expect(panelWidth()).toBeGreaterThan(288)

    const separator = handle()
    expect(separator).toHaveAttribute("role", "separator")
    expect(separator).toHaveAttribute("aria-orientation", "vertical")
    expect(separator).toHaveAttribute("aria-valuenow", String(DEFAULT_WIDTH))
    expect(separator).toHaveAttribute("aria-valuemin", String(MIN_WIDTH))
    expect(separator).toHaveAttribute("aria-valuemax", String(MAX_WIDTH))
    // Reachable by keyboard, or the arrow-key path below is unusable.
    expect(separator).toHaveAttribute("tabindex", "0")
  })

  it("drags wider toward the inline-start edge and narrower away from it (LTR)", () => {
    renderInspector()
    // The handle is on the panel's left edge in LTR: pulling it left grows the
    // panel, pushing it right shrinks it.
    dragHandleBy(-60)
    expect(panelWidth()).toBe(DEFAULT_WIDTH + 60)

    dragHandleBy(40)
    expect(panelWidth()).toBe(DEFAULT_WIDTH + 20)
  })

  it("mirrors the drag under dir=\"rtl\", where the same edge sits on the right", () => {
    // The app is RTL-aware, and the handle is placed with logical properties —
    // so under `dir="rtl"` the inline-start edge is the panel's RIGHT edge and
    // the pointer delta's sign flips. happy-dom does not resolve the `dir`
    // attribute into a computed `direction` (it answers "ltr" either way), so
    // the RTL branch is reached by stubbing the one lookup the component makes.
    const realGetComputedStyle = window.getComputedStyle.bind(window)
    vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudo) => {
      const real = realGetComputedStyle(element as Element, pseudo)
      return new Proxy(real, {
        get: (target, prop) => (prop === "direction" ? "rtl" : Reflect.get(target, prop, target)),
      })
    })
    try {
      renderInspector()
      // Pushing right now GROWS the panel — the opposite of the LTR case.
      dragHandleBy(60)
      expect(panelWidth()).toBe(DEFAULT_WIDTH + 60)

      // And ArrowRight widens, matching the pointer.
      fireEvent.keyDown(handle(), { key: "ArrowRight" })
      expect(panelWidth()).toBe(DEFAULT_WIDTH + 76)
    } finally {
      vi.restoreAllMocks()
    }
  })

  it("clamps a drag to the legible range instead of collapsing or swallowing the thread", () => {
    renderInspector()
    dragHandleBy(9999)
    expect(panelWidth()).toBe(MIN_WIDTH)

    dragHandleBy(-9999)
    expect(panelWidth()).toBe(MAX_WIDTH)
  })

  it("nudges by 16px with the arrow keys (LTR: left widens)", () => {
    renderInspector()
    fireEvent.keyDown(handle(), { key: "ArrowLeft" })
    expect(panelWidth()).toBe(DEFAULT_WIDTH + 16)

    fireEvent.keyDown(handle(), { key: "ArrowRight" })
    fireEvent.keyDown(handle(), { key: "ArrowRight" })
    expect(panelWidth()).toBe(DEFAULT_WIDTH - 16)

    // An unrelated key must not resize — the separator is still in a page the
    // reader tabs through.
    fireEvent.keyDown(handle(), { key: "Enter" })
    expect(panelWidth()).toBe(DEFAULT_WIDTH - 16)
  })

  it("remembers the width per browser, across steps and across mounts", () => {
    const first = renderInspector()
    dragHandleBy(-80)
    expect(localStorage.getItem(WIDTH_KEY)).toBe(String(DEFAULT_WIDTH + 80))
    first.unmount()

    // A later step, opened fresh, keeps the size the reader chose.
    const later = renderInspector({ id: "e2", raw: { kind: "span_outcome", details: {} } })
    expect(panelWidth()).toBe(DEFAULT_WIDTH + 80)
    later.unmount()

    // A keyboard nudge persists on the same terms as a drag.
    const keyed = renderInspector()
    fireEvent.keyDown(handle(), { key: "ArrowRight" })
    expect(localStorage.getItem(WIDTH_KEY)).toBe(String(DEFAULT_WIDTH + 64))
    keyed.unmount()
  })

  it("opens at a legible width when the stored value is out of range or corrupt", () => {
    localStorage.setItem(WIDTH_KEY, "99999")
    const clamped = renderInspector()
    expect(panelWidth()).toBe(MAX_WIDTH)
    clamped.unmount()

    localStorage.setItem(WIDTH_KEY, "not-a-number")
    renderInspector()
    expect(panelWidth()).toBe(DEFAULT_WIDTH)
  })
})

describe("TeamStepInspector copy", () => {
  it("types outcome reasons as diagnostic codes, not as prose", () => {
    renderInspector({
      body: { kind: "outcome", spanLabel: "Mark 4:1–4:8", status: "failed", reasons: ["span_failed"] },
      raw: { kind: "span_outcome", details: { reasons: ["span_failed"] } },
    })
    fireEvent.click(screen.getByRole("button", { name: "Why" }))
    const reason = screen.getByText("span_failed")
    expect(reason.className).toContain("font-mono")
    expect(reason.closest("ul")?.className).toContain("text-muted-foreground")
  })

  it("keeps the sentence and the situation note in plain language", () => {
    renderInspector({
      body: {
        kind: "sceneReady",
        spanLabel: "Mark 4:1–4:8",
        ambiguityCount: 1,
        excerpt: "Jesus teaches by the lake.",
      },
      raw: { kind: "scene_ready", details: { ambiguityCount: 1 } },
    })
    const inspector = panel()
    expect(within(inspector).getByText("Put 3 drafts out for your review.")).toBeInTheDocument()
    // The raw event id is a receipt, not copy: it must not surface as a
    // sentence anywhere in the header/note area.
    expect(within(inspector).queryByText("e1")).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Situation note" }))
    const note = screen.getByText("Jesus teaches by the lake.")
    expect(note.className).not.toContain("font-mono")
  })
})
