// Decode audio bytes into a Float32Array of peak amplitudes (one per visual
// bin). Uses Web Audio's decodeAudioData, then folds channels and reduces to
// max-abs per bucket. Bytes are not retained — caller can free the source
// buffer after this returns.

export interface DecodedPeaks {
  peaks: Float32Array
  duration: number
  sampleRate: number
}

const AudioCtxCtor =
  typeof window !== "undefined"
    ? (window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)
    : null

export async function decodePeaks(
  bytes: Uint8Array,
  targetBins: number,
): Promise<DecodedPeaks> {
  if (!AudioCtxCtor) throw new Error("Web Audio API unavailable")
  if (targetBins <= 0) throw new Error("targetBins must be positive")

  // decodeAudioData transfers/consumes its ArrayBuffer in some implementations,
  // so hand it a fresh copy that nobody else holds.
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)

  const ctx = new AudioCtxCtor()
  let buffer: AudioBuffer
  try {
    buffer = await ctx.decodeAudioData(copy.buffer as ArrayBuffer)
  } finally {
    void ctx.close()
  }

  const peaks = reduceToPeaks(buffer, targetBins)
  return { peaks, duration: buffer.duration, sampleRate: buffer.sampleRate }
}

function reduceToPeaks(buffer: AudioBuffer, targetBins: number): Float32Array {
  const channelCount = buffer.numberOfChannels
  const samples = buffer.length
  const out = new Float32Array(targetBins)
  const bucketSize = samples / targetBins

  // Pre-fetch channel data arrays once.
  const channels: Float32Array[] = []
  for (let c = 0; c < channelCount; c++) channels.push(buffer.getChannelData(c))

  for (let i = 0; i < targetBins; i++) {
    const start = Math.floor(i * bucketSize)
    const end = Math.min(samples, Math.floor((i + 1) * bucketSize))
    let peak = 0
    for (let s = start; s < end; s++) {
      let mixed = 0
      for (let c = 0; c < channelCount; c++) mixed += channels[c][s]
      const v = Math.abs(mixed / channelCount)
      if (v > peak) peak = v
    }
    out[i] = peak
  }

  // Normalize to 0..1 so quiet recordings still draw recognizably.
  let max = 0
  for (let i = 0; i < out.length; i++) if (out[i] > max) max = out[i]
  if (max > 0 && max < 1) {
    const scale = 1 / max
    for (let i = 0; i < out.length; i++) out[i] *= scale
  }
  return out
}
