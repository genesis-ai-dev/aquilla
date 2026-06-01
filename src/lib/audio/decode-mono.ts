// Decode compressed audio bytes (webm/opus/wav/mp3) to a mono Float32Array at a
// target sample rate via Web Audio. Decoding through a context created at
// TARGET_RATE makes decodeAudioData resample for us, so all clips come out at a
// common rate and concatenate cleanly. Browser-only — verified via E2E, not units.

export const TARGET_RATE = 48000

type AudioCtor = typeof AudioContext

function getAudioContextCtor(): AudioCtor {
  const w = globalThis as unknown as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor }
  const Ctor = w.AudioContext ?? w.webkitAudioContext
  if (!Ctor) throw new Error("Web Audio API is unavailable in this environment")
  return Ctor
}

export async function decodeToMono48k(bytes: Uint8Array): Promise<Float32Array> {
  const Ctor = getAudioContextCtor()
  const ctx = new Ctor({ sampleRate: TARGET_RATE })
  try {
    // decodeAudioData wants an ArrayBuffer; copy to detach from the Uint8Array view.
    const ab = bytes.slice().buffer
    const decoded = await ctx.decodeAudioData(ab)
    if (decoded.numberOfChannels === 1) return decoded.getChannelData(0).slice()
    // Downmix to mono by averaging channels.
    const len = decoded.length
    const mono = new Float32Array(len)
    for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
      const data = decoded.getChannelData(ch)
      for (let i = 0; i < len; i++) mono[i] += data[i] / decoded.numberOfChannels
    }
    return mono
  } finally {
    void ctx.close()
  }
}
