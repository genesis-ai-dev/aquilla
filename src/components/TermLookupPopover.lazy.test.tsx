// AQU-2654: the source column wraps every highlighted term of every row in a
// TermLookupPopover. The lookup over the glossary belongs to opening the
// popover, not to drawing the row.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { TermLookupPopover } from "./TermLookupPopover"
import { conceptsForSourceSurface } from "@/lib/terminology/source-lookup"
import type { Concept } from "@/lib/terminology/types"

vi.mock("@/lib/terminology/source-lookup", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/terminology/source-lookup")>()
  return { ...actual, conceptsForSourceSurface: vi.fn(actual.conceptsForSourceSurface) }
})

const lookup = vi.mocked(conceptsForSourceSurface)

function concept(id: string, sourceTerm: string, more: Partial<Concept> = {}): Concept {
  return {
    id,
    sourceTerm,
    renderings: [{ rendering: `rendering of ${id}`, status: "preferred" }],
    status: "active",
    createdAt: "2026-01-01T00:00:00Z",
    ...more,
  }
}

const SPIRIT = concept("spirit", "spirit")
const HOLY_SPIRIT = concept("holy-spirit", "Holy Spirit")
const CONCEPTS = [SPIRIT, HOLY_SPIRIT, concept("grace", "grace")]

beforeEach(() => {
  lookup.mockClear()
})

describe("TermLookupPopover with knownConcepts", () => {
  it("decorates the trigger without looking the surface up, and looks it up when opened", () => {
    render(
      <TermLookupPopover sourceTerm="Spirit" concepts={CONCEPTS} knownConcepts={[SPIRIT]}>
        <span>Spirit</span>
      </TermLookupPopover>,
    )
    const trigger = screen.getByText("Spirit")
    expect(trigger).toHaveAttribute("data-slot", "popover-trigger")
    expect(lookup).not.toHaveBeenCalled()

    fireEvent.click(trigger)
    // The popover shows the LOOKUP's answer, not the hint: the phrase entry
    // that contains the word is there too.
    expect(screen.getByText("rendering of spirit")).toBeInTheDocument()
    expect(screen.getByText("rendering of holy-spirit")).toBeInTheDocument()
    expect(screen.queryByText("rendering of grace")).not.toBeInTheDocument()
    expect(lookup).toHaveBeenCalled()
  })

  it("renders the same popover as it does without the hint", () => {
    const { unmount } = render(
      <TermLookupPopover sourceTerm="Spirit" concepts={CONCEPTS} knownConcepts={[SPIRIT]}>
        <span>Spirit</span>
      </TermLookupPopover>,
    )
    fireEvent.click(screen.getByText("Spirit"))
    const hinted = screen.getByRole("tooltip").innerHTML
    unmount()

    render(
      <TermLookupPopover sourceTerm="Spirit" concepts={CONCEPTS}>
        <span>Spirit</span>
      </TermLookupPopover>,
    )
    fireEvent.click(screen.getByText("Spirit"))
    expect(screen.getByRole("tooltip").innerHTML).toBe(hinted)
  })

  it("falls back to the lookup when the hinted concept does not answer it", () => {
    // The matcher highlighted "Spirit" for this concept, but the lookup turns
    // an excluded surface away whatever the matcher's fold says — so the hint
    // cannot decide, and the lookup (here: nothing) does.
    const excluded = concept("x", "spirit", { match: { excludedForms: ["spirit"] } })
    render(
      <TermLookupPopover sourceTerm="Spirit" concepts={[excluded]} knownConcepts={[excluded]}>
        <span>Spirit</span>
      </TermLookupPopover>,
    )
    expect(screen.getByText("Spirit")).not.toHaveAttribute("data-slot")
    expect(lookup).toHaveBeenCalledTimes(1)
  })

  it("without a hint the lookup decides, as before", () => {
    render(
      <TermLookupPopover sourceTerm="unrelated" concepts={CONCEPTS}>
        <span>unrelated</span>
      </TermLookupPopover>,
    )
    expect(screen.getByText("unrelated")).not.toHaveAttribute("data-slot")
    expect(lookup).toHaveBeenCalledTimes(1)
  })
})

describe("TermLookupPopover on an inline trigger: closed is unmounted", () => {
  function renderTerm(onClick?: () => void) {
    return render(
      <div>
        <button type="button">elsewhere</button>
        <TermLookupPopover sourceTerm="Spirit" concepts={CONCEPTS} knownConcepts={[SPIRIT]}>
          <span className="terminology-highlight" onClick={onClick}>Spirit</span>
        </TermLookupPopover>
      </div>,
    )
  }
  /** A real press: the events a browser sends for one click, in order. */
  function press(element: HTMLElement) {
    fireEvent.pointerDown(element)
    fireEvent.mouseDown(element)
    fireEvent.pointerUp(element)
    fireEvent.mouseUp(element)
    fireEvent.click(element)
  }

  it("is the caller's element with a popover trigger's attributes, and nothing else in the document", () => {
    const { container } = renderTerm()
    const trigger = screen.getByText("Spirit")
    // What Base UI's Popover.Trigger puts on a non-button element while closed.
    expect(trigger).toHaveAttribute("role", "button")
    expect(trigger).toHaveAttribute("tabindex", "0")
    expect(trigger).toHaveAttribute("aria-haspopup", "dialog")
    expect(trigger).toHaveAttribute("aria-expanded", "false")
    expect(trigger).toHaveAttribute("data-slot", "popover-trigger")
    expect(trigger).toHaveClass("terminology-highlight")
    // No popover root, positioner, portal or focus guard until it is opened.
    expect(container.querySelectorAll("*")).toHaveLength(3) // div, button, span
    expect(
      document.querySelector("[data-base-ui-portal], [data-base-ui-focus-guard], [data-slot='popover-content']"),
    ).toBeNull()
  })

  it("opens on a press, says so, and closes on Escape", async () => {
    const onClick = vi.fn()
    renderTerm(onClick)
    const trigger = screen.getByText("Spirit")
    press(trigger)
    expect(onClick).toHaveBeenCalledTimes(1) // the caller's own handler still runs
    expect(await screen.findByRole("tooltip")).toBeInTheDocument()
    expect(screen.getByText("rendering of spirit")).toBeInTheDocument()
    expect(trigger).toHaveAttribute("aria-expanded", "true")
    // The trigger is the same element it was: nothing in the text was re-created.
    expect(screen.getByText("Spirit")).toBe(trigger)

    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })
    await waitFor(() => expect(trigger).toHaveAttribute("aria-expanded", "false"))
    await waitFor(() => expect(screen.queryByText("rendering of spirit")).not.toBeInTheDocument())
  })

  it("a second press on the trigger closes it rather than re-opening it", async () => {
    renderTerm()
    const trigger = screen.getByText("Spirit")
    press(trigger)
    await screen.findByRole("tooltip")
    press(trigger)
    await waitFor(() => expect(trigger).toHaveAttribute("aria-expanded", "false"))
    // … and the press after that opens it again.
    press(trigger)
    await waitFor(() => expect(trigger).toHaveAttribute("aria-expanded", "true"))
    expect(await screen.findByText("rendering of spirit")).toBeInTheDocument()
  })

  it("closes on a press elsewhere", async () => {
    renderTerm()
    const trigger = screen.getByText("Spirit")
    press(trigger)
    await screen.findByRole("tooltip")
    press(screen.getByText("elsewhere"))
    await waitFor(() => expect(trigger).toHaveAttribute("aria-expanded", "false"))
  })

  it.each(["Enter", " "])("opens from the keyboard with %j", async (key) => {
    renderTerm()
    const trigger = screen.getByText("Spirit")
    trigger.focus()
    fireEvent.keyDown(trigger, { key })
    expect(await screen.findByRole("tooltip")).toBeInTheDocument()
    expect(trigger).toHaveAttribute("aria-expanded", "true")
  })
})
