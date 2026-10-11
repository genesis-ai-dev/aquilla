// Incremental SHA-256 over a stream of chunks (AQU-1853).
//
// `crypto.subtle.digest` needs the whole message in one ArrayBuffer, so hashing
// a 500 MB upload with it means holding 500 MB in the tab — exactly the memory
// blow-up direct-to-R2 multipart upload exists to avoid. This hashes chunk by
// chunk instead, so the uploader never holds more than one part.
//
// The digest is a plain SHA-256 of the whole object, byte-identical to what
// `crypto.subtle.digest("SHA-256", wholeFile)` returns — so an artifact row
// written by the multipart path carries the same `sha256` the single-shot PUT
// path would have computed server-side, and artifact identity checks keep
// comparing like with like. `sha256-stream.test.ts` pins that equivalence.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

const rotr = (x: number, n: number): number => ((x >>> n) | (x << (32 - n))) >>> 0

/** One-shot SHA-256 of a byte array, as lowercase hex. */
export function sha256Hex(bytes: Uint8Array): string {
  return new Sha256Stream().update(bytes).digestHex()
}

/**
 * Streaming SHA-256. Feed chunks with `update()` in order, then read the
 * lowercase-hex digest once with `digestHex()`. Chunks may be any size —
 * the 64-byte block boundary is handled internally, so part boundaries do
 * not have to align with anything.
 */
export class Sha256Stream {
  private readonly h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])
  /** Partial 64-byte block carried between `update()` calls. */
  private readonly tail = new Uint8Array(64)
  private tailLen = 0
  /** Total message length in bytes — goes into the SHA-256 length suffix. */
  private totalBytes = 0
  private readonly w = new Uint32Array(64)
  private finished = false

  update(chunk: Uint8Array): this {
    if (this.finished) throw new Error("Sha256Stream: update() after digestHex()")
    this.totalBytes += chunk.length
    let off = 0
    // Top up a carried partial block first.
    if (this.tailLen > 0) {
      const take = Math.min(64 - this.tailLen, chunk.length)
      this.tail.set(chunk.subarray(0, take), this.tailLen)
      this.tailLen += take
      off = take
      if (this.tailLen === 64) {
        this.block(this.tail, 0)
        this.tailLen = 0
      }
    }
    // Consume whole blocks straight out of the caller's buffer (no copy).
    while (off + 64 <= chunk.length) {
      this.block(chunk, off)
      off += 64
    }
    // Carry the remainder.
    if (off < chunk.length) {
      this.tail.set(chunk.subarray(off), 0)
      this.tailLen = chunk.length - off
    }
    return this
  }

  /** Finish the hash and return it as 64 lowercase hex characters. */
  digestHex(): string {
    if (this.finished) throw new Error("Sha256Stream: digestHex() called twice")
    this.finished = true
    // Pad: 0x80, zeros up to 56 mod 64, then the 64-bit big-endian bit length.
    const padLen = this.tailLen < 56 ? 56 - this.tailLen : 120 - this.tailLen
    const pad = new Uint8Array(padLen + 8)
    pad[0] = 0x80
    // bitLen = totalBytes * 8 as a 64-bit value. totalBytes can exceed 2^29,
    // so split it rather than computing totalBytes * 8 in one 32-bit op.
    const hi = Math.floor(this.totalBytes / 0x20000000)
    const lo = ((this.totalBytes % 0x20000000) * 8) >>> 0
    const lenOff = padLen
    pad[lenOff] = (hi >>> 24) & 0xff
    pad[lenOff + 1] = (hi >>> 16) & 0xff
    pad[lenOff + 2] = (hi >>> 8) & 0xff
    pad[lenOff + 3] = hi & 0xff
    pad[lenOff + 4] = (lo >>> 24) & 0xff
    pad[lenOff + 5] = (lo >>> 16) & 0xff
    pad[lenOff + 6] = (lo >>> 8) & 0xff
    pad[lenOff + 7] = lo & 0xff
    // Replay the carried tail plus the padding as whole blocks.
    const finalBlocks = new Uint8Array(this.tailLen + pad.length)
    finalBlocks.set(this.tail.subarray(0, this.tailLen), 0)
    finalBlocks.set(pad, this.tailLen)
    for (let off = 0; off + 64 <= finalBlocks.length; off += 64) {
      this.block(finalBlocks, off)
    }
    let out = ""
    for (let i = 0; i < 8; i++) out += this.h[i].toString(16).padStart(8, "0")
    return out
  }

  private block(p: Uint8Array, off: number): void {
    const w = this.w
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4
      w[i] = ((p[j] << 24) | (p[j + 1] << 16) | (p[j + 2] << 8) | p[j + 3]) >>> 0
    }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15]
      const y = w[i - 2]
      const s0 = (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) >>> 0
      const s1 = (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)) >>> 0
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }
    let a = this.h[0], b = this.h[1], c = this.h[2], d = this.h[3]
    let e = this.h[4], f = this.h[5], g = this.h[6], h = this.h[7]
    for (let i = 0; i < 64; i++) {
      const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0
      const ch = ((e & f) ^ (~e & g)) >>> 0
      const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0
      const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0
      const t2 = (S0 + maj) >>> 0
      h = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    this.h[0] = (this.h[0] + a) >>> 0
    this.h[1] = (this.h[1] + b) >>> 0
    this.h[2] = (this.h[2] + c) >>> 0
    this.h[3] = (this.h[3] + d) >>> 0
    this.h[4] = (this.h[4] + e) >>> 0
    this.h[5] = (this.h[5] + f) >>> 0
    this.h[6] = (this.h[6] + g) >>> 0
    this.h[7] = (this.h[7] + h) >>> 0
  }
}
