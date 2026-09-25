import { afterEach, describe, expect, it, vi } from "vitest"
import { openActivationInputCapture } from "./activation-input-capture"

// AQU-1333: during the ~300–500 ms between clicking a target cell and the
// TipTap editor taking focus, the row wrapper is the only thing focused. AQU-746
// buffers `keydown` there, but text that arrives WITHOUT a keydown — CDP
// `Input.insertText` (browser agents, Playwright `fill`), IME composition, OS
// dictation, paste — was dropped silently: it never reached the outbox, and the
// row was not even an editing host, so `beforeinput` never fired on it.
//
// These tests guard the capture side of the fix. The replay side (draining the
// buffer into the editor on focus) is covered by
// `src/components/TranslatedEditor.pendingInput.test.tsx`.

interface Harness {
  host: HTMLElement
  caretHost: HTMLElement
  reactChild: HTMLElement
  buffered: () => string
  close: () => void
}

const harnesses: Harness[] = []

function mount(): Harness {
  const host = document.createElement("div")
  host.tabIndex = 0
  // Stands in for React-rendered row content, which must never be mutated.
  const reactChild = document.createElement("div")
  reactChild.textContent = "source text"
  host.appendChild(reactChild)
  const caretHost = document.createElement("span")
  host.appendChild(caretHost)
  document.body.appendChild(host)

  let buffer = ""
  const capture = openActivationInputCapture({
    host,
    caretHost,
    onText: (text) => {
      buffer += text
    },
  })

  const harness: Harness = {
    host,
    caretHost,
    reactChild,
    buffered: () => buffer,
    close: capture.close,
  }
  harnesses.push(harness)
  return harness
}

/**
 * happy-dom has no `CompositionEvent`, so the global degrades to `Event` and
 * silently drops `data`. Build the event by hand so these tests exercise the
 * committed-text path rather than an always-empty one.
 */
function composition(host: HTMLElement, type: "compositionstart" | "compositionend", data = ""): void {
  const event = new Event(type, { bubbles: true })
  Object.defineProperty(event, "data", { value: data })
  host.dispatchEvent(event)
}

function beforeInput(
  host: HTMLElement,
  init: { inputType: string; data?: string | null; cancelable?: boolean },
): InputEvent {
  const event = new InputEvent("beforeinput", {
    inputType: init.inputType,
    data: init.data ?? null,
    bubbles: true,
    cancelable: init.cancelable ?? true,
  })
  host.dispatchEvent(event)
  return event
}

afterEach(() => {
  while (harnesses.length) harnesses.pop()?.close()
  document.body.innerHTML = ""
})

describe("openActivationInputCapture (AQU-1333)", () => {
  it("makes the row an editing host so beforeinput can reach it at all", () => {
    const { host } = mount()
    // Without this the row is a plain div: `Input.insertText` and composition
    // have no editing host to target and produce no events whatsoever.
    expect(host.getAttribute("contenteditable")).not.toBeNull()
  })

  it("buffers text inserted without a keydown (CDP Input.insertText / Playwright fill)", () => {
    const h = mount()
    beforeInput(h.host, { inputType: "insertText", data: "In the beginning" })
    expect(h.buffered()).toBe("In the beginning")
  })

  it("preserves arrival order across several insertions", () => {
    const h = mount()
    beforeInput(h.host, { inputType: "insertText", data: "abc" })
    beforeInput(h.host, { inputType: "insertText", data: "def" })
    expect(h.buffered()).toBe("abcdef")
  })

  it("cancels the insertion so nothing lands in React-owned row DOM", () => {
    const h = mount()
    const event = beforeInput(h.host, { inputType: "insertText", data: "x" })
    expect(event.defaultPrevented).toBe(true)
    expect(h.reactChild.textContent).toBe("source text")
  })

  it("cancels non-text edits too, without buffering them", () => {
    const h = mount()
    const event = beforeInput(h.host, { inputType: "deleteContentBackward" })
    expect(event.defaultPrevented).toBe(true)
    expect(h.buffered()).toBe("")
  })

  it("buffers a paste and stops the browser inserting it", () => {
    const h = mount()
    const event = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent
    Object.defineProperty(event, "clipboardData", {
      value: { getData: (type: string) => (type === "text/plain" ? "pasted" : "") },
    })
    h.host.dispatchEvent(event)
    expect(h.buffered()).toBe("pasted")
    expect(event.defaultPrevented).toBe(true)
  })

  it("buffers an IME composition once, from its committed text", () => {
    const h = mount()
    composition(h.host, "compositionstart")
    // Intermediate composition states are not cancelable and each carries a
    // prefix of the final string — buffering them would yield "n" + "ni" + "nih".
    beforeInput(h.host, { inputType: "insertCompositionText", data: "n", cancelable: false })
    beforeInput(h.host, { inputType: "insertCompositionText", data: "ni", cancelable: false })
    composition(h.host, "compositionend", "你好")
    expect(h.buffered()).toBe("你好")
  })

  it("wipes text the browser forced into the caret host during composition", () => {
    const h = mount()
    composition(h.host, "compositionstart")
    // An uncancelable composition mutates the DOM; it lands in the throwaway
    // caret host rather than in row content, and is cleared once committed.
    h.caretHost.textContent = "你好"
    composition(h.host, "compositionend", "你好")
    expect(h.caretHost.textContent).toBe("")
    expect(h.reactChild.textContent).toBe("source text")
  })

  it("ignores stray insertions while a composition is still in flight", () => {
    const h = mount()
    composition(h.host, "compositionstart")
    beforeInput(h.host, { inputType: "insertText", data: "ni", cancelable: false })
    composition(h.host, "compositionend", "你")
    expect(h.buffered()).toBe("你")
  })

  it("restores the row and stops capturing on close", () => {
    const onText = vi.fn()
    const host = document.createElement("div")
    const caretHost = document.createElement("span")
    host.appendChild(caretHost)
    host.style.caretColor = "red"
    document.body.appendChild(host)

    const capture = openActivationInputCapture({ host, caretHost, onText })
    capture.close()

    // The row goes back to being a plain, non-editable focus stop — an editable
    // row left behind would be announced as a text field and would swallow the
    // editor's own input.
    expect(host.getAttribute("contenteditable")).toBeNull()
    expect(host.style.caretColor).toBe("red")

    beforeInput(host, { inputType: "insertText", data: "late" })
    expect(onText).not.toHaveBeenCalled()
  })

  it("is safe to close twice", () => {
    const h = mount()
    h.close()
    expect(() => h.close()).not.toThrow()
  })
})
