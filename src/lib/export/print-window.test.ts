/**
 * AQU-2680: the hidden frame the PDF export prints from.
 *  - Re-check finding 4: Safari can print the app's own page instead of the
 *    frame unless the frame's window has focus, so it is focused first.
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
})
