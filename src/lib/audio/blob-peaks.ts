// A just-recorded take, readied for the recorder's preview. (AQU-1210)
//
// After Stop the take is a Blob, not an attachment yet, so none of the
// attachment machinery (peaks cache, streaming, useCellAudio) applies. The
// preview needs two things from it: the waveform — drawn exactly as it will be
// once saved — and something that can play a window of it reliably.
//
// NO LIVE AUDIOCONTEXT. The recorder holds the microphone the whole time it is
// open, and opening a realtime context there is the device reconfiguration
// that has eaten the head of a take (output-context.ts). So:
//
//   - A WAV take — the normal path — is a 44-byte header and mono 16-bit
//     samples. Its peaks come straight from the samples; nothing is decoded.
//   - A compressed (webm) take is decoded OFFLINE (no device), and re-encoded
//     to WAV for playback: a MediaRecorder webm reports an infinite duration
//     until indexed, and seeking one fires `ended` at once, so a window of it
//     cannot be played reliably from the original bytes.

import { decodeBuffer, reduceChannelsToPeaks } from "./peaks"
import { encodeWavPcm16 } from "./wav-encode"

export interface PreparedTake {
  peaks: Float32Array
  durationSec: number
  /** A blob an <audio> element can seek within: the take itself when it is
   *  already WAV, else a WAV re-encoding of it. */
  playable: Blob
}

/** Mono float samples from a PCM 16-bit WAV, or null when it isn't one. */
export function wavSamples(bytes: ArrayBuffer): { samples: Float32Array; sampleRate: number } | null {
  if (bytes.byteLength < 12) return null
  const dv = new DataView(bytes)
  const tag = (o: number) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3))
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null
  let channels = 0
  let sampleRate = 0
  let bits = 0
  let format = 0
  let offset = 12
  while (offset + 8 <= bytes.byteLength) {
    const id = tag(offset)
    const size = dv.getUint32(offset + 4, true)
    const body = offset + 8
    if (id === "fmt " && size >= 16) {
      format = dv.getUint16(body, true)
      channels = dv.getUint16(body + 2, true)
      sampleRate = dv.getUint32(body + 4, true)
      bits = dv.getUint16(body + 14, true)
    } else if (id === "data") {
      if (format !== 1 || bits !== 16 || channels < 1 || sampleRate <= 0) return null
      const available = Math.min(size, bytes.byteLength - body)
      const frames = Math.floor(available / (2 * channels))
      const samples = new Float32Array(frames)
      for (let f = 0; f < frames; f++) {
        let sum = 0
        for (let c = 0; c < channels; c++) sum += dv.getInt16(body + (f * channels + c) * 2, true)
        samples[f] = sum / channels / 0x8000
      }
      return { samples, sampleRate }
    }
    offset = body + size + (size % 2)
  }
  return null
}

export async function prepareTakeBlob(blob: Blob, bins: number): Promise<PreparedTake> {
  const bytes = await blob.arrayBuffer()
  const wav = wavSamples(bytes)
  if (wav) {
    return {
      peaks: reduceChannelsToPeaks([wav.samples], bins),
      durationSec: wav.samples.length / wav.sampleRate,
      playable: blob,
    }
  }
  const buffer = await decodeBuffer(bytes.slice(0))
  const channels: Float32Array[] = []
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c))
  const mono = new Float32Array(buffer.length)
  for (let i = 0; i < buffer.length; i++) {
    let sum = 0
    for (const ch of channels) sum += ch[i]
    mono[i] = sum / channels.length
  }
  return {
    peaks: reduceChannelsToPeaks(channels, bins),
    durationSec: buffer.duration,
    playable: encodeWavPcm16(mono, buffer.sampleRate),
  }
}
