/**
 * AQU-2680: the fallback the PDF export will use. The PDF is made from the
 * Word file by a converter (none exists yet; it waits on question 98). When
 * the converter is missing, the device is offline, or the converter fails or
 * runs out of time, the person still gets the Word file, already built, with
 * one sentence on how to save it as PDF. Nothing is lost, and there is no
 * spinner past the time limit.
 */

import { describe, expect, it, vi } from "vitest"
import { t } from "@/lib/i18n/standalone"
import { exportPdfOrWord, type DocxToPdf } from "./pdf-or-word"

const DOCX = new Blob(["docx bytes"], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })
const PDF = new Blob(["%PDF-1.7"], { type: "application/pdf" })
const SENTENCE = "The PDF couldn't be made right now, so this is the Word file; open it in Word or Pages and save it as PDF."

describe("a PDF from the Word file, or the Word file", () => {
  it("gives the PDF when the converter makes one", async () => {
    const convert = vi.fn<DocxToPdf>(async () => PDF)
    const out = await exportPdfOrWord(DOCX, convert, { online: true })
    expect(out).toEqual({ blob: PDF, ext: "pdf", notice: null })
    expect(convert).toHaveBeenCalledWith(DOCX, expect.objectContaining({ signal: expect.any(AbortSignal) }))
  })

  it("gives the Word file and the sentence when the converter fails", async () => {
    const out = await exportPdfOrWord(DOCX, async () => { throw new Error("502") }, { online: true })
    expect(out).toEqual({ blob: DOCX, ext: "docx", notice: SENTENCE })
  })

  it("gives the Word file when the converter hands back no PDF", async () => {
    const out = await exportPdfOrWord(DOCX, async () => new Blob([]), { online: true })
    expect(out.ext).toBe("docx")
  })

  it("stops waiting at the time limit, cancels the converter and gives the Word file", async () => {
    let signal: AbortSignal | undefined
    const convert: DocxToPdf = (_docx, opts) => { signal = opts.signal; return new Promise(() => {}) }
    const t0 = performance.now()
    const out = await exportPdfOrWord(DOCX, convert, { online: true, timeoutMs: 50 })
    expect(performance.now() - t0).toBeLessThan(1_000)
    expect(out).toEqual({ blob: DOCX, ext: "docx", notice: SENTENCE })
    expect(signal?.aborted).toBe(true)
  })

  it("gives the Word file without trying when there is no converter", async () => {
    expect(await exportPdfOrWord(DOCX, undefined, { online: true })).toEqual({ blob: DOCX, ext: "docx", notice: SENTENCE })
  })

  it("gives the Word file without trying when the device is offline", async () => {
    const convert = vi.fn<DocxToPdf>(async () => PDF)
    expect(await exportPdfOrWord(DOCX, convert, { online: false })).toEqual({ blob: DOCX, ext: "docx", notice: SENTENCE })
    expect(convert).not.toHaveBeenCalled()
  })

  it("words the sentence through the app's messages", () => {
    expect(t("importExport.status.pdfFellBackToWord")).toBe(SENTENCE)
  })
})
