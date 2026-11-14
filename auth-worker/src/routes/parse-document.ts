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
// PDF: read with pdf.js through unpdf's serverless build (AQU-2551). A
// password-protected or text-less PDF answers 422 with a `code` ("password",
// "empty") so the client can say which.

import { Hono } from "hono"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"
import { enforceRateLimit, userRateLimitIdentifier } from "../../../db/shared/rate-limit"
import { unzipSync, unzlibSync, inflateSync } from "fflate"
import { extractText, getDocumentProxy } from "unpdf"
import { readBytesWithLimit } from "../../../shared/http-body-limit"

const MAX_FILE_BYTES = 2 * 1024 * 1024 // 2 MB
// Ceiling on the whole multipart envelope (AQU-1858). The form used to be
// parsed before MAX_FILE_BYTES was applied, so a caller could make the route
// materialize an arbitrarily large upload it was always going to refuse. The
// slack over MAX_FILE_BYTES covers the boundary markers and part headers
// wrapping a file that is itself exactly at the limit.
/** Parses per user per rate-limit window (generous for bulk import). */
const PARSE_MAX_PER_USER_PER_WINDOW = 120
const MAX_UPLOAD_BYTES = MAX_FILE_BYTES + 16 * 1024
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
// Total inflated size budget across a PDF's compressed streams (AQU-197,
// AQU-2551). Same decompression-bomb concern as the DOCX cap above: a 2 MB
// upload can declare streams that inflate to gigabytes. A PDF over it is
// refused before pdf.js reads it (assertPdfInflatesWithinBudget). AQU-2551:
// fonts and object streams now count too, since pdf.js decodes them, so the
// budget is set well above what a ≤2 MB real document inflates to.
const MAX_PDF_INFLATED_BYTES = 48 * 1024 * 1024 // 48 MB
// Per-stream cap. The check's output buffer has to be preallocated, so without
// this every stream would allocate the whole remaining budget. A single
// stream from a ≤2 MB upload inflating past 16 MB is not a real document.
const MAX_PDF_STREAM_BYTES = 16 * 1024 * 1024 // 16 MB

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

// ── PDF ──────────────────────────────────────────────────────────────────────

/** Why a PDF gave no text, for the client to word (AQU-2551). */
export type PdfExtractionCode = "password" | "empty" | "unreadable" | "too-complex"

export class PdfExtractionError extends DocumentExtractionError {
  readonly code: PdfExtractionCode

  constructor(code: PdfExtractionCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "PdfExtractionError"
    this.code = code
  }
}

// AQU-2551: a decompression-bomb gate before pdf.js sees the file. A ≤2 MB
// upload can declare streams that inflate to gigabytes, and pdf.js keeps a
// stream's whole decoded output while it reads it, inside a 128 MB Worker.
// Every /FlateDecode stream except images (which text extraction never
// decodes) is inflated into a buffer of bounded size; fflate truncates to that
// buffer instead of growing, so the check itself cannot balloon. A stream that
// fills its buffer, or a file over the total, is refused.
//
// Decoding latin1 maps bytes 0x00–0xFF one-to-one onto U+0000–U+00FF, so
// offsets into `raw` are byte offsets into `bytes` and can be used to slice.
function assertPdfInflatesWithinBudget(bytes: Uint8Array): void {
  const raw = new TextDecoder("latin1").decode(bytes)
  let budget = MAX_PDF_INFLATED_BYTES
  const streamRe = /stream\r?\n/g
  let match: RegExpExecArray | null
  while ((match = streamRe.exec(raw)) !== null) {
    // A stream's dictionary is the `<< … >>` immediately preceding the keyword.
    const dictStart = raw.lastIndexOf("<<", match.index)
    const dict = dictStart === -1 ? "" : raw.slice(dictStart, match.index)
    const dataStart = match.index + match[0].length
    const dataEnd = raw.indexOf("endstream", dataStart)
    if (dataEnd === -1) break
    streamRe.lastIndex = dataEnd
    if (!dict.includes("/FlateDecode") || /\/Subtype\s*\/Image/.test(dict)) continue
    const cap = Math.min(budget, MAX_PDF_STREAM_BYTES)
    const inflated = inflateBounded(bytes.subarray(dataStart, dataEnd), cap)
    if (!inflated) continue // corrupt or not zlib: pdf.js decides
    if (inflated.length >= cap) {
      throw new PdfExtractionError("too-complex", "the PDF is too complex to read: its compressed content expands too far.")
    }
    budget -= inflated.length
  }
}

// Inflate into a buffer of `cap` bytes. fflate truncates to the provided `out`
// buffer instead of throwing, which is what bounds a bomb.
function inflateBounded(slice: Uint8Array, cap: number): Uint8Array | null {
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

/**
 * The text of a PDF, read with pdf.js (unpdf's serverless build, made for
 * Workers: no DOM, no canvas, its worker inlined). AQU-2551: this replaced a
 * scan for text operators that missed everything drawn with embedded
 * (Identity-H) fonts — about 5/6 of a Word PDF's text, and all its Greek and
 * Hebrew. pdf.js maps each glyph back to Unicode through the font's own
 * tables.
 *
 * A password-protected PDF and one with no text (empty, or scanned images)
 * are refused with a `PdfExtractionError` code, so the client can say which.
 */
export async function extractTextFromPdf(bytes: Uint8Array): Promise<string> {
  assertPdfInflatesWithinBudget(bytes)
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>
  try {
    // pdf.js transfers (detaches) the buffer it is given: hand it a copy.
    pdf = await getDocumentProxy(bytes.slice(), {
      useSystemFonts: false,
      disableFontFace: true,
      stopAtErrors: false,
    })
  } catch (err) {
    if ((err as { name?: string } | null)?.name === "PasswordException") {
      throw new PdfExtractionError("password", "the PDF is password-protected. Remove the password and upload it again.", { cause: err })
    }
    throw new PdfExtractionError("unreadable", "the file could not be read as a PDF.", { cause: err })
  }
  let text: string
  try {
    text = (await extractText(pdf, { mergePages: true })).text
  } finally {
    await pdf.loadingTask.destroy().catch(() => {})
  }
  if (!text.trim()) {
    throw new PdfExtractionError("empty", "the PDF has no text. It may be scanned images or empty.")
  }
  return text.trim()
}

// ── Route ─────────────────────────────────────────────────────────────────────

parseDocument.post("/", authMiddleware, async (c) => {
  // Pen-test 2026-10-15: CPU-heavy PDF/DOCX parsing was unthrottled per user.
  const parseLimit = await enforceRateLimit(c.env.AQUILLA_PG, {
    kind: "parse_document",
    identifier: userRateLimitIdentifier(c.get("user").id),
    limit: PARSE_MAX_PER_USER_PER_WINDOW,
    failMode: "open",
  })
  if (!parseLimit.allowed) {
    return c.json(
      { error: "Too many documents parsed. Try again shortly." },
      429,
      { "Retry-After": String(parseLimit.retryAfterSeconds) },
    )
  }

  // Size-gate the upload before the form is parsed (AQU-1858): an oversize
  // Content-Length is refused from the headers alone, and a chunked body with
  // no declared length is read through the same byte cap. Only the capped
  // bytes reach the multipart parser.
  const upload = await readBytesWithLimit(c.req.raw.headers, c.req.raw.body, MAX_UPLOAD_BYTES)
  if (!upload.ok) {
    return c.json(
      { error: `File too large. Maximum is ${megabytes(MAX_FILE_BYTES)} MB.` },
      413,
    )
  }

  let formData: FormData
  try {
    formData = await new Response(upload.bytes, {
      headers: { "content-type": c.req.header("content-type") ?? "" },
    }).formData()
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
      text = await extractTextFromPdf(bytes)
    }
  } catch (err) {
    console.error("parse-document extraction failed:", err)
    // AQU-1499: same contract as the knowledge-base upload — a
    // DocumentExtractionError's message is authored to be shown, so a caller
    // whose file was refused for a fixable reason can act on it instead of
    // guessing. Anything else stays generic.
    return c.json(
      {
        error:
          err instanceof DocumentExtractionError
            ? `Could not extract text from file: ${err.message}`
            : "Could not extract text from file",
        // AQU-2551: why a PDF gave no text, so the client can say which.
        ...(err instanceof PdfExtractionError ? { code: err.code } : {}),
      },
      422,
    )
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
