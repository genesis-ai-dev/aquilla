// Server-side windowing of canonical WAV for Agent API transcription (spec §7).
//
// In the app the browser cuts audio into windows before upload; an agent has no
// such client, so the tool does it here. Only the SPA's canonical WAV (16 kHz,
// mono, PCM16, 44-byte header — what auth-worker's transcription route
// accepts) is cut: compressed takes cannot be decoded in a Worker.

export const SAMPLE_RATE = 16000
const HEADER_BYTES = 44
/** A cut moves back at most this far from the window edge to find quiet. */
const SEARCH_BACK_SECONDS = 2
/** Energy is compared over 20 ms frames. */
const FRAME_SAMPLES = 320

export interface WavWindow {
  /** Seconds from the start of the whole clip. */
  offsetSeconds: number
  /** A complete canonical WAV for this window, base64. */
  base64: string
}

/** Samples of a canonical WAV, or null when the bytes are anything else. */
export function canonicalWavSamples(bytes: Uint8Array): Int16Array | null {
  if (bytes.length <= HEADER_BYTES) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (start: number) => String.fromCharCode(...bytes.subarray(start, start + 4))
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE" || tag(12) !== "fmt " || tag(36) !== "data") return null
  if (view.getUint32(16, true) !== 16 || view.getUint16(20, true) !== 1 || view.getUint16(22, true) !== 1
    || view.getUint32(24, true) !== SAMPLE_RATE || view.getUint16(34, true) !== 16) return null
  const dataBytes = view.getUint32(40, true)
  if (dataBytes !== bytes.length - HEADER_BYTES || dataBytes % 2 !== 0) return null
  const samples = new Int16Array(dataBytes / 2)
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(HEADER_BYTES + i * 2, true)
  return samples
}

export function encodeCanonicalWav(samples: Int16Array): Uint8Array {
  const bytes = new Uint8Array(HEADER_BYTES + samples.length * 2)
  const view = new DataView(bytes.buffer)
  const write = (offset: number, text: string) => { for (let i = 0; i < 4; i++) bytes[offset + i] = text.charCodeAt(i) }
  write(0, "RIFF"); view.setUint32(4, bytes.length - 8, true); write(8, "WAVE")
  write(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, SAMPLE_RATE, true); view.setUint32(28, SAMPLE_RATE * 2, true)
  view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  write(36, "data"); view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) view.setInt16(HEADER_BYTES + i * 2, samples[i], true)
  return bytes
}

export function toBase64(bytes: Uint8Array): string {
  let binary = ""
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

function frameEnergy(samples: Int16Array, start: number): number {
  let energy = 0
  for (let i = start; i < start + FRAME_SAMPLES; i++) energy += samples[i] * samples[i]
  return energy
}

/** Where to cut in [from, to]: the start of a frame strictly quieter than the
 *  one ending at `to`, else `to` itself — so steady sound keeps full windows. */
function quietestCut(samples: Int16Array, from: number, to: number): number {
  if (to - FRAME_SAMPLES < 0) return to
  let best = to
  let bestEnergy = frameEnergy(samples, to - FRAME_SAMPLES)
  for (let start = Math.max(0, from); start + FRAME_SAMPLES <= to; start += FRAME_SAMPLES) {
    const energy = frameEnergy(samples, start)
    if (energy < bestEnergy) { bestEnergy = energy; best = start }
  }
  return best
}

/** Cut into windows of at most `maxSeconds`, each boundary moved back to the
 *  quietest frame within 2 s so a word is not split mid-sound. */
export function windowCanonicalWav(samples: Int16Array, maxSeconds: number): WavWindow[] {
  const max = Math.floor(maxSeconds * SAMPLE_RATE)
  const windows: WavWindow[] = []
  let start = 0
  while (start < samples.length) {
    let end = Math.min(start + max, samples.length)
    if (end < samples.length) {
      const cut = quietestCut(samples, end - SEARCH_BACK_SECONDS * SAMPLE_RATE, end)
      if (cut > start) end = cut
    }
    windows.push({ offsetSeconds: start / SAMPLE_RATE, base64: toBase64(encodeCanonicalWav(samples.subarray(start, end))) })
    start = end
  }
  return windows
}
