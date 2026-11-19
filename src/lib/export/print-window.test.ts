/**
 * AQU-2680: the hidden frame the PDF export prints from.
 *  - Re-check finding 4: Safari can print the app's own page instead of the
 *    frame unless the frame's window has focus, so it is focused first.
 *  - Re-check finding 6: the frame is sandboxed (same origin, so the app can
 *    reach it to print; modals, so it may print; no scripts).
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { printHtml, type PrintableWindow } from "./print-window"

const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

afterEach(() => document.querySelectorAll("iframe").forEach((f) => f.remove()))

describe("printing from the hidden frame", () => {
  it("focuses the frame's window before printing", async () => {
    const calls: string[] = []
    const win = { focus: vi.fn(() => calls.push("focus")), print: vi.fn(() => calls.push("print")) } as PrintableWindow
    expect(await printHtml("<p>x</p>", { userAgent: CHROME, open: async () => ({ win, close: vi.fn() }) })).toBe(true)
    expect(calls).toEqual(["focus", "print"])
  })

  it("prints from a sandboxed frame that may print but runs no scripts", async () => {
    const printing = printHtml("<p>x</p>", { userAgent: CHROME, loadTimeoutMs: 1000 })
    const frame = document.querySelector("iframe")!
    expect(frame.getAttribute("sandbox")).toBe("allow-same-origin allow-modals")
    // the test browser cannot load a frame's page; stand in for a loaded one
    const print = vi.fn()
    const focus = vi.fn()
    Object.defineProperty(frame, "contentWindow", { value: { print, focus } })
    frame.dispatchEvent(new Event("load"))
    expect(await printing).toBe(true)
    expect(focus).toHaveBeenCalledTimes(1)
    expect(print).toHaveBeenCalledTimes(1)
  })
})
