// Encode mono PCM samples to a 16-bit WAV blob. No Web Audio needed —
// pure DataView writes — so it is unit-testable in happy-dom.
//
// Two entry points, one header writer: encodeWavPcm16 takes Float32 (offline
// paths — TTS fallback, reference extraction), encodeWavPcm16Chunks takes the
// Int16 buffers the capture worklet already produced (live takes). They must
// stay byte-identical for equivalent input; wav-encode.test.ts asserts it.

/** Bytes in the canonical RIFF/WAVE PCM header written below. recording-limits
 *  re-exports it — the size arithmetic has to add it back onto the samples. */
export const WAV_HEADER_BYTES = 44

/** A block of already-quantised samples, as the capture worklet transfers
 *  them. Pinned to a plain ArrayBuffer rather than ArrayBufferLike because a
 *  SharedArrayBuffer-backed view genuinely cannot go into a Blob. */
export type Pcm16Chunk = Int16Array<ArrayBuffer>

/**
 * Float32 sample → int16, clamped. The capture worklet duplicates this line
 * for line (it can import nothing); a divergence means a live WAV and an
 * offline WAV of the same audio quantise differently.
 */
export function quantisePcm16(value: number): number {
  // Guard non-finite values (NaN/±Infinity) → treat as silence before clamping.
  const s = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0
  return Math.round(s * (s < 0 ? 0x8000 : 0x7fff))
}

/** The 44-byte mono 16-bit header for a data chunk of `dataBytes`. */
export function wavHeaderPcm16(dataBytes: number, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES)
  const dv = new DataView(buffer)

  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(offset + i, s.charCodeAt(i))
  }

  writeStr(0, "RIFF")
  dv.setUint32(4, 36 + dataBytes, true)
  writeStr(8, "WAVE")
  writeStr(12, "fmt ")
  dv.setUint32(16, 16, true)          // PCM fmt chunk size
  dv.setUint16(20, 1, true)           // audio format = PCM
  dv.setUint16(22, 1, true)           // channels = mono
  dv.setUint32(24, sampleRate, true)
  dv.setUint32(28, sampleRate * 2, true) // byte rate (mono * 2 bytes)
  dv.setUint16(32, 2, true)           // block align
  dv.setUint16(34, 16, true)          // bits per sample
  writeStr(36, "data")
  dv.setUint32(40, dataBytes, true)
  return buffer
}

export function encodeWavPcm16(samples: Float32Array, sampleRate: number): Blob {
  const dataBytes = samples.length * 2
  const data = new ArrayBuffer(dataBytes)
  const dv = new DataView(data)

  let offset = 0
  for (let i = 0; i < samples.length; i++) {
    dv.setInt16(offset, quantisePcm16(samples[i]), true)
    offset += 2
  }
  return new Blob([wavHeaderPcm16(dataBytes, sampleRate), data], { type: "audio/wav" })
}

/**
 * Encode already-quantised Int16 chunks (as the capture worklet posts them).
 *
 * The chunks go straight into the Blob constructor rather than being copied
 * into one big typed array first, so peak JS heap over a long take is the
 * accumulated Int16 total and nothing more — the whole point of quantising on
 * the audio thread.
 *
 * Int16Array is native-endian where the header above is explicitly
 * little-endian. Every platform a browser runs on is little-endian, and the
 * byte-identity test locks the two paths together on the platform we ship, so
 * a big-endian host would fail loudly rather than produce reversed audio.
 */
export function encodeWavPcm16Chunks(chunks: Pcm16Chunk[], sampleRate: number): Blob {
  let dataBytes = 0
  for (const c of chunks) dataBytes += c.byteLength
  // Built by hand rather than `[header, ...chunks]`: a 15-minute take is over
  // 10,000 chunks and spreading that many arguments is close enough to the
  // engine's call-argument ceiling to be worth avoiding.
  const parts: BlobPart[] = [wavHeaderPcm16(dataBytes, sampleRate)]
  for (const c of chunks) parts.push(c)
  return new Blob(parts, { type: "audio/wav" })
}
