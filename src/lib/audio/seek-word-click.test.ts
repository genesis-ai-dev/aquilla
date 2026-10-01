import { describe, expect, it } from "vitest"
import { isWordSeekClick, plainOffsetFromPoint, timingFromClick } from "./seek-word-click"
import type { WordTiming } from "@/lib/codex-editor/types"

describe("isWordSeekClick", () => {
  it("is Option/Alt + primary button, with no other modifiers", () => {
    expect(isWordSeekClick({ altKey: true, metaKey: false, ctrlKey: false, shiftKey: false, button: 0 })).toBe(true)
    expect(isWordSeekClick({ altKey: false, metaKey: false, ctrlKey: false, shiftKey: false, button: 0 })).toBe(false)
    expect(isWordSeekClick({ altKey: true, metaKey: true, ctrlKey: false, shiftKey: false, button: 0 })).toBe(false)
    expect(isWordSeekClick({ altKey: true, metaKey: false, ctrlKey: false, shiftKey: false, button: 2 })).toBe(false)
  })
})

describe("plainOffsetFromPoint", () => {
  it("counts text before the caret node", () => {
    const root = document.createElement("div")
    const hello = document.createTextNode("hello ")
    const world = document.createTextNode("world")
    root.append(hello, world)
    document.body.appendChild(root)
    const doc = root.ownerDocument as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null
    }
    const range = doc.createRange()
    range.setStart(world, 2)
    range.collapse(true)
    doc.caretRangeFromPoint = () => range
    expect(plainOffsetFromPoint(root, 0, 0)).toBe(8)
    root.remove()
  })
})

describe("timingFromClick", () => {
  const timings: WordTiming[] = [
    { word: "hello", t0: 0, t1: 0.4, start: 0, end: 5 },
    { word: "world", t0: 0.4, t1: 0.9, start: 6, end: 11 },
  ]
  it("maps an Option/Alt+click onto the word under the caret", () => {
    const root = document.createElement("div")
    const text = document.createTextNode("hello world")
    root.append(text)
    document.body.appendChild(root)
    const doc = root.ownerDocument as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null
    }
    const range = doc.createRange()
    range.setStart(text, 8)
    range.collapse(true)
    doc.caretRangeFromPoint = () => range
    const event = {
      altKey: true, metaKey: false, ctrlKey: false, shiftKey: false, button: 0,
      clientX: 0, clientY: 0,
    } as MouseEvent
    expect(timingFromClick(timings, root, event)?.word).toBe("world")
    root.remove()
  })
})
