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
      <TermLookupPopover sourceTerm="unrelated" concepts={CONCEPTS} onApply={vi.fn()}>
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
      <TermLookupPopover sourceTerm="spirit" concepts={[draftConcept]} onApply={vi.fn()}>
        <span>hover me</span>
      </TermLookupPopover>,
    )
    // Draft concepts produce no popover (children rendered directly)
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument()
  })

  // ── Preferred/admitted renderings shown ───────────────────────────────────

  it("renders preferred and admitted renderings", () => {
    render(
      <TermLookupPopover sourceTerm="spirit" concepts={CONCEPTS} onApply={vi.fn()}>
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

  // ── Status labels ─────────────────────────────────────────────────────────

  it("shows correct status labels (required / alternate / avoid)", () => {
    render(
      <TermLookupPopover sourceTerm="spirit" concepts={CONCEPTS} onApply={vi.fn()}>
        <span>spirit</span>
      </TermLookupPopover>,
    )
    fireEvent.click(screen.getByText("spirit"))

    expect(screen.getByText("required")).toBeInTheDocument()
    expect(screen.getByText("alternate")).toBeInTheDocument()
    expect(screen.getByText("avoid")).toBeInTheDocument()
  })

  // ── Apply buttons: present for preferred/admitted, absent for forbidden ────

  it("shows Apply buttons for preferred and admitted, not for forbidden", () => {
    const onApply = vi.fn()
    render(
      <TermLookupPopover sourceTerm="spirit" concepts={CONCEPTS} onApply={onApply}>
        <span>spirit</span>
      </TermLookupPopover>,
    )
    fireEvent.click(screen.getByText("spirit"))

    // Two Apply buttons (preferred + admitted)
    const applyButtons = screen.getAllByRole("button", { name: /Apply rendering/i })
    expect(applyButtons).toHaveLength(2)

    // No Apply for the forbidden rendering
    expect(
      screen.queryByRole("button", { name: /Apply rendering: spook/i }),
    ).not.toBeInTheDocument()
  })

  // ── onApply callback ──────────────────────────────────────────────────────

  it("calls onApply with the correct rendering when Apply is clicked", () => {
    const onApply = vi.fn()
    render(
      <TermLookupPopover sourceTerm="spirit" concepts={CONCEPTS} onApply={onApply}>
        <span>spirit</span>
      </TermLookupPopover>,
    )
    fireEvent.click(screen.getByText("spirit"))

    fireEvent.click(
      screen.getByRole("button", { name: /Apply rendering: Holy Spirit/i }),
    )
    expect(onApply).toHaveBeenCalledWith("Holy Spirit")
  })

  // ── Read-only mode: no onApply ────────────────────────────────────────────

  it("hides all Apply buttons when onApply is not provided (read-only mode)", () => {
    render(
      <TermLookupPopover sourceTerm="spirit" concepts={CONCEPTS}>
        <span>spirit</span>
      </TermLookupPopover>,
    )
    fireEvent.click(screen.getByText("spirit"))

    expect(screen.queryByRole("button", { name: /Apply rendering/i })).not.toBeInTheDocument()
  })

  // ── Notes displayed ────────────────────────────────────────────────────────

  it("shows concept notes when present", () => {
    render(
      <TermLookupPopover sourceTerm="spirit" concepts={CONCEPTS} onApply={vi.fn()}>
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
      <TermLookupPopover sourceTerm="spirit" concepts={concepts} onApply={vi.fn()}>
        <span>spirit</span>
      </TermLookupPopover>,
    )
    fireEvent.click(screen.getByText("spirit"))

    expect(screen.getByText("Note A")).toBeInTheDocument()
    expect(screen.getByText("Note B")).toBeInTheDocument()
  })
})
