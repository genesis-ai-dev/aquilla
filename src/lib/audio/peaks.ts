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

// 2026-09-25 (AQU-1217): decode OFFLINE wherever the browser can. A realtime
// AudioContext — what this used to open and close on every call — is the
// operation that makes the browser reconfigure the shared audio device (see
// output-context.ts); on a headset that reaches the microphone and has eaten
// the head of a take. With the recorder now drawing the selected take's
// waveform while the mic is held, that stopped being a theoretical debt. An
// OfflineAudioContext never touches a device and doesn't count against the
// page's ~6-context cap. It resamples to its own rate, which is irrelevant to
// max-abs peaks. The realtime path stays only as the fallback.
const OfflineCtxCtor =
  typeof window !== "undefined"
    ? ((window as unknown as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext ?? null)
    : null
const OFFLINE_DECODE_RATE = 48_000

// Decoding is CPU and memory heavy; a list that mounts a dozen cards at once
// (the Audio view) must not decode a dozen clips at once. App-wide, two at a
// time — the same figure peaks-loader already used per batch.
const MAX_CONCURRENT_DECODES = 2
let activeDecodes = 0
const waiting: Array<() => void> = []
async function withDecodeSlot<T>(run: () => Promise<T>): Promise<T> {
  if (activeDecodes >= MAX_CONCURRENT_DECODES) {
    await new Promise<void>((resolve) => waiting.push(resolve))
  }
  activeDecodes++
  try {
    return await run()
  } finally {
    activeDecodes--
    waiting.shift()?.()
  }
}

export async function decodePeaks(
  bytes: Uint8Array,
  targetBins: number,
): Promise<DecodedPeaks> {
  if (!OfflineCtxCtor && !AudioCtxCtor) throw new Error("Web Audio API unavailable")
  if (targetBins <= 0) throw new Error("targetBins must be positive")

  // decodeAudioData transfers/consumes its ArrayBuffer in some implementations,
  // so hand it a fresh copy that nobody else holds.
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)

  const buffer = await withDecodeSlot(() => decodeBuffer(copy.buffer as ArrayBuffer))
  const peaks = reduceToPeaks(buffer, targetBins)
  return { peaks, duration: buffer.duration, sampleRate: buffer.sampleRate }
}

/** Decode without opening an audio device when the browser allows it. */
export async function decodeBuffer(data: ArrayBuffer): Promise<AudioBuffer> {
  if (OfflineCtxCtor) {
    const offline = new OfflineCtxCtor(1, 1, OFFLINE_DECODE_RATE)
    return offline.decodeAudioData(data)
  }
  const ctx = new AudioCtxCtor!()
  try {
    return await ctx.decodeAudioData(data)
  } finally {
    void ctx.close()
  }
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
