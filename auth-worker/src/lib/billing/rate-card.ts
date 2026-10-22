import type { Env } from '../../types'
import { providerCostToMicroCents } from '../../../../db/shared/billing-cost'
import {
  isAbortTimeout,
  logVendorTimeout,
  VENDOR_TIMEOUT_MS,
} from "../../../../shared/vendor-timeouts"

/** Live OpenRouter model prices (USD per token) are the only rate card
 * (decision 2026-09-16). A model absent from the card is refused, never
 * estimated. Settlement still uses the provider-reported cost of the request.
 */
export interface RateCard { fetchedAt: number; prices: Map<string, { prompt: number; completion: number }> }
const CARD_TTL_MS = 10 * 60 * 1000
const cache = new Map<string, RateCard>()

export async function readRateCard(env: Pick<Env, 'OPENROUTER_BASE_URL' | 'OPENROUTER_API_KEY'>, now = Date.now()): Promise<RateCard> {
  const base = env.OPENROUTER_BASE_URL?.replace(/\/$/, '')
  if (!base) throw new Error('Rate card unavailable')
  const cached = cache.get(base)
  if (cached && now - cached.fetchedAt < CARD_TTL_MS) return cached
  // AQU-1849: small JSON, and it gates every metered call — an unbounded read
  // here stalled admission itself. A blown deadline is one more
  // 'Rate card unavailable', which callers already handle.
  let response: Response
  try {
    response = await fetch(`${base}/models`, {
      headers: env.OPENROUTER_API_KEY ? { Authorization: `Bearer ${env.OPENROUTER_API_KEY}` } : {},
      signal: AbortSignal.timeout(VENDOR_TIMEOUT_MS.openRouterMetadata),
    })
  } catch (err) {
    if (isAbortTimeout(err)) logVendorTimeout('openRouterMetadata', err)
    throw new Error('Rate card unavailable', { cause: err })
  }
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

/** Jev (TypeSafe's decisions model, typesafe/jev-*) is not on the OpenRouter
 * card, and its decisions endpoint reports tokens, not cost. Decision
 * 2026-10-21 (Ryder, AQU-2064): Jev is priced at 0. Every call still passes the
 * entitlement check and writes its jev row; it counts nothing against the
 * allowance. If Jev gets a price, the 2026-10-06 Jev shadow eval measured
 * about $0.035 per million input tokens and $0.13 per million output tokens:
 * set them here, in USD per token (0.035e-6 and 0.13e-6).
 */
export const JEV_PRICE_USD_PER_TOKEN = { input: 0, output: 0 } as const
/** Output tokens one Jev call may answer with, for the reservation bound. */
export const JEV_MAX_OUTPUT_TOKENS = 4096

/** Raw cents for the tokens a Jev call reported. */
export function jevCostCents(usage: { input_tokens: number; output_tokens: number }) {
  const cents = (usage.input_tokens * JEV_PRICE_USD_PER_TOKEN.input
    + usage.output_tokens * JEV_PRICE_USD_PER_TOKEN.output) * 100
  providerCostToMicroCents(cents)
  return cents
}
/** Reservation bound for one Jev call, by the same 2-characters-a-token rule
 * as boundRequestCostCents. A zero price still reserves a positive amount:
 * the ledger needs one to hold the request slot. */
export function jevBoundCents(promptChars: number) {
  const cents = jevCostCents({ input_tokens: Math.ceil(promptChars / 2), output_tokens: JEV_MAX_OUTPUT_TOKENS })
  return Math.max(cents, 0.0001)
}
