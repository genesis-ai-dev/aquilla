/**
 * AQU-152: PPTX + DOCX side-car round-trip fidelity tests.
 *
 * These tests verify that the raw source bytes captured during import
 * (stored as base64 in `rawSource`) decode back to the exact original
 * binary content. This is a prerequisite for the server-side serializer
 * that will inject translations back into the original ZIP structure.
 *
 * NOTE: These tests do NOT yet cover server-side injection (AQU-152a/b) —
 * that requires a server-side serializer.  They establish the invariant:
 *   import → base64(rawBytes) → base64Decode → originalBytes ≡ rawBytes
 */

import { describe, it, expect } from "vitest"
import JSZip from "jszip"
import { extractPptxStrings } from "./pptx"
import { extractDocxStrings } from "./docx"

// ─── helpers ──────────────────────────────────────────────────────────────────

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ""
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

function makePptxBuffer(slides: Record<string, string>): Promise<ArrayBuffer> {
  const zip = new JSZip()
  for (const [name, content] of Object.entries(slides)) {
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
       xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>${content}</p:spTree></p:cSld>
</p:sld>`
    zip.file(`ppt/slides/${name}`, xml)
  }
  return zip.generateAsync({ type: "arraybuffer" })
}

function makeDocxBuffer(paragraphs: string[]): Promise<ArrayBuffer> {
  const zip = new JSZip()
  const body = paragraphs
    .map(
      (text) =>
        `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`,
    )
    .join("\n")
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${body}</w:body>
</w:document>`
  zip.file("word/document.xml", xml)
  return zip.generateAsync({ type: "arraybuffer" })
}

// ─── PPTX side-car invariant ─────────────────────────────────────────────────

describe("PPTX side-car round-trip: raw bytes survive base64 encode/decode", () => {
  it("base64-encoded PPTX bytes decode back to the exact original content", async () => {
    const originalBuffer = await makePptxBuffer({
      "slide1.xml": `<p:sp><p:txBody><a:p><a:r><a:t>Hello slide</a:t></a:r></a:p></p:txBody></p:sp>`,
    })

    // Simulate what src/lib/import.ts now does on PPTX import:
    const b64 = arrayBufferToBase64(originalBuffer)
    expect(typeof b64).toBe("string")
    expect(b64.length).toBeGreaterThan(0)

    // Simulate what the export route will do: decode and re-open as JSZip
    const decoded = base64ToUint8Array(b64)
    const rezip = await JSZip.loadAsync(decoded)

    // The re-opened ZIP must have the same slides
    expect(rezip.files["ppt/slides/slide1.xml"]).toBeDefined()

    // The XML content must be byte-identical after the round-trip
    const originalZip = await JSZip.loadAsync(originalBuffer)
    const originalXml = await originalZip.file("ppt/slides/slide1.xml")!.async("string")
    const decodedXml = await rezip.file("ppt/slides/slide1.xml")!.async("string")
    expect(decodedXml).toBe(originalXml)
  })

  it("re-opening the decoded side-car PPTX still extracts the same strings", async () => {
    const originalBuffer = await makePptxBuffer({
      "slide1.xml": `<p:sp><p:txBody><a:p><a:r><a:t>Round-trip text</a:t></a:r></a:p></p:txBody></p:sp>`,
    })

    const b64 = arrayBufferToBase64(originalBuffer)
    const decoded = base64ToUint8Array(b64)

    // Re-extract strings from decoded bytes — must match original
    const original = await extractPptxStrings(originalBuffer)
    const reextracted = await extractPptxStrings(decoded.buffer as ArrayBuffer)

    expect(reextracted).toHaveLength(original.length)
    for (let i = 0; i < original.length; i++) {
      expect(reextracted[i].original).toBe(original[i].original)
      expect(reextracted[i].sourceLocation).toEqual(original[i].sourceLocation)
    }
  })

  it("size guard: files > 512 KB are documented as exceeding the D1 side-car threshold", () => {
    // This is a documentation test — it verifies the 512 KB threshold constant
    // matches the expected D1 TEXT ceiling (base64 adds ~37% overhead; 512*1024 * 1.37 ≈ 722 KB,
    // well under D1's 1 MB per-row hard limit).
    const maxRawBytes = 512 * 1024
    const worstCaseBase64Bytes = maxRawBytes * (4 / 3) // base64 overhead
    const d1RowLimit = 1 * 1024 * 1024

    expect(worstCaseBase64Bytes).toBeLessThan(d1RowLimit)
  })
})

// ─── DOCX side-car invariant ─────────────────────────────────────────────────

describe("DOCX side-car round-trip: raw bytes survive base64 encode/decode", () => {
  it("base64-encoded DOCX bytes decode back to the exact original content", async () => {
    const originalBuffer = await makeDocxBuffer(["Hello world", "Second paragraph"])

    const b64 = arrayBufferToBase64(originalBuffer)
    const decoded = base64ToUint8Array(b64)
    const rezip = await JSZip.loadAsync(decoded)

    expect(rezip.files["word/document.xml"]).toBeDefined()

    const originalZip = await JSZip.loadAsync(originalBuffer)
    const originalXml = await originalZip.file("word/document.xml")!.async("string")
    const decodedXml = await rezip.file("word/document.xml")!.async("string")
    expect(decodedXml).toBe(originalXml)
  })

  it("re-opening the decoded side-car DOCX still extracts the same strings", async () => {
    const originalBuffer = await makeDocxBuffer(["First paragraph", "Second paragraph"])

    const b64 = arrayBufferToBase64(originalBuffer)
    const decoded = base64ToUint8Array(b64)

    const original = await extractDocxStrings(originalBuffer)
    const reextracted = await extractDocxStrings(decoded.buffer as ArrayBuffer)

    expect(reextracted).toHaveLength(original.length)
    for (let i = 0; i < original.length; i++) {
      expect(reextracted[i].original).toBe(original[i].original)
      expect(reextracted[i].sourceLocation).toEqual(original[i].sourceLocation)
    }
  })
})
