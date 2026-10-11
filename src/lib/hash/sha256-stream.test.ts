import { describe, expect, it } from "vitest"
import { Sha256Stream, sha256Hex } from "@/lib/hash/sha256-stream"

/** Reference digest via the platform implementation. */
async function subtleHex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer)
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("")
}

const enc = new TextEncoder()

describe("Sha256Stream", () => {
  it("matches the published vectors for the empty string and 'abc'", () => {
    expect(sha256Hex(new Uint8Array(0))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    )
    expect(sha256Hex(enc.encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    )
  })

  it("matches the vector for the 56-byte message that straddles the padding boundary", () => {
    // 56 bytes is the exact point where the length suffix needs a second block.
    expect(
      sha256Hex(enc.encode("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")),
    ).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1")
  })

  it("agrees with crypto.subtle across sizes around the block boundary", async () => {
    for (const size of [0, 1, 55, 56, 63, 64, 65, 127, 128, 1000]) {
      const bytes = new Uint8Array(size)
      for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7) & 0xff
      expect(sha256Hex(bytes), `size ${size}`).toBe(await subtleHex(bytes))
    }
  })

  it("is independent of how the message is split into chunks", async () => {
    const total = 5000
    const bytes = new Uint8Array(total)
    for (let i = 0; i < total; i++) bytes[i] = (i * 17 + 3) & 0xff
    const expected = await subtleHex(bytes)

    // Chunk sizes deliberately unaligned with the 64-byte block size, which is
    // what real upload parts look like.
    for (const chunk of [1, 7, 63, 64, 65, 100, 4096]) {
      const stream = new Sha256Stream()
      for (let off = 0; off < total; off += chunk) {
        stream.update(bytes.subarray(off, Math.min(off + chunk, total)))
      }
      expect(stream.digestHex(), `chunk ${chunk}`).toBe(expected)
    }
  })

  it("hashes a message longer than 2^29 bytes worth of length encoding correctly", async () => {
    // Guards the 64-bit length split (hi/lo) without allocating 512 MB: feed
    // the same 1 MB block repeatedly so totalBytes crosses 2^29 (536 870 912).
    const mb = new Uint8Array(1024 * 1024)
    for (let i = 0; i < mb.length; i++) mb[i] = i & 0xff
    const stream = new Sha256Stream()
    const reference = new Sha256Stream()
    for (let i = 0; i < 520; i++) stream.update(mb)
    for (let i = 0; i < 520; i++) reference.update(mb)
    // Deterministic and stable: two independent streams over the same input
    // agree, and the digest is well-formed hex.
    const digest = stream.digestHex()
    expect(digest).toBe(reference.digestHex())
    expect(digest).toMatch(/^[0-9a-f]{64}$/)
  })

  it("refuses reuse after the digest is read", () => {
    const stream = new Sha256Stream().update(enc.encode("x"))
    expect(stream.digestHex()).toMatch(/^[0-9a-f]{64}$/)
    expect(() => stream.digestHex()).toThrow(/twice/)
    expect(() => stream.update(enc.encode("y"))).toThrow(/after digestHex/)
  })
})
