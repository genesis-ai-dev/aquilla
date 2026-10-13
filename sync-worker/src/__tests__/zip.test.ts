import { describe, it, expect } from "vitest"
import { makeZip, makeZipStream } from "../lib/zip"
import { readZip } from "./helpers/read-zip"

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

describe("makeZipStream (AQU-1863)", () => {
  async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
    const chunks: Uint8Array[] = []
    const reader = stream.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }
    const total = chunks.reduce((s, c) => s + c.length, 0)
    const out = new Uint8Array(total)
    let p = 0
    for (const c of chunks) {
      out.set(c, p)
      p += c.length
    }
    return out
  }

  function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(c)
        controller.close()
      },
    })
  }

  it("produces an archive that opens, with every entry's bytes and CRC intact", async () => {
    const enc = new TextEncoder()
    const gen = enc.encode("\\id GEN\n\\v 1 In the beginning\n")
    const exo = enc.encode("\\id EXO\n")
    const out = await drain(
      makeZipStream([
        { name: "GEN.SFM", open: async () => gen },
        { name: "EXO.SFM", open: async () => streamOf(exo.slice(0, 4), exo.slice(4)) },
      ]),
    )

    expect(Array.from(out.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04])
    const read = readZip(out)
    expect(read.map((e) => e.name)).toEqual(["GEN.SFM", "EXO.SFM"])
    expect(read[0].data).toEqual(gen)
    expect(read[1].data).toEqual(exo)
  })

  it("matches makeZip entry-for-entry so the streamed archive is not a new format", async () => {
    const enc = new TextEncoder()
    const entries = [
      { name: "a.txt", data: enc.encode("alpha") },
      { name: "b.txt", data: enc.encode("beta") },
    ]
    const buffered = readZip(makeZip(entries))
    const streamed = readZip(
      await drain(makeZipStream(entries.map((e) => ({ name: e.name, open: async () => e.data })))),
    )
    expect(streamed.map((e) => [e.name, e.crc])).toEqual(buffered.map((e) => [e.name, e.crc]))
    expect(streamed.map((e) => e.data)).toEqual(buffered.map((e) => e.data))
  })

  it("pulls each entry's bytes only as the consumer reads, never all at once", async () => {
    const enc = new TextEncoder()
    const opened: string[] = []
    const stream = makeZipStream(
      ["a", "b", "c"].map((n) => ({
        name: `${n}.txt`,
        open: async () => {
          opened.push(n)
          return enc.encode(n.repeat(64))
        },
      })),
    )
    // Creating the stream must not touch any source.
    expect(opened).toEqual([])

    const reader = stream.getReader()
    await reader.read() // first local header — only entry "a" is open
    expect(opened).toEqual(["a"])
    reader.releaseLock()
    await stream.cancel()
  })

  it("skips an entry whose source disappeared, keeping the rest readable", async () => {
    const enc = new TextEncoder()
    const out = await drain(
      makeZipStream([
        { name: "gone.docx", open: async () => null },
        { name: "kept.usfm", open: async () => enc.encode("\\id GEN\n") },
      ]),
    )
    const read = readZip(out)
    expect(read.map((e) => e.name)).toEqual(["kept.usfm"])
    expect(new TextDecoder().decode(read[0].data)).toBe("\\id GEN\n")
  })

  it("handles an empty archive", async () => {
    const out = await drain(makeZipStream([]))
    expect(Array.from(out.slice(0, 4))).toEqual([0x50, 0x4b, 0x05, 0x06])
    expect(out.length).toBe(22)
    expect(readZip(out)).toEqual([])
  })
})
