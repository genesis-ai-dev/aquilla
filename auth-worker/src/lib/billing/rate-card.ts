import type { Env } from '../../types'
import { providerCostToMicroCents } from '../../../../db/shared/billing-cost'

/** Live OpenRouter model prices (USD per token) are the only rate card
 * (decision 2026-09-16). A model absent from the card is refused, never
 * estimated. Settlement still uses the provider-reported cost of the request.
 */
export interface RateCard { fetchedAt: number; prices: Map<string, { prompt: number; completion: number }> }
const CARD_TTL_MS = 10 * 60 * 1000
const cache = new Map<string, RateCard>()

export async function readRateCard(env: Env, now = Date.now()): Promise<RateCard> {
  const base = env.OPENROUTER_BASE_URL?.replace(/\/$/, '')
  if (!base) throw new Error('Rate card unavailable')
  const cached = cache.get(base)
  if (cached && now - cached.fetchedAt < CARD_TTL_MS) return cached
  const response = await fetch(`${base}/models`, {
    headers: env.OPENROUTER_API_KEY ? { Authorization: `Bearer ${env.OPENROUTER_API_KEY}` } : {},
  })
  if (!response.ok) throw new Error('Rate card unavailable')
  const body = await response.json() as { data?: Array<{ id?: unknown; pricing?: { prompt?: unknown; completion?: unknown } }> } | null
  if (!Array.isArray(body?.data)) throw new Error('Rate card unavailable')
  const prices = new Map<string, { prompt: number; completion: number }>()
  for (const model of body.data) {
    const prompt = Number(model.pricing?.prompt), completion = Number(model.pricing?.completion)
    if (typeof model.id !== 'string' || !Number.isFinite(prompt) || !Number.isFinite(completion)
      || prompt < 0 || completion < 0) continue
    prices.set(model.id, { prompt, completion })
  }
  const card = { fetchedAt: now, prices }
  cache.set(base, card)
  return card
}
export function resetRateCardCache() { cache.clear() }

/** Conservative pre-call bound in raw cents. Prompt size is bounded from
 * characters (2 characters per token covers non-Latin scripts); output uses
 * the enforced max_tokens cap. Never a bill: the settled cost replaces it.
 */
export function boundRequestCostCents(card: RateCard, input: { model: string; promptChars: number; maxOutputTokens: number }) {
  const price = card.prices.get(input.model)
  if (!price) throw new Error('Model price unavailable')
  if (!Number.isInteger(input.maxOutputTokens) || input.maxOutputTokens <= 0 || input.promptChars < 0) {
    throw new Error('Invalid request bound')
  }
  const promptTokens = Math.ceil(input.promptChars / 2)
  const cents = (promptTokens * price.prompt + input.maxOutputTokens * price.completion) * 100
  providerCostToMicroCents(cents)
  // A free model still needs a positive reservation to hold its request slot.
  return Math.max(cents, 0.0001)
}
