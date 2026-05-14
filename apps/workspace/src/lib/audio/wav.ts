/**
 * Encode mono Float32 PCM (range -1..1) as a 16-bit WAV blob. Tiny helper —
 * keeps the synthesis pipeline browser-only by avoiding a dedicated audio
 * encoder dependency.
 */
export function floatPcmToWavBlob(pcm: Float32Array, sampleRate: number): Blob {
  const bytes = new Uint8Array(pcm.length * 2)
  const view = new DataView(bytes.buffer)
  let offset = 0
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]))
    view.setInt16(offset, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true)
    offset += 2
  }
  return pcm16BytesToWavBlob(bytes, sampleRate)
}

/** Wrap raw mono signed 16-bit little-endian PCM bytes in a WAV container. */
export function pcm16BytesToWavBlob(pcmBytes: Uint8Array, sampleRate: number): Blob {
  const numChannels = 1
  const bytesPerSample = 2
  const blockAlign = numChannels * bytesPerSample
  const byteRate = sampleRate * blockAlign
  const dataSize = pcmBytes.byteLength

  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)
  const out = new Uint8Array(buffer)

  writeString(view, 0, "RIFF")
  view.setUint32(4, 36 + dataSize, true)
  writeString(view, 8, "WAVE")
  writeString(view, 12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bytesPerSample * 8, true)
  writeString(view, 36, "data")
  view.setUint32(40, dataSize, true)
  out.set(pcmBytes, 44)

  return new Blob([buffer], { type: "audio/wav" })
}

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i))
}
