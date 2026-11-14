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
})
