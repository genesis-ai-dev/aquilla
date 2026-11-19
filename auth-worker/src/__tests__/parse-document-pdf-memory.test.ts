// parse-document — memory the PDF text extractor allocates (AQU-2594)
//
// A Worker has 128 MB. Memory can't be read reliably inside this test process
// (PGlite alone holds hundreds of MB), so this counts every byte buffer the
// extraction allocates instead, fflate's included: a counting Uint8Array is
// installed before fflate or the route load, so both capture it. The total is
// an upper bound on the peak.
//
// Everything is imported dynamically, after the counter, for that reason.

import { describe, it, expect } from "vitest"

const Original = globalThis.Uint8Array
let counting = false
let allocated = 0
class CountingUint8Array extends Original {
  constructor(...args: unknown[]) {
    // @ts-expect-error -- forwarding whichever constructor overload was used
    super(...args)
    if (counting && typeof args[0] === "number") allocated += args[0]
  }
}
globalThis.Uint8Array = CountingUint8Array as unknown as Uint8ArrayConstructor

const { zlibSync, strToU8 } = await import("fflate")
const { extractTextFromPdf } = await import("../routes/parse-document")

function bytesAllocatedBy(run: () => void): number {
  allocated = 0
  counting = true
  try {
    run()
  } finally {
    counting = false
  }
  return allocated
}

describe("extractTextFromPdf — memory (AQU-2594)", () => {
  it("allocates a few MB, not a buffer per stream, for a file of many tiny streams", () => {
    const parts = [
      strToU8("<</Filter/FlateDecode>>stream\n"),
      zlibSync(strToU8("BT ET")),
      strToU8("\nendstream\n"),
    ]
    const unitLength = parts.reduce((n, p) => n + p.length, 0)
    const count = Math.floor(2_000_000 / unitLength)
    const pdf = new Uint8Array(count * unitLength)
    for (let i = 0, at = 0; i < count; i++) {
      for (const p of parts) {
        pdf.set(p, at)
        at += p.length
      }
    }

    const bytes = bytesAllocatedBy(() => extractTextFromPdf(pdf))
    // The one reused 4 MB output buffer, plus small change.
    expect(bytes).toBeLessThan(8 * 1024 * 1024)
  })

  it("still allocates a few MB for tiny streams once the 20 MB inflation budget is nearly spent", () => {
    // Five streams of ~4 MB minus a little leave a few hundred bytes of the
    // 20 MB budget, then 9,000 tiny streams follow.
    const text = (bytes: number) => `BT ${"x".repeat(bytes - 6)} ET`
    const nearlyFull = zlibSync(strToU8(text(4 * 1024 * 1024 - 100)))
    const tiny = zlibSync(strToU8("BT ET"))
    const object = (payload: Uint8Array) =>
      [strToU8(`<</Filter/FlateDecode/Length ${payload.length}>>stream\n`), payload, strToU8("\nendstream endobj\n")]
    const build = (tinyCount: number) => {
      const parts = [
        strToU8("%PDF-1.4\n"),
        ...Array.from({ length: 5 }, () => object(nearlyFull)).flat(),
        ...Array.from({ length: tinyCount }, () => object(tiny)).flat(),
      ]
      const pdf = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
      parts.reduce((at, p) => (pdf.set(p, at), at + p.length), 0)
      return pdf
    }
    const withoutTiny = build(0)
    const withTiny = build(9_000)

    // The five large streams are stepped and allocate as they go; what the
    // 9,000 tiny ones add on top is what this is about.
    const added =
      bytesAllocatedBy(() => extractTextFromPdf(withTiny)) -
      bytesAllocatedBy(() => extractTextFromPdf(withoutTiny))
    expect(added).toBeLessThan(4 * 1024 * 1024)
  })
})

// A global regex replace holds every match of the whole subject at once: a
// 4 MB string of a million escapes took ~160 MB of heap in one call, from a
// 4 KB upload. This records the longest subject any global regex replace was
// given during a run.
function longestGlobalReplaceDuring(run: () => void): number {
  const original = RegExp.prototype[Symbol.replace]
  let longest = 0
  RegExp.prototype[Symbol.replace] = function (this: RegExp, subject: string, replacement: unknown) {
    if (this.global) longest = Math.max(longest, String(subject).length)
    // @ts-expect-error -- forwarding either replacement overload
    return original.call(this, subject, replacement)
  }
  try {
    run()
  } finally {
    RegExp.prototype[Symbol.replace] = original
  }
  return longest
}

function onePagePdf(content: string): Uint8Array {
  const parts = [
    strToU8("%PDF-1.4\n<</Filter/FlateDecode>>stream\n"),
    zlibSync(strToU8(content)),
    strToU8("\nendstream\n%%EOF"),
  ]
  const pdf = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  parts.reduce((at, p) => (pdf.set(p, at), at + p.length), 0)
  return pdf
}

describe("extractTextFromPdf — string memory (AQU-2594)", () => {
  it("decodes a 4 MB string of escapes without a regex replace over all of it", () => {
    const count = 1_000_000
    const pdf = onePagePdf(`BT (${"\\101".repeat(count)}) Tj ET`)
    let text = ""
    const longest = longestGlobalReplaceDuring(() => (text = extractTextFromPdf(pdf)))
    expect(text).toBe("A".repeat(count))
    expect(longest).toBeLessThanOrEqual(64 * 1024)
  })

  it("collapses a million blank-line runs without a regex replace over all the text", () => {
    const count = 300_000
    const pdf = onePagePdf(`BT ${"(a\\n\\n\\n)'".repeat(count)} ET`)
    let text = ""
    const longest = longestGlobalReplaceDuring(() => (text = extractTextFromPdf(pdf)))
    expect(text).toBe(Array.from({ length: count }, () => "a").join("\n\n"))
    expect(longest).toBeLessThanOrEqual(64 * 1024)
  })
})
