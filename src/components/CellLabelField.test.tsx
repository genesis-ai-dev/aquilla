/**
 * AQU-2408 — the field a cell's label is typed in, in the cell's corner slot:
 * it takes the caret as it appears, and what reaches the save and close
 * callbacks. The gate that decides who may open it is tested in
 * src/lib/cell-label-gate.test.ts; the field trusts that it was mounted.
 */
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, cleanup, fireEvent } from "@testing-library/react"
import { CellLabelField } from "./CellLabelField"

afterEach(cleanup)

function renderField(label: string | null) {
  const onSave = vi.fn()
  const onClose = vi.fn()
  render(<CellLabelField label={label} onSave={onSave} onClose={onClose} />)
  const input = screen.getByTestId<HTMLInputElement>("cell-label-input")
  return { input, onSave, onClose }
}

describe("CellLabelField (AQU-2408)", () => {
  it("takes the caret as it appears, with an existing label selected whole", () => {
    const { input } = renderField("Pericope")
    expect(input).toHaveValue("Pericope")
    expect(document.activeElement).toBe(input)
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe("Pericope".length)
    expect(screen.getByRole("textbox", { name: "Cell label" })).toBe(input)
  })

  it("saves the trimmed label on Enter and closes", () => {
    const { input, onSave, onClose } = renderField(null)
    fireEvent.change(input, { target: { value: "  Needs consultant  " } })
    // The field really holds focus, so Enter's own blur is what saves.
    fireEvent.keyDown(input, { key: "Enter" })
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave).toHaveBeenCalledWith("Needs consultant")
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("saves on blur, and a blank value clears", () => {
    const { input, onSave, onClose } = renderField("Pericope")
    fireEvent.change(input, { target: { value: "   " } })
    fireEvent.blur(input)
    expect(onSave).toHaveBeenCalledWith(null)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("emits nothing when the value is unchanged, and still closes", () => {
    const { input, onSave, onClose } = renderField("Pericope")
    fireEvent.change(input, { target: { value: "Pericope " } })
    fireEvent.blur(input)
    expect(onSave).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("Escape closes without saving the draft", () => {
    const { input, onSave, onClose } = renderField("Pericope")
    fireEvent.change(input, { target: { value: "Half-typed" } })
    fireEvent.keyDown(input, { key: "Escape" })
    expect(onSave).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("keeps its keys to itself: nothing typed here reaches the cell around it", () => {
    const onKeyDown = vi.fn()
    render(
      <div onKeyDown={onKeyDown}>
        <CellLabelField label={null} onSave={vi.fn()} onClose={vi.fn()} />
      </div>,
    )
    fireEvent.keyDown(screen.getByTestId("cell-label-input"), { key: "a" })
    expect(onKeyDown).not.toHaveBeenCalled()
  })
})
