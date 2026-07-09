import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { GlossaryRow } from "./GlossaryRow"
import type { Concept } from "@/lib/terminology/types"

function c(partial: Partial<Concept>): Concept {
  return {
    id: "c1",
    sourceTerm: "grace",
    renderings: [{ rendering: "favor", status: "preferred" }],
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  }
}

function noopHandlers() {
  return {
    onEditSource: vi.fn(),
    onEditPrimary: vi.fn(),
    onEditRenderings: vi.fn(),
    onArchive: vi.fn(),
    onRestore: vi.fn(),
    onAccept: vi.fn(),
    onDismiss: vi.fn(),
  }
}

describe("GlossaryRow", () => {
  it("shows source headword and primary rendering", () => {
    render(<GlossaryRow concept={c({})} canManage {...noopHandlers()} />)
    expect(screen.getByText("grace")).toBeInTheDocument()
    expect(screen.getByText("favor")).toBeInTheDocument()
  })

  it("commits an edited primary rendering on blur", () => {
    const h = noopHandlers()
    render(<GlossaryRow concept={c({})} canManage {...h} />)
    fireEvent.click(screen.getByText("favor"))
    const input = screen.getByDisplayValue("favor")
    fireEvent.change(input, { target: { value: "merced" } })
    fireEvent.blur(input)
    expect(h.onEditPrimary).toHaveBeenCalledWith("c1", "merced")
  })

  it("offers Accept/Dismiss for a suggested (draft) concept", () => {
    const h = noopHandlers()
    render(<GlossaryRow concept={c({ status: "draft" })} canManage {...h} />)
    fireEvent.click(screen.getByRole("button", { name: /accept/i }))
    expect(h.onAccept).toHaveBeenCalledWith("c1")
  })

  it("offers Restore for an archived (deprecated) concept", () => {
    const h = noopHandlers()
    render(<GlossaryRow concept={c({ status: "deprecated" })} canManage {...h} />)
    fireEvent.click(screen.getByRole("button", { name: /restore/i }))
    expect(h.onRestore).toHaveBeenCalledWith("c1")
  })

  it("buffers an expander rendering edit locally and commits only on blur", () => {
    const h = noopHandlers()
    render(<GlossaryRow concept={c({})} canManage {...h} />)
    fireEvent.click(screen.getByLabelText("Expand renderings"))
    const input = screen.getByDisplayValue("favor")
    fireEvent.change(input, { target: { value: "favora" } })
    expect(h.onEditRenderings).not.toHaveBeenCalled()
    fireEvent.blur(input)
    expect(h.onEditRenderings).toHaveBeenCalledTimes(1)
    expect(h.onEditRenderings).toHaveBeenCalledWith("c1", [{ rendering: "favora", status: "preferred" }])
  })

  it("hides edit affordances when canManage is false", () => {
    render(<GlossaryRow concept={c({})} canManage={false} {...noopHandlers()} />)
    fireEvent.click(screen.getByText("favor"))
    expect(screen.queryByDisplayValue("favor")).toBeNull()
  })
})
