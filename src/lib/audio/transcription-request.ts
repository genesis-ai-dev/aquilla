import { encodeWavPcm16 } from "./wav-encode"
import type { TranscriptionModel } from "./transcription-model"

export interface TranscriptionRequestExample {
  url: string
  text: string
}

/** Base64 by hand: bytes to a binary string in slices, then `btoa`. */
export function base64ByHand(bytes: Uint8Array): string {
  let binary = ""
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
  }
  return btoa(binary)
}

/**
 * Bytes in base64.
 *
 * AQU-2654: the engine's own encoder (`Uint8Array.prototype.toBase64`, in
 * current Chromium, WebKit and Gecko) where there is one. Encoding by hand
 * blocked the main thread for as long as the clip was long, on every row of a
 * pass: measured at 4× CPU slowdown, 76 ms for a 15 s clip and 265 ms for the
 * 60 s window a long recording is sent in. Both give the same string (the
 * standard alphabet, padded), so the request is byte for byte what it was; an
 * engine without the method encodes by hand as before.
 */
export function base64Of(bytes: Uint8Array): string {
  const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64
  return typeof native === "function" ? native.call(bytes) : base64ByHand(bytes)
}

/** Real client payload, shared with the producer/consumer regression test. */
export async function buildTranscriptionRequest(
  pcm: Float32Array, projectId: string, language?: string,
  route: { model?: TranscriptionModel; examples?: TranscriptionRequestExample[] } = {},
) {
  const bytes = new Uint8Array(await encodeWavPcm16(pcm, 16000).arrayBuffer())
  return {
    projectId, input_audio: { data: base64Of(bytes), format: "wav" },
    ...(language && { language }),
    ...(route.model && { model: route.model }),
    ...(route.examples?.length && { examples: route.examples }),
  }
}
