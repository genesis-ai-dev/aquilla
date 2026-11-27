/**
 * AQU-2680 (question 54, Sam's decision Nov 19): the PDF comes from the
 * browser's print window ("Save as PDF"); there is no converter on a server.
 * Where printing is blocked or missing (another app's built-in browser, no
 * `print`, a page that never loads), the person gets the new Word document
 * with one sentence on saving it as PDF from Word. A cancel in the print
 * window is the person's own and saves nothing.
 */

import { describe, expect, it, vi } from "vitest"
import type { CellData } from "@/hooks/useCells"
import { t } from "@/lib/i18n/standalone"
import { extractDocxStrings } from "@/lib/parsers/docx"
import { exportPdfOrWord } from "./pdf-or-word"
import type { PrintableWindow } from "./print-window"

const SENTENCE = "Printing isn't available here, so this is the Word file. Save it as PDF from Word or Pages, or open this page in Safari or Chrome."
const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
const INSTAGRAM = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 340.0.0.0"
const ANDROID_WEBVIEW = "Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.0.0 Mobile Safari/537.36"

const CELLS = [
  { id: "1", fileId: "f", original: "Chapter One", translated: "Capítulo uno", type: "heading", context: "Heading 1", group: "", paragraphStart: true },
  { id: "2", fileId: "f", original: "First line.", translated: "Primera línea.", type: "text", context: "Paragraph", group: "", paragraphStart: true },
] as CellData[]

/** A print window that opens, and what was printed in it. */
function printer(win: Partial<PrintableWindow> | null = {}) {
  const pages: string[] = []
  const close = vi.fn()
  const print = vi.fn()
  const open = vi.fn(async (html: string) => {
    pages.push(html)
    return { win: win === null ? null : ({ print, ...win } as PrintableWindow), close }
  })
  return { pages, close, print, open }
}

async function wordText(blob: Blob): Promise<string[]> {
  return (await extractDocxStrings(await blob.arrayBuffer(), { cellUnit: "paragraph" })).map((s) => s.original)
}

describe("a PDF from the print window, or the Word file", () => {
  it("opens the print page in the print window, and saves nothing itself", async () => {
    const p = printer()
    const out = await exportPdfOrWord(CELLS, { title: "notes", lang: "es", print: { open: p.open, userAgent: CHROME } })
    expect(out).toEqual({ kind: "print" })
    expect(p.print).toHaveBeenCalledTimes(1)
    expect(p.pages[0]).toContain("<title>notes</title>")
    expect(p.pages[0]).toContain("<h1>Capítulo uno</h1>")
    expect(p.pages[0]).toContain("@page{size:A4;margin:72pt}")
    // the print window's frame goes once the person is done with it
    expect(p.close).not.toHaveBeenCalled()
  })

  it("closes the print page when the print window closes, saved or cancelled", async () => {
    let afterPrint: (() => void) | undefined
    const p = printer({ addEventListener: (_type, listener) => { afterPrint = listener } })
    expect(await exportPdfOrWord(CELLS, { title: "notes", print: { open: p.open, userAgent: CHROME } })).toEqual({ kind: "print" })
    afterPrint?.()
    expect(p.close).toHaveBeenCalledTimes(1)
  })

  it.each([
    ["another app's built-in browser", INSTAGRAM],
    ["an Android web view", ANDROID_WEBVIEW],
  ])("gives the Word file and the sentence in %s, without opening the print window", async (_name, userAgent) => {
    const p = printer()
    const out = await exportPdfOrWord(CELLS, { title: "notes", lang: "es", print: { open: p.open, userAgent } })
    expect(p.open).not.toHaveBeenCalled()
    expect(out.kind).toBe("word")
    if (out.kind !== "word") return
    expect(out.notice).toBe(SENTENCE)
    expect(await wordText(out.blob)).toEqual(["Capítulo uno", "Primera línea."])
  })

  it("gives the Word file when the page cannot be opened for printing", async () => {
    const failing = vi.fn(async () => { throw new Error("blocked") })
    expect((await exportPdfOrWord(CELLS, { title: "n", print: { open: failing, userAgent: CHROME } })).kind).toBe("word")
    const neverLoads = printer(null)
    expect((await exportPdfOrWord(CELLS, { title: "n", print: { open: neverLoads.open, userAgent: CHROME } })).kind).toBe("word")
    expect(neverLoads.close).toHaveBeenCalled()
  })

  it("gives the Word file when the browser has no print, or its print fails", async () => {
    const none = printer({ print: undefined as unknown as () => void })
    expect((await exportPdfOrWord(CELLS, { title: "n", print: { open: none.open, userAgent: CHROME } })).kind).toBe("word")
    const throws = printer({ print: () => { throw new Error("printing is disabled") } })
    const out = await exportPdfOrWord(CELLS, { title: "n", print: { open: throws.open, userAgent: CHROME } })
    expect(out.kind).toBe("word")
    expect(throws.close).toHaveBeenCalled()
  })

  it("words the sentence through the app's messages", () => {
    expect(t("importExport.status.pdfFellBackToWord")).toBe(SENTENCE)
    expect(t("importExport.status.pdfChooseSaveAsPdf")).toBe('In the print window, choose "Save as PDF" to save the file.')
  })
})

describe("the print frame", () => {
  it("prints from a hidden frame in the app's page, and removes it when it cannot print", async () => {
    // the test browser (happy-dom) cannot print a frame
    const out = await exportPdfOrWord(CELLS, { title: "n", print: { userAgent: CHROME, loadTimeoutMs: 20 } })
    expect(out.kind).toBe("word")
    expect(document.querySelector("iframe")).toBeNull()
  })
})
