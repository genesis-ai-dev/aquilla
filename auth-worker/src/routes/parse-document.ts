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
import { enforceRateLimit, userRateLimitIdentifier } from "../../../db/shared/rate-limit"
import { unzipSync, inflateSync, Inflate } from "fflate"
import { readBytesWithLimit } from "../../../shared/http-body-limit"
import { MAX_KB_TEXT_CHARS } from "../../../db/shared/knowledge"

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
// Total inflated size budget across all of a PDF's content streams (AQU-197).
// Same decompression-bomb concern as the DOCX cap above: a 2 MB upload can
// declare streams that inflate to gigabytes. fflate truncates to a preallocated
// `out` buffer rather than throwing, so a per-call buffer sized to the
// remaining budget makes overrunning it structurally impossible.
const MAX_PDF_INFLATED_BYTES = 20 * 1024 * 1024 // 20 MB
// Per-stream cap. A single content stream from a ≤2 MB upload inflating past
// 4 MB of text operators is not a real document. One output buffer of this
// size is reused for every stream in the file (AQU-2594).
const MAX_PDF_STREAM_BYTES = 4 * 1024 * 1024 // 4 MB
// AQU-2594: bounds on the work around those caps. They bounded the bytes
// inflated, not the scanning: a crafted ~2 MB upload cost minutes of CPU or
// hundreds of MB (see the PDF helpers below).
//
// A stream's dictionary is looked for only this far before its `stream`
// keyword. Writers put `<<…>>` right before it; a few hundred bytes is long.
const PDF_DICT_WINDOW = 4 * 1024 // 4 KB
// Stream keywords examined per file. Each costs a dictionary search, so this
// bounds a file of nothing but tiny streams; 10,000 real streams in a 2 MB
// upload would average 200 bytes each.
const MAX_PDF_STREAMS = 10_000
// The whole extraction's work: bytes scanned (the keyword scan, dictionary
// searches, stream bodies searched for `endstream`, every text scan) plus
// bytes inflated. A 2 MB PDF that fills the 20 MB inflation cap spends about
// 45 MB; past this the file is refused as too complex.
const MAX_PDF_WORK_BYTES = 64 * 1024 * 1024 // 64 MB
// Deflate's largest expansion: a 258-byte copy for two bits of input.
const MAX_DEFLATE_RATIO = 1032
// Compressed bytes handed to the inflater per step, so a step yields at most
// ~1 MB and inflation stops within a step of the per-stream cap instead of
// decoding the whole stream.
const INFLATE_STEP_BYTES = 1024
// AQU-2594: the most text one PDF yields, the most the knowledge base stores.
// Five 4 MB streams of shown text from a 20 KB file came to 20 M characters,
// which the parse-document route then sent back as a ~40 MB JSON reply.
const MAX_PDF_TEXT_CHARS = MAX_KB_TEXT_CHARS

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

/**
 * AQU-2594: the running total of one extraction's work: bytes scanned plus
 * bytes inflated. Past MAX_PDF_WORK_BYTES the file is refused as too complex,
 * before the work, rather than read slowly.
 */
class PdfWorkBudget {
  private spent = 0

  charge(bytes: number): void {
    this.spent += bytes
    if (this.spent > MAX_PDF_WORK_BYTES) {
      throw new DocumentExtractionError(
        "the document is too complex to read: this PDF takes more work to read than the limit allows. " +
          'Saving it again ("Save As" a new PDF, or as a .docx) usually helps.',
      )
    }
  }
}

// Inflate every /FlateDecode content stream in the file.
//
// AQU-197: essentially every PDF produced by a real writer (Word, InDesign,
// LaTeX, "print to PDF") stores its content streams zlib-compressed, so the
// text operators never appear in the raw bytes and a raw scan extracts
// nothing at all. Only hand-written/synthetic PDFs are uncompressed.
//
// Decoding latin1 maps bytes 0x00–0xFF one-to-one onto U+0000–U+00FF, so
// offsets into `raw` are byte offsets into `bytes` and can be used to slice.
function inflatePdfStreams(bytes: Uint8Array, raw: string, work: PdfWorkBudget): string[] {
  const decoded: string[] = []
  let budget = MAX_PDF_INFLATED_BYTES
  // AQU-2594: one output buffer for the call, reused for every stream; only
  // the bytes a stream produced are copied out of it.
  let out: Uint8Array | undefined
  const latin1 = new TextDecoder("latin1")
  let examined = 0

  work.charge(raw.length) // the keyword scan below
  // AQU-2594: not the tail of `endstream`. That match used to carry the scan
  // (below, `lastIndex = dataEnd`) past the next real stream, so only some of
  // a PDF's content streams were read.
  const streamRe = /(?<!end)stream\r?\n/g
  let match: RegExpExecArray | null
  while ((match = streamRe.exec(raw)) !== null) {
    if (budget <= 0) break
    if (++examined > MAX_PDF_STREAMS) break

    // A stream's dictionary is the `<< … >>` immediately preceding the keyword.
    // AQU-2594: looked for only within PDF_DICT_WINDOW of it. Searching back
    // to the file's start made a file with no `<<` quadratic.
    const windowStart = Math.max(0, match.index - PDF_DICT_WINDOW)
    const inWindow = raw.slice(windowStart, match.index).lastIndexOf("<<")
    const dictStart = inWindow === -1 ? -1 : windowStart + inWindow
    work.charge(match.index - (dictStart === -1 ? windowStart : dictStart))
    const dict = dictStart === -1 ? "" : raw.slice(dictStart, match.index)
    if (!dict.includes("/FlateDecode")) continue
    // Images and embedded font programs inflate to binary that can never hold
    // text operators — skip them so they don't consume the budget.
    if (/\/Subtype\s*\/Image|\/FontFile/.test(dict)) continue
    // AQU-2594: nor can a stream that needs another filter as well as Flate
    // ([/ASCII85Decode /FlateDecode], as Distiller wrote): it fails to inflate,
    // and each failure spends the inflation budget the later pages need.
    if (/\/(?:ASCIIHex|ASCII85|LZW|RunLength)Decode/.test(dict)) continue

    const dataStart = match.index + match[0].length
    const dataEnd = raw.indexOf("endstream", dataStart)
    // AQU-2594: no `endstream` after this keyword means none after any later
    // one either; stopping keeps each later search from rescanning the tail.
    if (dataEnd === -1) break
    work.charge(dataEnd - dataStart)

    out ??= new Uint8Array(MAX_PDF_STREAM_BYTES)
    const limit = Math.min(budget, MAX_PDF_STREAM_BYTES)
    const cost = { decoded: 0 }
    const produced = inflateBounded(bytes.subarray(dataStart, dataEnd), out, limit, cost)
    work.charge(cost.decoded)
    if (produced !== null) {
      budget -= produced
      decoded.push(latin1.decode(out.subarray(0, produced)))
    } else {
      // AQU-2594: a stream that fails to decode spends the inflation budget
      // it may have used, so failures cannot be repeated for free.
      budget -= cost.decoded
    }

    // Resume scanning past this stream so its binary payload isn't re-searched.
    streamRe.lastIndex = dataEnd
  }

  return decoded
}

// Inflate one stream into `out`, keeping at most `limit` bytes, and return how
// many it kept, or null when neither framing decodes it. `cost.decoded`
// collects how many bytes the attempts decoded.
//
// AQU-2594: fflate given a preallocated `out` keeps only what fits but still
// decodes the whole stream, so a 2 MB bomb cost seconds of CPU. A stream that
// could inflate past `out` is now fed to the inflater a step at a time and
// left once `limit` bytes are kept. One that can't (most of them: content
// streams are small) is inflated in one call straight into `out`, as before,
// which allocates nothing; the stepping inflater allocates ~160 KB per stream,
// 1.6 GB over a file of 10,000 tiny streams. A decode that fails counts as the
// most it could have produced: fflate does not say how far it got, and random
// bytes (an encrypted PDF's streams) often decode to their end before failing.
function inflateBounded(
  slice: Uint8Array,
  out: Uint8Array,
  limit: number,
  cost: { decoded: number },
): number | null {
  // zlib-wrapped is the norm; some writers emit raw deflate instead.
  for (const deflateData of [zlibDeflateData, rawDeflateData]) {
    let data: Uint8Array
    try {
      data = deflateData(slice)
    } catch {
      continue // not this framing; nothing was decoded
    }
    const kept =
      data.length * MAX_DEFLATE_RATIO <= out.length
        ? inflateOnce(data, out, limit, cost)
        : inflateSteps(data, out, limit, cost)
    if (kept !== null) return kept
    // Wrong framing or corrupt stream — fall through and try the next.
  }
  return null
}

/** The deflate data of a zlib stream, as fflate's unzlibSync reads it: the same
 *  header check, and the 4-byte checksum left off. */
function zlibDeflateData(slice: Uint8Array): Uint8Array {
  const cmf = slice[0] ?? 0
  const flg = slice[1] ?? 0
  if ((cmf & 15) !== 8 || cmf >> 4 > 7 || ((cmf << 8) | flg) % 31) throw new Error("invalid zlib data")
  // A preset dictionary is refused, as unzlibSync refuses it without one.
  if ((flg >> 5) & 1) throw new Error("invalid zlib data: need dictionary")
  return slice.subarray(2, -4)
}

function rawDeflateData(slice: Uint8Array): Uint8Array {
  return slice
}

/** One call straight into `out`, for data too short to inflate past it. */
function inflateOnce(
  data: Uint8Array,
  out: Uint8Array,
  limit: number,
  cost: { decoded: number },
): number | null {
  // fflate returns the whole `out` for empty input; nothing was decoded.
  if (data.length === 0) return 0
  try {
    const produced = inflateSync(data, { out }).length
    cost.decoded += produced
    return Math.min(produced, limit)
  } catch {
    cost.decoded += data.length * MAX_DEFLATE_RATIO
    return null
  }
}

function inflateSteps(
  data: Uint8Array,
  out: Uint8Array,
  limit: number,
  cost: { decoded: number },
): number | null {
  let kept = 0
  const inflater = new Inflate((chunk) => {
    cost.decoded += chunk.length
    const take = Math.min(chunk.length, limit - kept)
    if (take > 0) {
      out.set(chunk.subarray(0, take), kept)
      kept += take
    }
  })
  for (let at = 0; at < data.length && kept < limit && !deflateEnded(inflater); at += INFLATE_STEP_BYTES) {
    const end = Math.min(at + INFLATE_STEP_BYTES, data.length)
    try {
      inflater.push(data.subarray(at, end), end === data.length)
    } catch {
      cost.decoded += (end - at) * MAX_DEFLATE_RATIO
      return null
    }
  }
  return kept
}

/**
 * Whether the inflater has finished the deflate stream's final block. Bytes
 * after it are ignored, as the one-shot inflate ignored them, but fflate keeps
 * every unconsumed byte and copies it again on each push, so feeding it a long
 * tail would be quadratic. fflate has no public flag for this; `s.f && !s.l`
 * (final block seen, no block in progress) is the test its own inflate loop
 * makes. If a future fflate renames them this reads false, and the bound test
 * for a short stream with a long tail fails.
 */
function deflateEnded(inflater: Inflate): boolean {
  const state = (inflater as unknown as { s?: { f?: number; l?: unknown } }).s
  return !!state?.f && !state.l
}

/**
 * AQU-2594: the shown strings, joined every TEXT_PIECES_PER_JOIN pieces. A
 * file of ordinary, well-compressed `(ab)'` operators yields millions of
 * two-letter strings; held all at once they took over 128 MB.
 */
class TextPieces {
  private pending: string[] = []
  private readonly joined: string[] = []
  private length = 0

  /** Pieces past `limit` characters are dropped. */
  constructor(private readonly limit = Infinity) {}

  get full(): boolean {
    return this.length >= this.limit
  }

  push(piece: string): void {
    if (this.full) return
    if (piece.length > this.limit - this.length) piece = piece.slice(0, this.limit - this.length)
    this.length += piece.length
    this.pending.push(piece)
    if (this.pending.length >= TEXT_PIECES_PER_JOIN) {
      this.joined.push(this.pending.join(""))
      this.pending = []
    }
  }

  text(): string {
    this.joined.push(this.pending.join(""))
    this.pending = []
    return this.joined.join("")
  }
}

const TEXT_PIECES_PER_JOIN = 8192

// AQU-2594: the text operators are found in one pass. The regexes this
// replaced (/BT\s([\s\S]*?)ET/, then /\((…)\)\s*(?:Tj|'|")|(\[[\s\S]*?\])\s*TJ/
// in each block and /\((…)\)/ in each TJ array) rescanned to the end from
// every `BT`, `(` or `[` that never closed, so a 2 MB upload of `(` took
// hours. The scan below finds the same matches; parse-document-pdf-bounds
// .test.ts checks it against those regexes.
function scanTextOperators(haystack: string, chunks: TextPieces): void {
  for (let from = 0; !chunks.full; ) {
    const bt = textBlockStart(haystack, from)
    if (bt === -1) return
    const et = haystack.indexOf("ET", bt + 3)
    // No `ET` after this `BT` means none after any later one either.
    if (et === -1) return
    scanTextBlock(haystack.slice(bt + 3, et), chunks)
    chunks.push("\n")
    from = et + 2
  }
}

/** The next `BT` followed by whitespace, at or after `from`. */
function textBlockStart(s: string, from: number): number {
  for (let at = s.indexOf("BT", from); at !== -1; at = s.indexOf("BT", at + 1)) {
    if (isRegexSpace(s.charCodeAt(at + 2))) return at
  }
  return -1
}

const CHAR_LPAREN = 0x28 // (
const CHAR_RPAREN = 0x29 // )
const CHAR_LBRACKET = 0x5b // [
const CHAR_BACKSLASH = 0x5c // \

/** Shown strings in one BT…ET block: `(…) Tj`, `(…) '`, `(…) "` and `[…] TJ`. */
function scanTextBlock(block: string, chunks: TextPieces): void {
  // A `(` before this index cannot start a shown string: an earlier `(` that
  // failed ended at the same place, so this one fails the same way.
  let stringsFailBefore = 0
  // The first `]` followed by TJ at or after the last `[` looked up (-1: none
  // left, -2: not looked for yet). `[` positions only increase, so the search
  // for it never goes back over the block.
  let arrayEnd = -2

  let i = 0
  while (i < block.length) {
    const c = block.charCodeAt(i)
    if (c === CHAR_LPAREN && i >= stringsFailBefore) {
      const close = literalEnd(block, i)
      if (block.charCodeAt(close) === CHAR_RPAREN) {
        const opEnd = showStringOperatorEnd(block, skipRegexSpace(block, close + 1))
        if (opEnd !== -1) {
          chunks.push(decodePdfString(block.slice(i + 1, close)))
          i = opEnd
          continue
        }
      }
      stringsFailBefore = close
    } else if (c === CHAR_LBRACKET) {
      if (arrayEnd !== -1 && arrayEnd <= i) arrayEnd = nextTjArrayEnd(block, i + 1)
      if (arrayEnd !== -1) {
        scanArrayStrings(block.slice(i, arrayEnd + 1), chunks)
        i = skipRegexSpace(block, arrayEnd + 1) + 2
        continue
      }
    }
    i++
  }
}

/** The first `]` at or after `from` that whitespace and then `TJ` follow, or -1. */
function nextTjArrayEnd(block: string, from: number): number {
  for (let r = block.indexOf("]", from); r !== -1; r = block.indexOf("]", r + 1)) {
    if (block.startsWith("TJ", skipRegexSpace(block, r + 1))) return r
  }
  return -1
}

/** Every string literal in a TJ array, `[` and `]` included. */
function scanArrayStrings(array: string, chunks: TextPieces): void {
  for (let at = array.indexOf("("); at !== -1; ) {
    const close = literalEnd(array, at)
    if (array.charCodeAt(close) === CHAR_RPAREN) {
      chunks.push(decodePdfString(array.slice(at + 1, close)))
      at = array.indexOf("(", close + 1)
    } else {
      // Every `(` before `close` ends there too, so none of them match.
      at = array.indexOf("(", close)
    }
  }
}

/**
 * Where the string literal opened at `open` ends: the index of its closing
 * `)`, or of the point the old pattern gave up — a `\` before a line end or
 * the end of the text — which is never a `)`. A `\` escapes the next
 * character; the pattern's `.` did not match a line end.
 */
function literalEnd(s: string, open: number): number {
  let i = open + 1
  while (i < s.length) {
    const c = s.charCodeAt(i)
    if (c === CHAR_RPAREN) return i
    if (c === CHAR_BACKSLASH) {
      if (i + 1 >= s.length || isLineTerminator(s.charCodeAt(i + 1))) return i
      i += 2
    } else {
      i++
    }
  }
  return i
}

/** The end of a `Tj`, `'` or `"` operator at `at`, or -1 when there is none. */
function showStringOperatorEnd(s: string, at: number): number {
  if (s.startsWith("Tj", at)) return at + 2
  const c = s.charCodeAt(at)
  return c === 0x27 || c === 0x22 ? at + 1 : -1 // ' or "
}

function skipRegexSpace(s: string, from: number): number {
  let i = from
  while (i < s.length && isRegexSpace(s.charCodeAt(i))) i++
  return i
}

const REGEX_SPACE = /\s/

/** What the replaced patterns' `\s` matched. */
function isRegexSpace(code: number): boolean {
  if (code === 0x20 || (code >= 0x09 && code <= 0x0d)) return true
  return code > 0x7f && REGEX_SPACE.test(String.fromCharCode(code))
}

function isLineTerminator(code: number): boolean {
  return code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029
}

export function extractTextFromPdf(bytes: Uint8Array): string {
  // SWARM-TODO(AQU-197-pdf): this is a minimal best-effort extractor.
  // It decodes the raw byte stream looking for PDF text operators (Tj, TJ, ')
  // inside BT…ET blocks. It handles ISO-8859-1 literals and octal escapes
  // but will produce garbled output for PDFs with custom font encoding tables.
  const raw = new TextDecoder("latin1").decode(bytes)
  const work = new PdfWorkBudget()

  // Scan the inflated content streams as well as the raw bytes, so both
  // real-world (compressed) and uncompressed PDFs extract.
  const haystacks = [...inflatePdfStreams(bytes, raw, work), raw]

  const chunks = new TextPieces(MAX_PDF_TEXT_CHARS)
  for (const haystack of haystacks) {
    if (chunks.full) break
    work.charge(haystack.length)
    scanTextOperators(haystack, chunks)
  }

  return replaceEach(chunks.text(), BLANK_LINE_RUN, () => "\n\n").trim()
}

const BLANK_LINE_RUN = /\n{3,}/g

// Unescape PDF string escape sequences: one pass per escape, in this order.
const PDF_STRING_ESCAPES: readonly [RegExp, (match: RegExpExecArray) => string][] = [
  [/\\(\d{1,3})/g, (m) => String.fromCharCode(parseInt(m[1], 8))],
  [/\\n/g, () => "\n"],
  [/\\r/g, () => "\r"],
  [/\\t/g, () => "\t"],
  [/\\\\/g, () => "\\"],
  [/\\\(/g, () => "("],
  [/\\\)/g, () => ")"],
]

function decodePdfString(s: string): string {
  // AQU-2594: every escape starts with a backslash; most strings have none,
  // and seven regex passes over each of millions of short strings added up.
  if (!s.includes("\\")) return s
  let out = s
  for (const [pattern, replacement] of PDF_STRING_ESCAPES) out = replaceEach(out, pattern, replacement)
  return out
}

/**
 * AQU-2594: `s.replace(pattern, …)` with the global `pattern`, in pieces. A
 * global replace holds every match of the subject at once, so one 4 MB string
 * of a million escapes took ~160 MB from a 4 KB upload; this keeps one match
 * at a time and joins the pieces as TextPieces does.
 */
function replaceEach(s: string, pattern: RegExp, replacement: (match: RegExpExecArray) => string): string {
  pattern.lastIndex = 0
  let match = pattern.exec(s)
  if (match === null) return s
  const pieces = new TextPieces()
  let last = 0
  for (; match !== null; match = pattern.exec(s)) {
    pieces.push(s.slice(last, match.index))
    pieces.push(replacement(match))
    last = pattern.lastIndex
  }
  pieces.push(s.slice(last))
  return pieces.text()
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
      text = extractTextFromPdf(bytes)
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
