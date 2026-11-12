// The packer is the last place a big export can die: everything a run produced
// passes through it at once. These lock the two properties that matter —
// identical archives whatever shape the entry data arrives in, and compressed
// output that leaves the heap as it is produced (AQU-1862).

import { describe, expect, it } from "vitest"
import JSZip from "jszip"
import { packZip, unpackZip, ZIP_FLUSH_BYTES } from "./zip-core"

const text = async (blob: Blob, path: string): Promise<string> =>
  (await JSZip.loadAsync(await blob.arrayBuffer())).file(path)!.async("string")

describe("packZip", () => {
  it("packs strings, typed arrays and blobs into the same archive content", async () => {
    const raw = await packZip([
      { path: "a/one.txt", data: "héllo" },
      { path: "a/two.bin", data: new Uint8Array([1, 2, 3, 255]) },
    ])
    const blobbed = await packZip([
      { path: "a/one.txt", data: new Blob(["héllo"]) },
      { path: "a/two.bin", data: new Blob([new Uint8Array([1, 2, 3, 255])]) },
    ])
    const fromRaw = await unpackZip(await raw.arrayBuffer())
    const fromBlobbed = await unpackZip(await blobbed.arrayBuffer())

    expect(fromBlobbed.map((e) => e.path)).toEqual(fromRaw.map((e) => e.path))
    for (let i = 0; i < fromRaw.length; i++) {
      const a = new Uint8Array(await (fromRaw[i].data as Blob).arrayBuffer())
      const b = new Uint8Array(await (fromBlobbed[i].data as Blob).arrayBuffer())
      expect(b).toEqual(a)
    }
    expect(await text(blobbed, "a/one.txt")).toBe("héllo")
    expect(blobbed.type).toBe("application/zip")
  })

  it("survives output larger than one flush window", async () => {
    // The flush threshold counts compressed bytes, so the input must not
    // compress: a repeating pattern deflates to a few KB and never flushes
    // mid-stream. xorshift noise keeps the output past ZIP_FLUSH_BYTES, so the
    // streamed path hands at least two parts to blob storage.
    const bytes = new Uint8Array(ZIP_FLUSH_BYTES + 1024)
    let seed = 0x9e3779b9
    for (let i = 0; i < bytes.length; i++) {
      seed ^= seed << 13
      seed ^= seed >>> 17
      seed ^= seed << 5
      bytes[i] = seed & 0xff
    }
    const blob = await packZip([{ path: "big.bin", data: new Blob([bytes]) }])
    expect(blob.size).toBeGreaterThan(ZIP_FLUSH_BYTES)

    const [entry] = await unpackZip(await blob.arrayBuffer())
    expect(entry.path).toBe("big.bin")
    // toEqual walks 8 MB one element at a time and took 40-60 s on CI against
    // the 60 s test timeout (AQU-1970). Compare the bytes directly instead.
    const out = new Uint8Array(await (entry.data as Blob).arrayBuffer())
    expect(out.byteLength).toBe(bytes.byteLength)
    expect(Buffer.compare(out, bytes)).toBe(0)
  })
})

describe("unpackZip", () => {
  it("returns entries as blobs, directories dropped", async () => {
    const zip = new JSZip()
    zip.folder("nested")!.file("in.txt", "inside")
    const packed = await zip.generateAsync({ type: "blob" })

    const entries = await unpackZip(await packed.arrayBuffer())
    expect(entries.map((e) => e.path)).toEqual(["nested/in.txt"])
    expect(entries[0].data).toBeInstanceOf(Blob)
    expect(await (entries[0].data as Blob).text()).toBe("inside")
  })
})
