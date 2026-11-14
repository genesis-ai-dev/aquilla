// parse-document — the PDF text extractor's work bounds (AQU-2594)
//
// The extractor is live behind the rule import (parse-document route) and the
// Knowledge Base upload (routes/knowledge.ts). Each file below is a small,
// legal-sized upload that used to cost minutes of CPU or hundreds of MB:
// a quadratic dictionary search, a fresh 4 MB buffer per stream, a bomb that
// was decoded in full, and text-operator regexes that rescanned to the end of
// the block from every `(`, `[` or `BT`. They are generated here, never
// committed as binaries.

import { describe, it, expect } from "vitest"
import { zlibSync, strToU8 } from "fflate"
import { DocumentExtractionError, extractTextFromPdf } from "../routes/parse-document"

/** Just under the 2 MB upload cap both routes apply before extracting. */
const UPLOAD_BYTES = 2_000_000
/** "Under a second or so" for a file the extractor now bounds. */
const FAST_MS = 1000

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** `unit` repeated to just under the upload cap, between a header and %%EOF. */
function repeatToCap(unit: Uint8Array, head = "%PDF-1.4\n"): Uint8Array {
  const headBytes = strToU8(head)
  const tail = strToU8("%%EOF")
  const count = Math.floor((UPLOAD_BYTES - headBytes.length - tail.length) / unit.length)
  const out = new Uint8Array(headBytes.length + count * unit.length + tail.length)
  out.set(headBytes, 0)
  for (let i = 0; i < count; i++) out.set(unit, headBytes.length + i * unit.length)
  out.set(tail, headBytes.length + count * unit.length)
  return out
}

/**
 * A zlib stream holding one dynamic-Huffman deflate block that inflates to
 * zeros at deflate's maximum ratio (2 bits per 258 bytes, about 1032:1), built
 * bit by bit so a 2 GB bomb costs milliseconds. `bytes` is its size; it
 * inflates to about `bytes` KB.
 */
function zlibBomb(bytes: number, { truncated = false } = {}): Uint8Array {
  const out = new Uint8Array(bytes)
  out.set([0x78, 0x9c]) // zlib header; the last 4 bytes stand in for the checksum
  let bit = 16
  const bits = (value: number, count: number) => {
    // header fields and extra bits: least significant bit first
    for (let i = 0; i < count; i++, bit++) if ((value >> i) & 1) out[bit >> 3] |= 1 << (bit & 7)
  }
  const code = (value: number, count: number) => {
    // Huffman codes: most significant bit first
    for (let i = count - 1; i >= 0; i--, bit++) if ((value >> i) & 1) out[bit >> 3] |= 1 << (bit & 7)
  }
  bits(1, 1) // final block
  bits(2, 2) // dynamic Huffman
  bits(29, 5) // 286 literal/length codes
  bits(0, 5) // 1 distance code
  bits(14, 4) // 18 code-length codes, in deflate's order 16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1:
  for (const length of [0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 2]) bits(length, 3)
  // Code-length codes: 18 (a run of zeros) = "0", 1 = "10", 2 = "11". The
  // lengths: literal 0 → 2, 255 zeros, end-of-block → 2, 28 zeros, length 258
  // → 1; then distance 1 → 1.
  code(0b11, 2)
  code(0, 1), bits(138 - 11, 7)
  code(0, 1), bits(117 - 11, 7)
  code(0b11, 2)
  code(0, 1), bits(28 - 11, 7)
  code(0b10, 2)
  code(0b10, 2)
  // Literal/length codes: 258 = "0", literal 0 = "10", end-of-block = "11";
  // distance 1 = "0". One literal zero, then (258, distance 1) pairs, which
  // are all-zero bits, then end-of-block.
  code(0b10, 2)
  bit += (bytes * 8 - 32 - 2 - bit) & ~1
  // `truncated` leaves the end-of-block off, so inflating fails at the end.
  if (!truncated) code(0b11, 2)
  return out
}

function flateStreamObject(payload: Uint8Array, dictExtra = ""): Uint8Array {
  return concat([
    strToU8(`4 0 obj\n<< /Length ${payload.length} /Filter /FlateDecode${dictExtra} >>\nstream\n`),
    payload,
    strToU8("\nendstream\nendobj\n"),
  ])
}

function timed<T>(run: () => T): { ms: number; value?: T; error?: unknown } {
  const start = performance.now()
  try {
    const value = run()
    return { ms: performance.now() - start, value }
  } catch (error) {
    return { ms: performance.now() - start, error }
  }
}

describe("extractTextFromPdf — work bounds on crafted files (AQU-2594)", () => {
  // Its memory is checked in parse-document-pdf-memory.test.ts.
  it("reads a file of many tiny compressed streams fast", () => {
    const tiny = concat([
      strToU8("<</Filter/FlateDecode>>stream\n"),
      zlibSync(strToU8("BT ET")),
      strToU8("\nendstream\n"),
    ])
    const run = timed(() => extractTextFromPdf(repeatToCap(tiny)))
    expect(run.error).toBeUndefined()
    expect(run.ms).toBeLessThan(FAST_MS)
  })

  it("reads a file of streams with no dictionary fast (no search back to the file's start)", () => {
    const pdf = repeatToCap(strToU8("stream\nx\nendstream\n"))
    const run = timed(() => extractTextFromPdf(pdf))
    expect(run.error).toBeUndefined()
    expect(run.ms).toBeLessThan(FAST_MS)
  })

  it("stops a decompression bomb at the per-stream cap instead of decoding all of it", () => {
    const pdf = concat([strToU8("%PDF-1.4\n"), flateStreamObject(zlibBomb(1_990_000)), strToU8("%%EOF")])
    expect(pdf.length).toBeLessThan(UPLOAD_BYTES)
    const run = timed(() => extractTextFromPdf(pdf))
    expect(run.error).toBeUndefined()
    expect(run.ms).toBeLessThan(FAST_MS)
  })

  it("stops reading a stream at the end of its compressed data, not at `endstream`", () => {
    // A short stream, then bytes before `endstream` that the inflater must not
    // keep accumulating. The routes cap uploads at 2 MB, but the extractor has
    // no cap of its own, and at 2 MB the quadratic copy is still quick; 8 MB
    // makes it plain.
    const text = zlibSync(strToU8("BT\n(Short stream) Tj\nET"))
    const tail = new Uint8Array(8 * 1024 * 1024).fill(0x41)
    const pdf = concat([strToU8("%PDF-1.4\n"), flateStreamObject(concat([text, tail])), strToU8("%%EOF")])
    const run = timed(() => extractTextFromPdf(pdf))
    expect(run.error).toBeUndefined()
    expect(run.value).toBe("Short stream")
    expect(run.ms).toBeLessThan(FAST_MS)
  })

  it("inflates each bomb to the 4 MB per-stream cap and counts it against the 20 MB total", () => {
    const after = flateStreamObject(zlibSync(strToU8("BT\n(After the bombs) Tj\nET")))
    const build = (bombs: number) =>
      concat([
        strToU8("%PDF-1.4\n"),
        ...Array.from({ length: bombs }, () => flateStreamObject(zlibBomb(5_000))),
        after,
        strToU8("%%EOF"),
      ])
    expect(extractTextFromPdf(build(4))).toBe("After the bombs")
    expect(extractTextFromPdf(build(5))).toBe("")
  })

  it("counts the work of streams that inflate a long way and then fail", () => {
    // Each fails at its end after inflating ~4 MB, and is short enough to be
    // inflated in one call.
    const pdf = repeatToCap(flateStreamObject(zlibBomb(4_070, { truncated: true })))
    const run = timed(() => extractTextFromPdf(pdf))
    expect(run.error).toBeUndefined()
    expect(run.ms).toBeLessThan(FAST_MS)
  })

  it("reads millions of tiny shown strings fast", () => {
    // Ordinary, well-compressed text operators, no bomb: five streams of
    // `(ab)'` fill the 20 MB inflation cap with ~4 million two-letter strings.
    const stream = flateStreamObject(zlibSync(strToU8(`BT ${"(ab)'".repeat(838_000)} ET`)))
    const pdf = concat([strToU8("%PDF-1.4\n"), stream, stream, stream, stream, stream, strToU8("%%EOF")])
    const run = timed(() => extractTextFromPdf(pdf))
    expect(run.error).toBeUndefined()
    expect(run.ms).toBeLessThan(FAST_MS)
    const blocks = (run.value ?? "").split("\n")
    expect(blocks).toHaveLength(5)
    for (const block of blocks) expect(block.length > 0 && block.replaceAll("ab", "") === "").toBe(true)
  })

  it("scans an unclosed run of `(` inside a text block in one pass", () => {
    const pdf = concat([repeatToCap(strToU8("("), "%PDF-1.4\nBT ("), strToU8("\nET")])
    const run = timed(() => extractTextFromPdf(pdf))
    expect(run.error).toBeUndefined()
    expect(run.ms).toBeLessThan(FAST_MS)
  })

  it("scans a run of `BT` with no `ET` in one pass", () => {
    const pdf = repeatToCap(strToU8("BT "))
    const run = timed(() => extractTextFromPdf(pdf))
    expect(run.error).toBeUndefined()
    expect(run.ms).toBeLessThan(FAST_MS)
  })

  it("scans a run of `[` with no TJ in one pass", () => {
    const pdf = concat([repeatToCap(strToU8("["), "%PDF-1.4\nBT ["), strToU8("\nET")])
    const run = timed(() => extractTextFromPdf(pdf))
    expect(run.error).toBeUndefined()
    expect(run.ms).toBeLessThan(FAST_MS)
  })

  it("scans a TJ array full of unclosed `(` in one pass", () => {
    const pdf = concat([repeatToCap(strToU8("("), "%PDF-1.4\nBT ["), strToU8("] TJ\nET")])
    const run = timed(() => extractTextFromPdf(pdf))
    expect(run.error).toBeUndefined()
    expect(run.ms).toBeLessThan(FAST_MS)
  })

  it("refuses a file that needs more work than the budget allows, as too complex", () => {
    // Streams whose dictionary search finds nothing in its whole window, then
    // five that each fill the 4 MB per-stream cap (the 20 MB total). Each
    // part alone is inside its own cap; together they are over the budget.
    const noDict = strToU8("stream\nx\nendstream endobj\n")
    const filler = Array.from({ length: 9_990 }, () => noDict)
    const bombs = Array.from({ length: 5 }, () => flateStreamObject(zlibBomb(5_000)))
    const pdf = concat([strToU8("%PDF-1.4\n"), ...filler, ...bombs, strToU8("%%EOF")])
    expect(pdf.length).toBeLessThan(UPLOAD_BYTES)

    const run = timed(() => extractTextFromPdf(pdf))
    expect(run.ms).toBeLessThan(FAST_MS)
    expect(run.error).toBeInstanceOf(DocumentExtractionError)
    // routes/knowledge.ts shows this message to the uploader verbatim.
    expect((run.error as Error).message).toMatch(/^the document is too complex to read: /)
  })

  it("examines at most 10,000 streams", () => {
    const text = flateStreamObject(zlibSync(strToU8("BT\n(Text after the filler) Tj\nET")))
    // An empty dictionary, and `endstream` followed by a space so only the
    // filler's own `stream` keyword counts.
    const filler = (count: number) =>
      Array.from({ length: count }, () => strToU8("<<>>stream\nx\nendstream endobj\n"))
    const build = (count: number) =>
      concat([strToU8("%PDF-1.4\n"), ...filler(count), text, strToU8("%%EOF")])

    expect(extractTextFromPdf(build(9_999))).toBe("Text after the filler")
    expect(extractTextFromPdf(build(10_000))).toBe("")
  })
})

// ── Ordinary PDFs read as before ─────────────────────────────────────────────

/**
 * A PDF laid out the way Word writes one: CRLF line ends, `<</Filter/
 * FlateDecode/Length n>>` dictionaries, marked-content runs, kerned TJ arrays
 * with escapes, a compressed font program and an image, three pages.
 */
function makeWordStylePdf(): Uint8Array {
  const pages = [
    [
      "[(Style guide f)-3(or the Ar)5(abic team)] TJ",
      "[(Rule 1: )-2(keep \\(proper\\) names as written)] TJ",
    ],
    [
      "[(Rule 2: wr)4(ite numbers as digits)] TJ",
      "(Rule 3: caf\\351 stays caf\\351) Tj",
    ],
    ["[(Rule 4: )-11(one space after a full stop)] TJ", "(Rule 5: the end) Tj"],
  ]
  const objects: Uint8Array[] = []
  const object = (n: number, dict: string, payload?: Uint8Array) =>
    objects.push(
      payload
        ? concat([
            strToU8(`${n} 0 obj\r\n<<${dict}/Length ${payload.length}>>\r\nstream\r\n`),
            payload,
            strToU8("\r\nendstream\r\nendobj\r\n"),
          ])
        : strToU8(`${n} 0 obj\r\n<<${dict}>>\r\nendobj\r\n`),
    )

  object(1, "/Type/Catalog/Pages 2 0 R/Lang(en-US)")
  object(2, `/Type/Pages/Count ${pages.length}/Kids[ 3 0 R 4 0 R 5 0 R]`)
  pages.forEach((_, i) =>
    object(
      3 + i,
      `/Type/Page/Parent 2 0 R/Resources<</Font<</F1 9 0 R>>/XObject<</Image12 12 0 R>>>>/MediaBox[ 0 0 612 792]/Contents ${6 + i} 0 R`,
    ),
  )
  pages.forEach((lines, i) => {
    const content = [
      "/P <</MCID 0>> BDC",
      "BT",
      "/F1 11.04 Tf",
      "1 0 0 1 72.024 709.54 Tm",
      "0 g",
      "0 G",
      ...lines.flatMap((line, l) => (l === 0 ? [line] : [`0 -13.4 TD`, line])),
      "ET",
      "EMC",
      "q 100 0 0 50 72 600 cm /Image12 Do Q",
    ].join("\r\n")
    object(6 + i, "/Filter/FlateDecode", zlibSync(strToU8(content)))
  })
  object(9, "/Type/Font/Subtype/TrueType/BaseFont/BCDEEE+Calibri/FirstChar 32/LastChar 126/FontDescriptor 10 0 R")
  object(10, "/Type/FontDescriptor/FontName/BCDEEE+Calibri/Flags 32/FontFile2 11 0 R")
  // Font programs and images are binary; a seeded byte pattern stands in.
  const binary = (length: number, seed: number) =>
    Uint8Array.from({ length }, (_, i) => (i * 131 + seed * 17 + ((i * i) >> 3)) & 0xff)
  object(11, "/Filter/FlateDecode/Length1 4000", zlibSync(binary(4000, 1)))
  object(12, "/Type/XObject/Subtype/Image/Width 100/Height 50/ColorSpace/DeviceRGB/BitsPerComponent 8/Filter/FlateDecode", zlibSync(binary(15000, 2)))

  return concat([strToU8("%PDF-1.7\r\n%\xb5\xb5\xb5\xb5\r\n"), ...objects, strToU8("trailer\r\n<</Size 13/Root 1 0 R>>\r\n%%EOF\r\n")])
}

/**
 * Every page of `makeWordStylePdf()`. Before AQU-2594 the extractor gave only
 * the first line here: its `stream` keyword search also matched inside each
 * `endstream`, and the stray match then carried the scan past the next real
 * stream, so it read only some of a PDF's content streams.
 */
const WORD_STYLE_TEXT =
  "Style guide for the Arabic teamRule 1: keep (proper) names as written\n" +
  "Rule 2: write numbers as digitsRule 3: caf\u00e9 stays caf\u00e9\n" +
  "Rule 4: one space after a full stopRule 5: the end"

/**
 * dev 9004eb77c's text-operator scan, verbatim: the oracle the one-pass
 * scanner is checked against.
 */
function regexTextScanBefore(haystack: string): string {
  const chunks: string[] = []
  const btEtRe = /BT\s([\s\S]*?)ET/g
  let blockMatch: RegExpExecArray | null
  while ((blockMatch = btEtRe.exec(haystack)) !== null) {
    const block = blockMatch[1]
    const opRe = /\(([^)\\]*(?:\\.[^)\\]*)*)\)\s*(?:Tj|'|")|(\[[\s\S]*?\])\s*TJ/g
    let opMatch: RegExpExecArray | null
    while ((opMatch = opRe.exec(block)) !== null) {
      if (opMatch[1] !== undefined) {
        chunks.push(decodePdfStringBefore(opMatch[1]))
      } else if (opMatch[2] !== undefined) {
        const strRe = /\(([^)\\]*(?:\\.[^)\\]*)*)\)/g
        let strMatch: RegExpExecArray | null
        while ((strMatch = strRe.exec(opMatch[2])) !== null) {
          chunks.push(decodePdfStringBefore(strMatch[1]))
        }
      }
    }
    chunks.push("\n")
  }
  return chunks.join("").replace(/\n{3,}/g, "\n\n").trim()
}

function decodePdfStringBefore(s: string): string {
  return s
    .replace(/\\(\d{1,3})/g, (_m, oct) => String.fromCharCode(parseInt(oct, 8)))
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\\\/g, "\\")
    .replace(/\\\(/g, "(")
    .replace(/\\\)/g, ")")
}

/** Small deterministic PRNG (mulberry32), so a failure names its seed. */
function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Every token the operator grammar keys on, plus the escapes and line ends
// that change how a string literal ends. No `stream` token, so only the text
// scan of the raw bytes is in play.
const FUZZ_TOKENS = [
  "BT ", "BT\n", "BT", "ET", " ET", "(", ")", "[", "]", "\\", "\\(", "\\)", "\\\\", "\\n", "\\101",
  "\\\n", "\\\r", "\n", "\r\n", " ", "\t", "\xa0", "Tj", " Tj", "TJ", " TJ", "'", '"', "T", "J",
  "j", "E", "B", "a", "Rule", "-120", "\xe9",
]

describe("extractTextFromPdf — ordinary PDFs read as before (AQU-2594)", () => {
  it("reads every page of a Word-style compressed PDF", () => {
    expect(extractTextFromPdf(makeWordStylePdf())).toBe(WORD_STYLE_TEXT)
  })

  it("reads every content stream, whatever its size (an `endstream` is not a `stream`)", () => {
    for (const lineCount of [1, 400]) {
      const page = (n: number) =>
        flateStreamObject(
          zlibSync(
            strToU8(
              Array.from({ length: lineCount }, (_, l) => `BT\n1 0 0 1 72 ${l} Tm\n(Page ${n}) Tj\nET`).join("\n"),
            ),
          ),
        )
      const pdf = concat([strToU8("%PDF-1.4\n"), page(1), page(2), page(3), page(4), strToU8("%%EOF")])
      const pagesRead = new Set(extractTextFromPdf(pdf).split("\n"))
      expect([...pagesRead]).toEqual(["Page 1", "Page 2", "Page 3", "Page 4"])
    }
  })

  it("finds exactly the text the old regex scan found, on 20,000 generated inputs", () => {
    for (let seed = 1; seed <= 20_000; seed++) {
      const random = prng(seed)
      const length = 1 + Math.floor(random() * 40)
      let raw = ""
      for (let i = 0; i < length; i++) raw += FUZZ_TOKENS[Math.floor(random() * FUZZ_TOKENS.length)]
      const bytes = Uint8Array.from(raw, (ch) => ch.charCodeAt(0))
      const before = regexTextScanBefore(new TextDecoder("latin1").decode(bytes))
      const now = extractTextFromPdf(bytes)
      if (now !== before) {
        expect({ seed, raw, now }).toEqual({ seed, raw, now: before })
      }
    }
  })
})
