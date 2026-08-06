/**
 * WorkingSetPanel tests — the review-editor contract:
 * - strikethrough shows only a value actually being replaced (never the new
 *   text twice — the bug this originally pinned against);
 * - drafts are editable in place and ACCEPT COMMITS WHAT'S IN THE BOX;
 * - Esc reverts to the agent's draft;
 * - lint re-runs against the row's current text as the user edits;
 * - decided rows render their outcome instead of accept/reject controls.
 */

import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import type { WorkingSetRow } from "@/lib/agent/working-set"
import { WorkingSetPanel } from "./WorkingSetPanel"

function row(overrides: Partial<WorkingSetRow>): WorkingSetRow {
  return {
    cellId: "c1",
    fileId: "f1",
    ref: "MRK 1:1",
    source: "The beginning of the good news",
    target: "",
    stagedEvent: {
      kind: "target.cell.commit",
      cellId: "c1",
      fileId: "f1",
      payload: { value: "nuevo" },
      display: { canonicalRef: "MRK 1:1" },
    },
    proposalId: "p1",
    proposed: "nuevo",
    ...overrides,
  }
}

const strikethroughs = (container: HTMLElement) => container.querySelectorAll(".line-through")

describe("pending-diff rendering", () => {
  it("can render target-only when source lives in the adjacent workbench pane", () => {
    render(<WorkingSetPanel rows={[row({})]} showSource={false} title="Target" />)
    expect(screen.getByLabelText("Target review pane")).toHaveTextContent("nuevo")
    expect(screen.getByLabelText("Target review pane")).not.toHaveTextContent("The beginning")
  })

  it("shows only the proposed text for an empty cell — no crossed-out copy", () => {
    const { container } = render(<WorkingSetPanel rows={[row({ target: "" })]} />)
    expect(screen.getAllByText("nuevo")).toHaveLength(1)
    expect(strikethroughs(container)).toHaveLength(0)
  })

  it("suppresses the strikethrough when the current value equals the proposal", () => {
    const { container } = render(<WorkingSetPanel rows={[row({ target: "nuevo" })]} />)
    expect(screen.getAllByText("nuevo")).toHaveLength(1)
    expect(strikethroughs(container)).toHaveLength(0)
  })

  it("shows old-crossed-out above new when the cell has a different current value", () => {
    const { container } = render(<WorkingSetPanel rows={[row({ target: "viejo" })]} />)
    expect(strikethroughs(container)).toHaveLength(1)
    expect(screen.getByText("viejo")).toHaveClass("line-through")
    expect(screen.getByText("nuevo")).not.toHaveClass("line-through")
  })
})

describe("edit in place", () => {
  it("clicking the draft opens an editor; accept commits the EDITED text", () => {
    const onAccept = vi.fn()
    render(<WorkingSetPanel rows={[row({})]} onAccept={onAccept} />)
    fireEvent.click(screen.getByRole("button", { name: "nuevo" }))
    const box = screen.getByRole("textbox", { name: /Edit draft for MRK 1:1/ })
    fireEvent.change(box, { target: { value: "nuevo corregido" } })
    fireEvent.keyDown(box, { key: "Enter" })
    expect(onAccept).toHaveBeenCalledWith(expect.objectContaining({ cellId: "c1" }), "nuevo corregido")
  })

  it("Esc reverts the edit back to the agent's draft", () => {
    const onAccept = vi.fn()
    render(<WorkingSetPanel rows={[row({})]} onAccept={onAccept} />)
    fireEvent.click(screen.getByRole("button", { name: "nuevo" }))
    const box = screen.getByRole("textbox", { name: /Edit draft/ })
    fireEvent.change(box, { target: { value: "typo" } })
    fireEvent.keyDown(box, { key: "Escape" })
    // Editor is gone; the draft text is back to the proposal.
    expect(screen.queryByRole("textbox", { name: /Edit draft/ })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Accept draft for MRK 1:1" }))
    expect(onAccept).toHaveBeenCalledWith(expect.anything(), "nuevo")
  })

  it("accept-all resolves each row's edited text via valueFor", () => {
    const onAcceptAll = vi.fn()
    const rows = [row({}), row({ cellId: "c2", ref: "MRK 1:2", proposed: "otro", stagedEvent: { ...row({}).stagedEvent!, cellId: "c2" } })]
    render(<WorkingSetPanel rows={rows} onAcceptAll={onAcceptAll} />)
    // Edit the first row, leave the second untouched.
    fireEvent.click(screen.getByRole("button", { name: "nuevo" }))
    const box = screen.getByRole("textbox", { name: /Edit draft/ })
    fireEvent.change(box, { target: { value: "editado" } })
    fireEvent.keyDown(box, { key: "Escape" }) // exit edit mode; the edit text is kept? No — Esc reverts.
    fireEvent.click(screen.getByRole("button", { name: /Accept remaining \(2\)/ }))
    const valueFor = onAcceptAll.mock.calls[0][0] as (r: WorkingSetRow) => string
    expect(valueFor(rows[0])).toBe("nuevo") // reverted by Esc
    expect(valueFor(rows[1])).toBe("otro")
  })

  it("lint re-runs against the current text as the user edits", () => {
    const lintRow = vi.fn((_row: WorkingSetRow, text: string) =>
      text.endsWith("۔") ? [] : ["End punctuation: differs from source"],
    )
    render(<WorkingSetPanel rows={[row({})]} lintRow={lintRow} />)
    expect(screen.getByText(/End punctuation/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "nuevo" }))
    const box = screen.getByRole("textbox", { name: /Edit draft/ })
    fireEvent.change(box, { target: { value: "nuevo۔" } })
    expect(screen.queryByText(/End punctuation/)).toBeNull()
  })
})

describe("row lifecycle", () => {
  it("decided rows show their outcome instead of accept/reject controls", () => {
    render(
      <WorkingSetPanel
        rows={[
          row({ outcome: "edited", proposed: undefined, stagedEvent: undefined, target: "hecho" }),
          row({ cellId: "c2", ref: "MRK 1:2", outcome: "rejected", proposed: undefined, stagedEvent: undefined, target: "" }),
        ]}
      />,
    )
    expect(screen.getByText("✓ edited & accepted")).toBeInTheDocument()
    expect(screen.getByText("hecho")).toBeInTheDocument()
    expect(screen.getByText("rejected")).toBeInTheDocument()
    expect(screen.getByText(/draft discarded/)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Accept draft/ })).toBeNull()
  })

  it("header shows the review queue and the Accept remaining sweep", () => {
    render(
      <WorkingSetPanel
        rows={[row({}), row({ cellId: "c2", outcome: "accepted", proposed: undefined, stagedEvent: undefined, target: "hecho" })]}
        onAcceptAll={() => {}}
      />,
    )
    expect(screen.getByText("2 cells · 1 to review")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Accept remaining \(1\)/ })).toBeInTheDocument()
  })
})
