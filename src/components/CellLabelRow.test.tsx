/**
 * AQU-2408 — the Label row in a cell's expansion panel: its three states and
 * what reaches the save callback. The gate that picks the state is tested in
 * src/lib/cell-label-gate.test.ts; the row trusts `editable`.
 */
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, cleanup, fireEvent } from "@testing-library/react"
import { CellLabelRow } from "./CellLabelRow"

afterEach(cleanup)

describe("CellLabelRow (AQU-2408)", () => {
  it("renders nothing when there is no label and the viewer cannot set one", () => {
    render(<CellLabelRow label={null} editable={false} />)
    expect(screen.queryByTestId("cell-label-row")).toBeNull()
  })

  it("shows the label as plain text below the tier, with no field", () => {
    render(<CellLabelRow label="Pericope" editable={false} />)
    expect(screen.getByTestId("cell-label-text")).toHaveTextContent("Pericope")
    expect(screen.queryByTestId("cell-label-input")).toBeNull()
  })

  it("offers the field at or above the tier, pre-filled with the stored label", () => {
    render(<CellLabelRow label="Pericope" editable onSave={vi.fn()} />)
    expect(screen.getByTestId("cell-label-input")).toHaveValue("Pericope")
    expect(screen.getByRole("textbox", { name: "Cell label" })).toBeInTheDocument()
  })

  it("saves the trimmed label on Enter", () => {
    const onSave = vi.fn()
    render(<CellLabelRow label={null} editable onSave={onSave} />)
    const input = screen.getByTestId("cell-label-input")
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: "  Needs consultant  " } })
    fireEvent.keyDown(input, { key: "Enter" })
    fireEvent.blur(input)
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave).toHaveBeenCalledWith("Needs consultant")
  })

  it("saves on blur, and a blank value clears", () => {
    const onSave = vi.fn()
    render(<CellLabelRow label="Pericope" editable onSave={onSave} />)
    const input = screen.getByTestId("cell-label-input")
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: "   " } })
    fireEvent.blur(input)
    expect(onSave).toHaveBeenCalledWith(null)
  })

  it("emits nothing when the value is unchanged", () => {
    const onSave = vi.fn()
    render(<CellLabelRow label="Pericope" editable onSave={onSave} />)
    const input = screen.getByTestId("cell-label-input")
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: "Pericope " } })
    fireEvent.blur(input)
    expect(onSave).not.toHaveBeenCalled()
  })

  it("Escape abandons the draft and the blur that follows saves nothing", () => {
    const onSave = vi.fn()
    render(<CellLabelRow label="Pericope" editable onSave={onSave} />)
    const input = screen.getByTestId("cell-label-input")
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: "Half-typed" } })
    fireEvent.keyDown(input, { key: "Escape" })
    fireEvent.blur(input)
    expect(onSave).not.toHaveBeenCalled()
    expect(input).toHaveValue("Pericope")
  })

  it("follows a label changed elsewhere while nobody is typing", () => {
    const { rerender } = render(<CellLabelRow label="Old" editable onSave={vi.fn()} />)
    rerender(<CellLabelRow label="New" editable onSave={vi.fn()} />)
    expect(screen.getByTestId("cell-label-input")).toHaveValue("New")
  })
})
