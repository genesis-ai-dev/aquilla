import { encodeWavPcm16 } from "./wav-encode"
import type { TranscriptionModel } from "./transcription-model"

export interface TranscriptionRequestExample {
  url: string
  text: string
}

/** Real client payload, shared with the producer/consumer regression test. */
export async function buildTranscriptionRequest(
  pcm: Float32Array, projectId: string, language?: string,
  route: { model?: TranscriptionModel; examples?: TranscriptionRequestExample[] } = {},
) {
  const bytes = new Uint8Array(await encodeWavPcm16(pcm, 16000).arrayBuffer())
  let binary = ""
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
  }
  return {
    projectId, input_audio: { data: btoa(binary), format: "wav" },
    ...(language && { language }),
    ...(route.model && { model: route.model }),
    ...(route.examples?.length && { examples: route.examples }),
  }
}
