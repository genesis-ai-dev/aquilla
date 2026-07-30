import { afterEach, describe, expect, it, vi } from "vitest"
import { idmlPointerSelectionFromPoint } from "@/lib/richtext/idml-caret"

const originalCaretRangeFromPoint = (
  document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }
).caretRangeFromPoint

afterEach(() => {
  const doc = document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }
  doc.caretRangeFromPoint = originalCaretRangeFromPoint
  document.body.replaceChildren()
})

describe("IDML read-surface pointer selection", () => {
  it("captures the clicked slot and exact text offset before activation remounts it", () => {
    document.body.innerHTML =
      `<span data-idml-slot="3" data-idml-protected="slot">one  two</span>`
    const slot = document.querySelector<HTMLElement>("[data-idml-slot]")!
    const text = slot.firstChild!
    const caret = document.createRange()
    caret.setStart(text, 5)
    caret.collapse(true)
    const caretRangeFromPoint = vi.fn(() => caret)
    ;(
      document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }
    ).caretRangeFromPoint = caretRangeFromPoint

    expect(idmlPointerSelectionFromPoint({
      clientX: 120,
      clientY: 40,
      target: slot,
    })).toEqual({ kind: "slot", slot: 3, offset: 5 })
    expect(caretRangeFromPoint).toHaveBeenCalledWith(120, 40)
  })

  it("captures a flattened plain offset when the read view has no IDML attributes", () => {
    document.body.innerHTML = `<div id="root"><span>one  </span><span>two</span></div>`
    const root = document.querySelector<HTMLElement>("#root")!
    const secondText = root.lastElementChild!.firstChild!
    const caret = document.createRange()
    caret.setStart(secondText, 0)
    caret.collapse(true)
    ;(
      document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }
    ).caretRangeFromPoint = () => caret

    expect(idmlPointerSelectionFromPoint({
      clientX: 1,
      clientY: 1,
      target: root.lastElementChild,
    }, root)).toEqual({ kind: "plain", offset: 5 })
  })

  it("does not create a pointer selection for a protected slot", () => {
    document.body.innerHTML =
      `<span data-idml-slot="2" data-idml-protected="slot" contenteditable="false">LOCK</span>`
    const slot = document.querySelector<HTMLElement>("[data-idml-slot]")!
    expect(idmlPointerSelectionFromPoint({
      clientX: 1,
      clientY: 1,
      target: slot,
    })).toBeNull()
  })
})
