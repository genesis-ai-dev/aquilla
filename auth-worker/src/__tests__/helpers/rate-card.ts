import type { Mock } from 'vitest'

/** Scripted OpenRouter model list. Prices are exact binary fractions so
 * reservation bounds assert as exact integers: 2^-20 USD per output token,
 * free prompt tokens. `local-test` is the model every metered test requests.
 */
export const OUTPUT_PRICE = Math.pow(2, -20)
export function rateCard(models: Array<{ id: string; prompt?: number; completion?: number }> = [{ id: 'local-test' }]) {
  return new Response(JSON.stringify({ data: models.map(m => ({ id: m.id,
    pricing: { prompt: String(m.prompt ?? 0), completion: String(m.completion ?? OUTPUT_PRICE) } })) }),
    { headers: { 'Content-Type': 'application/json' } })
}
/** Route `/models` to the scripted card; everything else to the provider stub. */
export function withRateCard<T extends Mock>(provider: T, card = rateCard): T {
  const routed = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    return url.endsWith('/models') ? Promise.resolve(card()) : provider(input, init)
  }) as unknown as T
  ;(routed as unknown as { mock: unknown }).mock = provider.mock
  return routed
}
