// parse-document — AQU-197
//
// POST /api/v2/parse-document
//
// Accepts a multipart/form-data upload with a single field `file` containing
// a .pdf or .docx file (max 2 MB). Returns { text: string } on success or
// { error: string } with an appropriate HTTP status.
//
// DOCX: it's a zip — extract word/document.xml and strip XML tags. Uses
// fflate (Workers-compatible, no Node-only deps).
//
// PDF: minimal text-stream extraction (look for BT…ET blocks and Tj/TJ
// operators). Content streams are inflated first (see below). Complex PDFs
// with embedded fonts or encoding tables may still produce garbled text.
// SWARM-TODO(AQU-197-pdf): replace the minimal PDF text extractor with a
// proper Workers-compatible library (e.g. unpdf) once a build-verified
// version is available. The current extractor is a best-effort fallback.

import { Hono } from "hono"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"
import { unzipSync, unzlibSync, inflateSync } from "fflate"

const MAX_FILE_BYTES = 2 * 1024 * 1024 // 2 MB
// word/document.xml inflated size cap (AQU pen-test finding, 2026-07-29): a
// small deflate-based zip can decompress to gigabytes before this route ever
// looks at its content — unlike the client-side import path (zip-safety.ts),
// this server-side unzip had no per-entry size guard. 20 MB of XML is far
// more than any real document.xml produces; fflate's `filter` option lets us
// check the declared inflated size before it inflates anything, so an
// oversized (or unrelated) entry never gets decompressed at all.
const MAX_DOCX_XML_BYTES = 20 * 1024 * 1024 // 20 MB
// Total inflated size budget across all of a PDF's content streams (AQU-197).
// Same decompression-bomb concern as the DOCX cap above: a 2 MB upload can
// declare streams that inflate to gigabytes. fflate truncates to a preallocated
// `out` buffer rather than throwing, so a per-call buffer sized to the
// remaining budget makes overrunning it structurally impossible.
const MAX_PDF_INFLATED_BYTES = 20 * 1024 * 1024 // 20 MB
// Per-stream allocation cap. The output buffer has to be preallocated, so
// without this every stream in a many-stream PDF would allocate the whole
// remaining budget. A single content stream from a ≤2 MB upload inflating past
// 4 MB of text operators is not a real document.
const MAX_PDF_STREAM_BYTES = 4 * 1024 * 1024 // 4 MB

const parseDocument = new Hono<AuthHonoEnv>()

// ── DOCX helpers ─────────────────────────────────────────────────────────────

export function extractTextFromDocx(bytes: Uint8Array): string {
  let documentXmlTooLarge = false
  let files: ReturnType<typeof unzipSync>
  try {
    files = unzipSync(bytes, {
      filter(file) {
        if (file.name !== "word/document.xml") return false
        if (file.originalSize > MAX_DOCX_XML_BYTES) {
          documentXmlTooLarge = true
          return false
        }
        return true
      },
    })
  } catch {
    throw new Error("DOCX file appears to be corrupt (could not unzip).")
  }

  if (documentXmlTooLarge) {
    throw new Error("word/document.xml exceeds the safe size limit — file may be a zip bomb.")
  }

  const xmlBytes = files["word/document.xml"]
  if (!xmlBytes) {
    throw new Error("word/document.xml not found — may not be a valid DOCX.")
  }

  const xml = new TextDecoder().decode(xmlBytes)

  // Extract text runs (<w:t>) in order, preserving paragraph breaks.
  // We insert a newline at each <w:p> (paragraph) boundary.
  const text = xml
    // Replace paragraph ends with newline sentinel
    .replace(/<\/w:p>/gi, "\n")
    // Grab text content of <w:t> elements
    .replace(/<w:t[^>]*>([\s\S]*?)<\/w:t>/gi, (_m, t) => t)
    // Strip remaining XML tags
    .replace(/<[^>]+>/g, "")
    // Decode basic XML entities
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    // Collapse more-than-two consecutive newlines
    .replace(/\n{3,}/g, "\n\n")
    .trim()

  return text
}

// ── PDF helpers ───────────────────────────────────────────────────────────────

// Inflate every /FlateDecode content stream in the file.
//
// AQU-197: essentially every PDF produced by a real writer (Word, InDesign,
// LaTeX, "print to PDF") stores its content streams zlib-compressed, so the
// text operators never appear in the raw bytes and a raw scan extracts
// nothing at all. Only hand-written/synthetic PDFs are uncompressed.
//
// Decoding latin1 maps bytes 0x00–0xFF one-to-one onto U+0000–U+00FF, so
// offsets into `raw` are byte offsets into `bytes` and can be used to slice.
function inflatePdfStreams(bytes: Uint8Array, raw: string): string[] {
  const decoded: string[] = []
  let budget = MAX_PDF_INFLATED_BYTES

  const streamRe = /stream\r?\n/g
  let match: RegExpExecArray | null
  while ((match = streamRe.exec(raw)) !== null) {
    if (budget <= 0) break

    // A stream's dictionary is the `<< … >>` immediately preceding the keyword.
    const dictStart = raw.lastIndexOf("<<", match.index)
    const dict = dictStart === -1 ? "" : raw.slice(dictStart, match.index)
    if (!dict.includes("/FlateDecode")) continue
    // Images and embedded font programs inflate to binary that can never hold
    // text operators — skip them so they don't consume the budget.
    if (/\/Subtype\s*\/Image|\/FontFile/.test(dict)) continue

    const dataStart = match.index + match[0].length
    const dataEnd = raw.indexOf("endstream", dataStart)
    if (dataEnd === -1) continue

    const inflated = inflateBounded(bytes.subarray(dataStart, dataEnd), budget)
    if (inflated) {
      budget -= inflated.length
      decoded.push(new TextDecoder("latin1").decode(inflated))
    }

    // Resume scanning past this stream so its binary payload isn't re-searched.
    streamRe.lastIndex = dataEnd
  }

  return decoded
}

// Inflate into a buffer sized to the remaining budget. fflate truncates to the
// provided `out` buffer instead of throwing, which is what bounds a bomb.
function inflateBounded(slice: Uint8Array, budget: number): Uint8Array | null {
  const cap = Math.min(budget, MAX_PDF_STREAM_BYTES)
  // zlib-wrapped is the norm; some writers emit raw deflate instead.
  for (const inflate of [unzlibSync, inflateSync]) {
    try {
      return inflate(slice, { out: new Uint8Array(cap) })
    } catch {
      // Wrong framing or corrupt stream — fall through and try the next.
    }
  }
  return null
}

export function extractTextFromPdf(bytes: Uint8Array): string {
  // SWARM-TODO(AQU-197-pdf): this is a minimal best-effort extractor.
  // It decodes the raw byte stream looking for PDF text operators (Tj, TJ, ')
  // inside BT…ET blocks. It handles ISO-8859-1 literals and octal escapes
  // but will produce garbled output for PDFs with custom font encoding tables.
  const raw = new TextDecoder("latin1").decode(bytes)

  // Scan the inflated content streams as well as the raw bytes, so both
  // real-world (compressed) and uncompressed PDFs extract.
  const haystacks = [...inflatePdfStreams(bytes, raw), raw]

  const chunks: string[] = []

  for (const haystack of haystacks) {
    // Iterate BT…ET blocks
    const btEtRe = /BT\s([\s\S]*?)ET/g
    let blockMatch: RegExpExecArray | null
    while ((blockMatch = btEtRe.exec(haystack)) !== null) {
      const block = blockMatch[1]

      // Match string operands of Tj / ' / " operators and TJ arrays
      // Tj: (string) Tj
      // TJ: [(string) ...] TJ
      // ' : (string) '
      const opRe = /\(([^)\\]*(?:\\.[^)\\]*)*)\)\s*(?:Tj|'|")|(\[[\s\S]*?\])\s*TJ/g
      let opMatch: RegExpExecArray | null
      while ((opMatch = opRe.exec(block)) !== null) {
        if (opMatch[1] !== undefined) {
          // Single string
          chunks.push(decodePdfString(opMatch[1]))
        } else if (opMatch[2] !== undefined) {
          // TJ array — extract all parenthesized strings
          const arrayStr = opMatch[2]
          const strRe = /\(([^)\\]*(?:\\.[^)\\]*)*)\)/g
          let strMatch: RegExpExecArray | null
          while ((strMatch = strRe.exec(arrayStr)) !== null) {
            chunks.push(decodePdfString(strMatch[1]))
          }
        }
      }
      chunks.push("\n")
    }
  }

  return chunks
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function decodePdfString(s: string): string {
  // Unescape PDF string escape sequences
  return s
    .replace(/\\(\d{1,3})/g, (_m, oct) => String.fromCharCode(parseInt(oct, 8)))
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\\\/g, "\\")
    .replace(/\\\(/g, "(")
    .replace(/\\\)/g, ")")
}

// ── Route ─────────────────────────────────────────────────────────────────────

parseDocument.post("/", authMiddleware, async (c) => {
  let formData: FormData
  try {
    formData = await c.req.formData()
  } catch {
    return c.json({ error: "Expected multipart/form-data with a `file` field." }, 400)
  }

  const fileField = formData.get("file")
  if (!fileField || typeof fileField === "string") {
    return c.json({ error: "Missing `file` field in form data." }, 400)
  }

  const file = fileField as File
  const name = file.name?.toLowerCase() ?? ""
  const isPdf = name.endsWith(".pdf") || file.type === "application/pdf"
  const isDocx =
    name.endsWith(".docx") ||
    file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

  if (!isPdf && !isDocx) {
    return c.json(
      { error: "Unsupported file type. Only .pdf and .docx are accepted." },
      415,
    )
  }

  if (file.size > MAX_FILE_BYTES) {
    return c.json(
      {
        error: `File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum is 2 MB.`,
      },
      413,
    )
  }

  const arrayBuffer = await file.arrayBuffer()
  const bytes = new Uint8Array(arrayBuffer)

  let text: string
  try {
    if (isDocx) {
      text = extractTextFromDocx(bytes)
    } else {
      text = extractTextFromPdf(bytes)
    }
  } catch (err) {
    console.error("parse-document extraction failed:", err)
    return c.json({ error: "Could not extract text from file" }, 422)
  }

  if (!text.trim()) {
    return c.json(
      { error: "No text could be extracted from the file. It may be image-only or encrypted." },
      422,
    )
  }

  return c.json({ text })
})

export default parseDocument
