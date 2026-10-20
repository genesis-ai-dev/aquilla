import type { Env } from '../../types'
import { providerCostToMicroCents } from '../../../../db/shared/billing-cost'

/**
 * Whisper large-v3, not `openai/whisper-1`. Our OpenRouter account enforces
 * zero data retention, and OpenAI's whisper-1 endpoint is not ZDR: OpenRouter
 * answers 404 "0 endpoints … available matching your guardrail restrictions
 * and data policy", which reached users as a 502 on every hosted Whisper
 * request (2026-10-20). large-v3 has a ZDR endpoint, returns the same word
 * timestamps, covers the same languages, and costs ~13× less.
 */
export const WHISPER_MODEL = 'openai/whisper-large-v3'
/** Chinese varieties only (db/shared/asr-models.ts pickAsrModel). */
export const QWEN_ASR_MODEL = 'qwen/qwen3-asr-1.7b'
export type OpenRouterAsrModel = typeof WHISPER_MODEL | typeof QWEN_ASR_MODEL
const rates = new Map<string, { centsPerSecond: number; fetchedAt: number }>()

/** Only accept the canonical mono 16 kHz PCM16 WAV produced by the SPA.
 * Derive the cost bound from actual bytes, never a client-supplied duration.
 */
export function transcriptionSeconds(base64: string): number {
  const binary = atob(base64)
  if (binary.length <= 44) throw new Error('Invalid transcription audio')
  const bytes = Uint8Array.from(binary, ch => ch.charCodeAt(0))
  const view = new DataView(bytes.buffer)
  const text = (start: number, end: number) => binary.slice(start, end)
  if (text(0, 4) !== 'RIFF' || text(8, 16) !== 'WAVEfmt '
    || text(36, 40) !== 'data' || view.getUint32(4, true) !== bytes.length - 8
    || view.getUint32(16, true) !== 16 || view.getUint16(20, true) !== 1
    || view.getUint16(22, true) !== 1 || view.getUint32(24, true) !== 16000
    || view.getUint32(28, true) !== 32000 || view.getUint16(32, true) !== 2
    || view.getUint16(34, true) !== 16
    || view.getUint32(40, true) !== bytes.length - 44
    || (bytes.length - 44) % 2 !== 0) throw new Error('Invalid transcription audio')
  const seconds = (bytes.length - 44) / 32000
  if (seconds > 60) throw new Error('Transcription audio exceeds window limit')
  return seconds
}

/** The transcription catalog's prompt price is USD per audio second.
 * Missing prices fail closed; actual provider usage settles the reservation.
 */
export async function transcriptionCostBound(env: Env, seconds: number, model: OpenRouterAsrModel = WHISPER_MODEL) {
  const base = env.OPENROUTER_BASE_URL?.replace(/\/+$/, '')
    ?? 'https://openrouter.ai/api/v1'
  const cacheKey = `${base} ${model}`
  let rate = rates.get(cacheKey)
  if (!rate || Date.now() - rate.fetchedAt >= 600000) {
    const response = await fetch(`${base}/models?output_modalities=transcription`, {
      headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}` },
      signal: AbortSignal.timeout(10000),
    })
    if (!response.ok) throw new Error('Transcription price unavailable')
    const body = await response.json() as {
      data?: Array<{ id?: string; pricing?: { prompt?: unknown } }>
    }
    const price = body.data?.find(entry => entry.id === model)?.pricing?.prompt
    const dollars = (typeof price === 'string' && price.trim().length > 0)
      || typeof price === 'number' ? Number(price) : NaN
    if (!Number.isFinite(dollars) || dollars < 0) {
      throw new Error('Transcription price unavailable')
    }
    rate = { centsPerSecond: dollars * 100, fetchedAt: Date.now() }
    rates.set(cacheKey, rate)
  }
  // Whisper rounds audio duration to seconds; round upward for admission.
  const cents = Math.max(Math.ceil(seconds) * rate.centsPerSecond, 0.0001)
  providerCostToMicroCents(cents)
  return cents
}
export function resetTranscriptionRateCache() { rates.clear() }
