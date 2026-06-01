// Encode mono PCM Float32 samples to a 16-bit WAV blob. No Web Audio needed —
// pure DataView writes — so it is unit-testable in happy-dom.

export function encodeWavPcm16(samples: Float32Array, sampleRate: number): Blob {
  const dataBytes = samples.length * 2
  const buffer = new ArrayBuffer(44 + dataBytes)
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

  let offset = 44
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    dv.setInt16(offset, Math.round(clamped * (clamped < 0 ? 0x8000 : 0x7fff)), true)
    offset += 2
  }
  return new Blob([buffer], { type: "audio/wav" })
}
