import { afterEach, expect, it, vi } from 'vitest'
import type { Env } from '../types'
import { boundRequestCostCents, readRateCard, resetRateCardCache } from '../lib/billing/rate-card'
import { OUTPUT_PRICE, rateCard } from './helpers/rate-card'

afterEach(() => { vi.unstubAllGlobals(); resetRateCardCache() })
const env = { OPENROUTER_BASE_URL: 'http://127.0.0.1:9999/v1', OPENROUTER_API_KEY: 'k' } as Env

it('prices a request from the live card with the enforced output cap and refuses unknown models', async () => {
  const fetch = vi.fn(async () => rateCard([{ id: 'local-test', prompt: OUTPUT_PRICE, completion: OUTPUT_PRICE }]))
  vi.stubGlobal('fetch', fetch)
  const card = await readRateCard(env)
  // 10 characters bound to 5 prompt tokens; 4096 output tokens at 2^-20 USD each.
  expect(boundRequestCostCents(card, { model: 'local-test', promptChars: 10, maxOutputTokens: 4096 }))
    .toBe((5 + 4096) * OUTPUT_PRICE * 100)
  expect(() => boundRequestCostCents(card, { model: 'anthropic/claude-opus-5', promptChars: 10, maxOutputTokens: 10 })).toThrow('Model price unavailable')
  expect(() => boundRequestCostCents(card, { model: 'local-test', promptChars: 10, maxOutputTokens: 0 })).toThrow('Invalid request bound')
  expect((fetch.mock.calls[0] as unknown[])[1]).toMatchObject({ headers: { Authorization: 'Bearer k' } })
})
it('holds a free model to a positive reservation so its request still occupies the ledger', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => rateCard([{ id: 'free', prompt: 0, completion: 0 }])))
  expect(boundRequestCostCents(await readRateCard(env), { model: 'free', promptChars: 100, maxOutputTokens: 100 })).toBeGreaterThan(0)
})
it('caches the card for ten minutes per provider and refetches after expiry', async () => {
  const fetch = vi.fn(async () => rateCard())
  vi.stubGlobal('fetch', fetch)
  await readRateCard(env, 0); await readRateCard(env, 9 * 60 * 1000)
  expect(fetch).toHaveBeenCalledTimes(1)
  await readRateCard(env, 11 * 60 * 1000)
  expect(fetch).toHaveBeenCalledTimes(2)
  await readRateCard({ ...env, OPENROUTER_BASE_URL: 'http://127.0.0.1:9998/v1' }, 11 * 60 * 1000)
  expect(fetch).toHaveBeenCalledTimes(3)
})
it('treats provider errors, malformed lists, and bad prices as no card rather than a zero price', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 503 })))
  await expect(readRateCard(env)).rejects.toThrow('Rate card unavailable')
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ models: [] }))))
  await expect(readRateCard(env)).rejects.toThrow('Rate card unavailable')
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'odd', pricing: { prompt: 'n/a', completion: '0' } }, { id: 'neg', pricing: { prompt: '-1', completion: '0' } }] }))))
  const card = await readRateCard(env)
  expect(card.prices.size).toBe(0)
  await expect(readRateCard({ ...env, OPENROUTER_BASE_URL: undefined })).rejects.toThrow('Rate card unavailable')
})
