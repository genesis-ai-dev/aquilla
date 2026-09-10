import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { TermLookupPopover } from "./TermLookupPopover"
import type { Concept } from "@/lib/terminology/types"

function makeConcept(overrides: Partial<Concept> = {}): Concept {
  return {
    id: "c1",
    sourceTerm: "spirit",
    renderings: [
      { rendering: "Holy Spirit", status: "preferred" },
      { rendering: "Spirit", status: "admitted" },
      { rendering: "spook", status: "forbidden" },
    ],
    notes: "Theological term",
    status: "active",
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  }
}

const CONCEPTS: Concept[] = [makeConcept()]

describe("TermLookupPopover", () => {
  // ── No match — no popover wrapper ─────────────────────────────────────────

  it("renders children directly when no concepts match", () => {
    render(
      <TermLookupPopover
        sourceTerm="unrelated"
        concepts={CONCEPTS}
        onViewConcept={vi.fn()}
      >
        <span>hover me</span>
      </TermLookupPopover>,
    )
    expect(screen.getByText("hover me")).toBeInTheDocument()
    // No popover trigger
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument()
  })

  // ── Draft concepts excluded ────────────────────────────────────────────────

  it("does not show popover for draft concepts", () => {
    const draftConcept = makeConcept({ status: "draft" })
    render(
      <TermLookupPopover
        sourceTerm="spirit"
        concepts={[draftConcept]}
        onViewConcept={vi.fn()}
      >
        <span>hover me</span>
      </TermLookupPopover>,
    )
    // Draft concepts produce no popover (children rendered directly)
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument()
  })

  // ── Preferred/admitted renderings shown ───────────────────────────────────

  it("renders preferred and admitted renderings", () => {
    render(
      <TermLookupPopover
        sourceTerm="spirit"
        concepts={CONCEPTS}
        onViewConcept={vi.fn()}
      >
        <span>spirit</span>
      </TermLookupPopover>,
    )
    // Open popover by clicking trigger
    const trigger = screen.getByText("spirit")
    fireEvent.click(trigger)

    expect(screen.getByText("Holy Spirit")).toBeInTheDocument()
    expect(screen.getByText("Spirit")).toBeInTheDocument()
    expect(screen.getByText("spook")).toBeInTheDocument()
  })

  it.each(["spirit;", "spirit,"])(
    "opens when the highlighted token includes punctuation: %s",
    (sourceTerm) => {
      render(
        <TermLookupPopover
          sourceTerm={sourceTerm}
          concepts={CONCEPTS}
          onViewConcept={vi.fn()}
        >
          <span>{sourceTerm}</span>
        </TermLookupPopover>,
      )

      fireEvent.click(screen.getByText(sourceTerm))
      expect(screen.getByText("Holy Spirit")).toBeInTheDocument()
    },
  )

  // ── Status labels ─────────────────────────────────────────────────────────

  it("shows correct status labels (required / alternate / forbidden)", () => {
    // Consolidated onto the shared terminology.status.* vocabulary (AQU-832,
    // WS-16): TermLookupPopover used to say "avoid" for forbidden while the
    // other five status-label call sites said "forbidden" — reconciled to the
    // 5-of-6 majority (also what the underlying RenderingStatus id itself is).
    render(
      <TermLookupPopover
        sourceTerm="spirit"
        concepts={CONCEPTS}
        onViewConcept={vi.fn()}
      >
        <span>spirit</span>
      </TermLookupPopover>,
    )
    fireEvent.click(screen.getByText("spirit"))

    expect(screen.getByText("required")).toBeInTheDocument()
    expect(screen.getByText("alternate")).toBeInTheDocument()
    expect(screen.getByText("forbidden")).toBeInTheDocument()
  })

  // ── Terminology entry navigation ─────────────────────────────────────────

  it("shows one terminology-entry action instead of rendering Apply buttons", () => {
    render(
      <TermLookupPopover
        sourceTerm="spirit"
        concepts={CONCEPTS}
        onViewConcept={vi.fn()}
      >
        <span>spirit</span>
      </TermLookupPopover>,
    )
    fireEvent.click(screen.getByText("spirit"))

    expect(screen.queryByRole("button", { name: /Apply rendering/i })).not.toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: /Go to Terminology page.*spirit/i }),
    ).toBeInTheDocument()
  })

  it("opens the matching concept when the terminology action is clicked", () => {
    const onViewConcept = vi.fn()
    render(
      <TermLookupPopover
        sourceTerm="spirit"
        concepts={CONCEPTS}
        onViewConcept={onViewConcept}
      >
        <span>spirit</span>
      </TermLookupPopover>,
    )
    fireEvent.click(screen.getByText("spirit"))

    fireEvent.click(
      screen.getByRole("button", { name: /Go to Terminology page.*spirit/i }),
    )
    expect(onViewConcept).toHaveBeenCalledWith("c1")
  })

  // ── Notes displayed ────────────────────────────────────────────────────────

  it("shows concept notes when present", () => {
    render(
      <TermLookupPopover
        sourceTerm="spirit"
        concepts={CONCEPTS}
        onViewConcept={vi.fn()}
      >
        <span>spirit</span>
      </TermLookupPopover>,
    )
    fireEvent.click(screen.getByText("spirit"))
    expect(screen.getByText("Theological term")).toBeInTheDocument()
  })

  // ── Multiple matching concepts ────────────────────────────────────────────

  it("shows all matching active concepts for polysemous tokens", () => {
    const concepts: Concept[] = [
      makeConcept({ id: "c1", sourceTerm: "spirit", notes: "Note A" }),
      makeConcept({
        id: "c2",
        sourceTerm: "spirit of the law",
        renderings: [{ rendering: "tenor", status: "preferred" }],
        notes: "Note B",
      }),
    ]
    render(
      <TermLookupPopover
        sourceTerm="spirit"
        concepts={concepts}
        onViewConcept={vi.fn()}
      >
        <span>spirit</span>
      </TermLookupPopover>,
    )
    fireEvent.click(screen.getByText("spirit"))

    expect(screen.getByText("Note A")).toBeInTheDocument()
    expect(screen.getByText("Note B")).toBeInTheDocument()
    expect(
      screen.getAllByRole("button", { name: /Go to Terminology page/i }),
    ).toHaveLength(2)
  })
})
