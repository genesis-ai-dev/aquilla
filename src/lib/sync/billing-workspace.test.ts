import { afterEach, expect, it, vi } from 'vitest'
import { startWorkspaceBillingPortal } from './billing-workspace'
afterEach(() => vi.unstubAllGlobals())
it('posts to the owning workspace and accepts only a sandbox Stripe destination', async () => {
  const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json({ sandbox: true, url: 'https://billing.stripe.com/p/session/test' }))
  vi.stubGlobal('fetch', fetch)
  expect(await startWorkspaceBillingPortal('session-jwt', 42)).toBe('https://billing.stripe.com/p/session/test')
  const [url, init] = fetch.mock.calls[0]!
  expect(url).toContain('/api/v2/orgs/42/billing/portal-rehearsal')
  expect(init?.method).toBe('POST')
  expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer session-jwt')
})
it.each([
  { sandbox: false, url: 'https://billing.stripe.com/p/session/test' },
  { sandbox: true, url: 'https://billing.stripe.com.evil.test/' },
  { sandbox: true, url: 'http://billing.stripe.com/' },
  { sandbox: true, url: 'https://user@billing.stripe.com/' },
  { sandbox: true, url: null },
])('rejects an unsafe destination: %j', async response => {
  vi.stubGlobal('fetch', async () => Response.json(response))
  await expect(startWorkspaceBillingPortal('session-jwt', 42)).rejects.toThrow()
})
it('keeps upstream error details out of the UI', async () => {
  vi.stubGlobal('fetch', async () => Response.json({ error: 'private Stripe details' }, { status: 503 }))
  await expect(startWorkspaceBillingPortal('session-jwt', 42)).rejects.toThrow('Billing management is unavailable')
})
