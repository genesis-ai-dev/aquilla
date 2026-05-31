import { describe, it, expect } from "vitest"
import { makeZip } from "../lib/zip"

describe("makeZip (store-only)", () => {
  it("produces a valid zip containing the entries", () => {
    const enc = new TextEncoder()
    const out = makeZip([
      { name: "GEN.SFM", data: enc.encode("\\id GEN\n\\v 1 In the beginning\n") },
      { name: "EXO.SFM", data: enc.encode("\\id EXO\n") },
    ])

    // Local file header signature: PK\x03\x04
    expect(Array.from(out.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04])

    // End-of-central-directory signature: PK\x05\x06 (last 22 bytes)
    expect(Array.from(out.slice(out.length - 22, out.length - 18))).toEqual([0x50, 0x4b, 0x05, 0x06])

    // EOCD records two entries.
    const dv = new DataView(out.buffer, out.length - 22, 22)
    expect(dv.getUint16(8, true)).toBe(2)

    // STORE keeps file names + bytes verbatim in the stream.
    const txt = new TextDecoder().decode(out)
    expect(txt).toContain("GEN.SFM")
    expect(txt).toContain("\\v 1 In the beginning")
    expect(txt).toContain("EXO.SFM")
  })

  it("handles an empty archive", () => {
    const out = makeZip([])
    expect(Array.from(out.slice(0, 4))).toEqual([0x50, 0x4b, 0x05, 0x06]) // just the EOCD
    expect(out.length).toBe(22)
  })
})
