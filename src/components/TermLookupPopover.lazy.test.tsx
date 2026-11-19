// AQU-2654: the source column wraps every highlighted term of every row in a
// TermLookupPopover. The lookup over the glossary belongs to opening the
// popover, not to drawing the row.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
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
