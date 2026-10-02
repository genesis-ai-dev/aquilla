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
// this server-side unzip had no per-entry size guard. fflate's `filter` option
// lets us check the declared inflated size before it inflates anything, so an
// oversized (or unrelated) entry never gets decompressed at all.
//
// AQU-1499: raised from 20 MB, which "far more than any real document.xml
// produces" turned out to be wrong. Word writes one `<w:r><w:rPr>…</w:rPr>`
// per CHARACTER for documents that have passed through several editors (common
// for Arabic/RTL text), so a real 68k-word partner book was 39.5 MB of
// document.xml from 882 KB on disk — a legitimate file this cap refused. The
// ceiling is now set by what the extractor actually costs rather than by a
// guess about document size: `extractDocxPlainText` scans the inflated BYTES
// in one pass, so peak memory is about the part itself plus the extracted
// text, and 64 MB leaves room inside a Worker's 128 MB budget. Raising it
// further means making the inflate itself streaming first.
const MAX_DOCX_XML_BYTES = 64 * 1024 * 1024 // 64 MB
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

/**
 * An extraction failure whose message is safe to hand back to the uploader.
 *
 * AQU-1499: every failure in here used to be swallowed by a bare `catch` in
 * routes/knowledge.ts and reported as "could not extract text", so a partner
 * whose file was rejected for a knowable, fixable reason (a bloated
 * `word/document.xml`) saw nothing actionable. These messages are authored
 * here, name no internals, and are meant to reach the user verbatim —
 * anything else that throws stays generic.
 */
export class DocumentExtractionError extends Error {
  /** Inflated size of `word/document.xml`, when the failure is about its size. */
  readonly documentXmlBytes: number | undefined

  constructor(message: string, options?: { documentXmlBytes?: number; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = "DocumentExtractionError"
    this.documentXmlBytes = options?.documentXmlBytes
  }
}

const DOCUMENT_PART = "word/document.xml"

function megabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")
}

export function extractTextFromDocx(bytes: Uint8Array): string {
  let oversizeBytes = 0
  let files: ReturnType<typeof unzipSync>
  try {
    files = unzipSync(bytes, {
      filter(file) {
        if (file.name !== DOCUMENT_PART) return false
        if (file.originalSize > MAX_DOCX_XML_BYTES) {
          oversizeBytes = file.originalSize
          return false
        }
        return true
      },
    })
  } catch (err) {
    throw new DocumentExtractionError("DOCX file appears to be corrupt (could not unzip).", {
      cause: err,
    })
  }

  if (oversizeBytes > 0) {
    throw new DocumentExtractionError(
      `the document is too complex to read: word/document.xml is ${megabytes(oversizeBytes)} MB, ` +
        `over the ${megabytes(MAX_DOCX_XML_BYTES)} MB limit. Re-saving the file from Word ` +
        `("Save As" a new .docx) usually shrinks it.`,
      { documentXmlBytes: oversizeBytes },
    )
  }

  const xmlBytes = files[DOCUMENT_PART]
  if (!xmlBytes) {
    throw new DocumentExtractionError("word/document.xml not found — may not be a valid DOCX.")
  }

  return extractDocxPlainText(xmlBytes)
}

// Byte values of the ASCII punctuation the scanner keys on. `word/document.xml`
// is UTF-8 and every tag name and delimiter in it is ASCII, so tag boundaries
// can be found in the raw bytes and only the kept text spans need decoding.
const BYTE_LT = 0x3c // <
const BYTE_GT = 0x3e // >
const BYTE_SLASH = 0x2f // /
const BYTE_DQUOTE = 0x22 // "
const BYTE_SQUOTE = 0x27 // '
const BYTE_BANG = 0x21 // !

const W_T_CLOSE = [0x3c, 0x2f, 0x77, 0x3a, 0x74, 0x3e] // </w:t>
const COMMENT_OPEN = [0x3c, 0x21, 0x2d, 0x2d] // <!--
const COMMENT_CLOSE = [0x2d, 0x2d, 0x3e] // -->

/** Flush the in-flight concatenation this often so a per-character-run document
 *  cannot build a multi-million-node rope (AQU-1499). */
const TEXT_CHUNK_CHARS = 64 * 1024

/**
 * Extract a DOCX's paragraph text in ONE bounded pass over the inflated
 * `word/document.xml` bytes.
 *
 * AQU-1499: this replaced a chain of seven `String.replace()` calls over the
 * whole decoded part. That read fine at a few hundred KB, but a real partner
 * file — a 68k-word Arabic book Word had saved with one `<w:r><w:rPr>…` per
 * CHARACTER, 39.5 MB of `document.xml` from 882 KB on disk — made each link in
 * the chain allocate another copy of a ~40 MB string (~80 MB as UTF-16, since
 * Arabic text forces two-byte strings) and OOM'd the 128 MB Worker. Verified:
 * with the old pipeline a 41.7 MB fixture dies under `--max-old-space-size=128`.
 *
 * Scanning the bytes instead keeps peak memory at roughly the inflated part
 * plus the extracted text, which is what makes a 64 MB ceiling safe inside a
 * Worker. Only `<w:t>` content is kept, so field codes (`w:instrText`) and
 * tracked deletions (`w:delText`) no longer leak into the output the way the
 * blanket tag-strip let them.
 */
export function extractDocxPlainText(xml: Uint8Array): string {
  const decoder = new TextDecoder()
  const chunks: string[] = []
  let chunk = ""

  const emit = (text: string) => {
    chunk += text
    if (chunk.length >= TEXT_CHUNK_CHARS) {
      chunks.push(chunk)
      chunk = ""
    }
  }

  let i = 0
  while (i < xml.length) {
    const lt = xml.indexOf(BYTE_LT, i)
    if (lt === -1) break

    // A comment can legally contain '>', so it is skipped as a unit rather
    // than read as a tag.
    if (matchesAt(xml, COMMENT_OPEN, lt)) {
      const close = indexOfSequence(xml, COMMENT_CLOSE, lt + COMMENT_OPEN.length)
      i = close === -1 ? xml.length : close + COMMENT_CLOSE.length
      continue
    }

    const tag = readTag(xml, lt)
    if (!tag) break

    // One newline per paragraph end — the paragraph separator the old pipeline
    // produced by replacing `</w:p>`.
    if (tag.closing && tag.name === "w:p") {
      emit("\n")
      i = tag.end + 1
      continue
    }

    if (!tag.closing && !tag.selfClosing && tag.name === "w:t") {
      const close = indexOfSequence(xml, W_T_CLOSE, tag.end + 1)
      const textEnd = close === -1 ? xml.length : close
      emit(decodeTextSpan(decoder, xml.subarray(tag.end + 1, textEnd)))
      i = close === -1 ? xml.length : close + W_T_CLOSE.length
      continue
    }

    i = tag.end + 1
  }

  if (chunk) chunks.push(chunk)
  return chunks.join("").replace(/\n{3,}/g, "\n\n").trim()
}

interface DocxTag {
  /** Tag name verbatim, prefix included (`w:t`, not `t`). */
  name: string
  /** Index of the `>` that closes this tag. */
  end: number
  closing: boolean
  selfClosing: boolean
}

/** Read the tag starting at `lt`, or null when it is unterminated. */
function readTag(xml: Uint8Array, lt: number): DocxTag | null {
  let i = lt + 1
  const closing = xml[i] === BYTE_SLASH
  if (closing) i++
  // `<!DOCTYPE …>` / `<?xml …?>` have no name worth reading; they fall through
  // as unmatched names and are skipped by the caller.
  const nameStart = i
  while (i < xml.length && !isNameDelimiter(xml[i])) i++
  const name = asciiSlice(xml, nameStart, i)

  let quote = 0
  while (i < xml.length) {
    const byte = xml[i]
    if (quote !== 0) {
      if (byte === quote) quote = 0
    } else if (byte === BYTE_DQUOTE || byte === BYTE_SQUOTE) {
      quote = byte
    } else if (byte === BYTE_GT) {
      return { name, end: i, closing, selfClosing: xml[i - 1] === BYTE_SLASH }
    }
    i++
  }
  return null
}

function isNameDelimiter(byte: number): boolean {
  return (
    byte === BYTE_GT ||
    byte === BYTE_SLASH ||
    byte === 0x20 ||
    byte === 0x09 ||
    byte === 0x0a ||
    byte === 0x0d ||
    byte === BYTE_BANG
  )
}

function asciiSlice(xml: Uint8Array, start: number, end: number): string {
  let out = ""
  for (let i = start; i < end; i++) out += String.fromCharCode(xml[i])
  return out
}

function matchesAt(xml: Uint8Array, needle: readonly number[], at: number): boolean {
  if (at + needle.length > xml.length) return false
  for (let i = 0; i < needle.length; i++) if (xml[at + i] !== needle[i]) return false
  return true
}

function indexOfSequence(xml: Uint8Array, needle: readonly number[], from: number): number {
  const first = needle[0]
  for (let at = xml.indexOf(first, from); at !== -1; at = xml.indexOf(first, at + 1)) {
    if (matchesAt(xml, needle, at)) return at
  }
  return -1
}

/**
 * Decode one `<w:t>` span. `w:t` holds only character data, so the tag strip is
 * defensive — it keeps a malformed part from leaking markup the way the old
 * blanket strip did. Entity handling matches the five predefined XML entities
 * the previous pipeline decoded.
 */
function decodeTextSpan(decoder: TextDecoder, span: Uint8Array): string {
  const text = decoder.decode(span)
  if (!text.includes("<") && !text.includes("&")) return text
  return text
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
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
