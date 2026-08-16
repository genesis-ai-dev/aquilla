// Fast client-side Opus encoding for GENERATED voices (smooth-playback round).
//
// TTS output used to upload as raw 48 kHz PCM WAV — ~96 KB/s, ~14× larger
// than the webm/opus the mic takes already use, and the single biggest reason
// projects grow heavy (a 10s verse ≈ 1 MB). New generations now encode to the
// SAME container/codec as mic recordings, so every downstream consumer
// (playback, transcription, peaks, exports — all decodeAudioData-based) is
// already proven on it.
//
// Why not MediaRecorder (the denoiser's encoder)? MediaRecorder records in
// REAL TIME — a 10s clip takes 10s to encode, doubling every generation's
// wait. WebCodecs' AudioEncoder runs many× realtime; webm-muxer wraps the
// packets. Where WebCodecs audio is unavailable the caller falls back to
// WAV — a size regression, never a broken clip.
//
// Scope note (deliberate): only the CLIENT-synthesized branch compresses.
// OmniVoice and Seed-VC clone conversion write their clips server-side — that
// format is the sync-worker/Modal's decision and stays WAV for now (flagged
// for the storage-format discussion with Matthew).

import { Muxer, ArrayBufferTarget } from "webm-muxer"

/** Speech-transparent-ish mono Opus. (Mic takes record at browser defaults
 *  ~3× this; TTS speech doesn't benefit from more.) */
const OPUS_BITRATE = 48_000

export function canEncodeOpus(): boolean {
  return typeof AudioEncoder !== "undefined" && typeof AudioData !== "undefined"
}

export interface EncodedOpus {
  blob: Blob
  mimeType: "audio/webm"
  ext: "webm"
  durationMs: number
}

/**
 * Encode mono Float32 samples to a WebM/Opus blob, off the realtime clock.
 * Throws when WebCodecs is unavailable — callers must check canEncodeOpus()
 * (or catch and fall back).
 */
export async function encodeMonoToWebmOpus(
  samples: Float32Array,
  sampleRate: number,
): Promise<EncodedOpus> {
  if (!canEncodeOpus()) throw new Error("WebCodecs AudioEncoder unavailable")
  if (samples.length === 0) throw new Error("opus-encode: empty audio")

  const target = new ArrayBufferTarget()
  const muxer = new Muxer({
    target,
    audio: { codec: "A_OPUS", sampleRate, numberOfChannels: 1 },
    type: "webm",
  })

  let encodeError: unknown = null
  const encoder = new AudioEncoder({
    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta ?? {}),
    error: (e) => {
      encodeError = e
    },
  })
  encoder.configure({
    codec: "opus",
    sampleRate,
    numberOfChannels: 1,
    bitrate: OPUS_BITRATE,
  })

  // Feed in ~100ms frames — AudioData copies its buffer, so chunking keeps
  // peak memory flat for long clips.
  const FRAME = Math.max(1, Math.floor(sampleRate / 10))
  for (let offset = 0; offset < samples.length; offset += FRAME) {
    const len = Math.min(FRAME, samples.length - offset)
    const data = new AudioData({
      format: "f32-planar",
      sampleRate,
      numberOfFrames: len,
      numberOfChannels: 1,
      timestamp: Math.round((offset / sampleRate) * 1_000_000),
      data: samples.subarray(offset, offset + len) as Float32Array<ArrayBuffer>,
    })
    encoder.encode(data)
    data.close()
  }
  await encoder.flush()
  encoder.close()
  if (encodeError) throw encodeError instanceof Error ? encodeError : new Error(String(encodeError))

  muxer.finalize()
  const blob = new Blob([target.buffer], { type: "audio/webm" })
  if (blob.size === 0) throw new Error("opus-encode: produced empty output")
  return {
    blob,
    mimeType: "audio/webm",
    ext: "webm",
    durationMs: Math.round((samples.length / sampleRate) * 1000),
  }
}
