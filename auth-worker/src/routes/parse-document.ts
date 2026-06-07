// parse-document — FRO-197
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
// operators). This covers most simple PDFs. Complex PDFs with embedded fonts
// or encoding tables may produce garbled text.
// SWARM-TODO(FRO-197-pdf): replace the minimal PDF text extractor with a
// proper Workers-compatible library (e.g. unpdf) once a build-verified
// version is available. The current extractor is a best-effort fallback.

import { Hono } from "hono"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"
import { unzipSync } from "fflate"

const MAX_FILE_BYTES = 2 * 1024 * 1024 // 2 MB

const parseDocument = new Hono<AuthHonoEnv>()

// ── DOCX helpers ─────────────────────────────────────────────────────────────

export function extractTextFromDocx(bytes: Uint8Array): string {
  let files: ReturnType<typeof unzipSync>
  try {
    files = unzipSync(bytes)
  } catch {
    throw new Error("DOCX file appears to be corrupt (could not unzip).")
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

export function extractTextFromPdf(bytes: Uint8Array): string {
  // SWARM-TODO(FRO-197-pdf): this is a minimal best-effort extractor.
  // It decodes the raw byte stream looking for PDF text operators (Tj, TJ, ')
  // inside BT…ET blocks. It handles ISO-8859-1 literals and octal escapes
  // but will produce garbled output for PDFs with custom font encoding tables.
  const raw = new TextDecoder("latin1").decode(bytes)

  const chunks: string[] = []

  // Iterate BT…ET blocks
  const btEtRe = /BT\s([\s\S]*?)ET/g
  let blockMatch: RegExpExecArray | null
  while ((blockMatch = btEtRe.exec(raw)) !== null) {
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
    const message = err instanceof Error ? err.message : "Parse failed."
    return c.json({ error: `Could not extract text: ${message}` }, 422)
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
