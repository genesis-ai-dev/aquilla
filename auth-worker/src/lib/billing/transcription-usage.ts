import type { Env } from '../../types'
import { providerCostToMicroCents } from '../../../../db/shared/billing-cost'

export const WHISPER_MODEL = 'openai/whisper-1'
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
export async function transcriptionCostBound(env: Env, seconds: number) {
  const base = env.OPENROUTER_BASE_URL?.replace(/\/+$/, '')
    ?? 'https://openrouter.ai/api/v1'
  let rate = rates.get(base)
  if (!rate || Date.now() - rate.fetchedAt >= 600000) {
    const response = await fetch(`${base}/models?output_modalities=transcription`, {
      headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}` },
      signal: AbortSignal.timeout(10000),
    })
    if (!response.ok) throw new Error('Transcription price unavailable')
    const body = await response.json() as {
      data?: Array<{ id?: string; pricing?: { prompt?: unknown } }>
    }
    const price = body.data?.find(model => model.id === WHISPER_MODEL)?.pricing?.prompt
    const dollars = (typeof price === 'string' && price.trim().length > 0)
      || typeof price === 'number' ? Number(price) : NaN
    if (!Number.isFinite(dollars) || dollars < 0) {
      throw new Error('Transcription price unavailable')
    }
    rate = { centsPerSecond: dollars * 100, fetchedAt: Date.now() }
    rates.set(base, rate)
  }
  // Whisper rounds audio duration to seconds; round upward for admission.
  const cents = Math.max(Math.ceil(seconds) * rate.centsPerSecond, 0.0001)
  providerCostToMicroCents(cents)
  return cents
}
export function resetTranscriptionRateCache() { rates.clear() }
