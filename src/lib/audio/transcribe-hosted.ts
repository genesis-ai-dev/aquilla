import { t } from "@/lib/i18n/standalone"
import { AUTH_BASE } from "@/lib/frontier/auth"
import { buildTranscriptionRequest } from "./transcription-request"
import type { TranscriptionResult } from "./transcribe"

// Bound each request to one minute. Long clips retain clip-relative timings.
export async function transcribeHostedPcm(
  pcm: Float32Array,
  jwt: string,
  projectId: string,
  language?: string,
): Promise<TranscriptionResult> {
  const result: TranscriptionResult = { text: "", chunks: [] }
  const windowSamples = 60 * 16000
  for (let offset = 0; offset < pcm.length; offset += windowSamples) {
    const response = await fetch(`${AUTH_BASE}/api/v1/audio/transcriptions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify(await buildTranscriptionRequest(
        pcm.subarray(offset, offset + windowSamples), projectId, language,
      )),
      signal: AbortSignal.timeout(90000),
    })
    if (!response.ok) {
      const failure = await response.json().catch(() => null) as { error?: string } | null
      if (["weekly_ai_allowance_exhausted", "credit_cap_exceeded"].includes(failure?.error ?? "")) {
        throw new Error(t("settings.transcription.capacityExceeded"))
      }
      throw new Error(`Hosted transcription failed (${response.status}). Try again.`)
    }
    const part = await response.json() as TranscriptionResult
    result.text = [result.text, part.text].filter(Boolean).join(" ")
    const seconds = offset / 16000
    result.chunks.push(...part.chunks.map(chunk => ({
      ...chunk, start: chunk.start + seconds, end: chunk.end + seconds,
    })))
  }
  return result
}
