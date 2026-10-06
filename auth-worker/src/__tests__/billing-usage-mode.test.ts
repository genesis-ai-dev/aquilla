import { workspaceBillingMode, workspaceCheckoutEnabled } from '../lib/billing/environment'
import { expect, it } from 'vitest'
import type { Env } from '../types'
import { weeklyUsageActive, weeklyUsageMode } from '../lib/billing/usage-mode'

const local = { OPENROUTER_BASE_URL: 'http://127.0.0.1:9999/v1', WRANGLER_LOCAL: '1' } as Env
const live = { OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1' } as Env

it('stays off unless a flag opts in, and rehearsal only meters loopback work', () => {
  expect(weeklyUsageMode(local)).toBe('off')
  expect(weeklyUsageActive(local, 'http://127.0.0.1/api')).toBe('off')
  const rehearsal = { ...local, BILLING_CHAT_USAGE_REHEARSAL: 'true' }
  expect(weeklyUsageActive(rehearsal, 'http://localhost:8787/api')).toBe('on')
  expect(weeklyUsageActive(rehearsal)).toBe('on')
  // A deployed request or a live provider must refuse, never run unmetered.
  expect(weeklyUsageActive(rehearsal, 'https://api.aquilla.app/chat')).toBe('unavailable')
  expect(weeklyUsageActive({ ...live, BILLING_CHAT_USAGE_REHEARSAL: 'true' }, 'http://127.0.0.1/api')).toBe('unavailable')
  expect(weeklyUsageActive({ ...rehearsal, OPENROUTER_BASE_URL: 'http://user:pw@127.0.0.1/v1' })).toBe('unavailable')
  expect(weeklyUsageActive({ ...rehearsal, WRANGLER_LOCAL: undefined })).toBe('unavailable')
})
it('enforce meters any provider and outranks rehearsal', () => {
  const enforce = { ...live, BILLING_WEEKLY_USAGE_ENFORCE: 'true', BILLING_CHAT_USAGE_REHEARSAL: 'true' }
  expect(weeklyUsageMode(enforce)).toBe('enforce')
  expect(weeklyUsageActive(enforce, 'https://api.aquilla.app/chat')).toBe('on')
  expect(weeklyUsageActive({ ...enforce, OPENROUTER_BASE_URL: undefined })).toBe('on')
})

const production = { ENVIRONMENT: 'production', STRIPE_SECRET_KEY: 'sk_live_fixture',
  BILLING_LIVE_HOSTS: 'api.aquilla.app,aquilla.app', BASE_URL: 'https://aquilla.app',
  BILLING_WORKSPACE_CHECKOUT_ENABLED: 'true', BILLING_WEEKLY_USAGE_ENFORCE: 'true' } as Env
it('separates the live sales switch from existing subscription processing', () => {
  expect(workspaceCheckoutEnabled(production, 'https://api.aquilla.app/identity')).toBe(true)
  const stopped = { ...production, BILLING_WORKSPACE_CHECKOUT_ENABLED: 'false' }
  expect(workspaceCheckoutEnabled(stopped, 'https://api.aquilla.app/identity')).toBe(false)
  expect(workspaceBillingMode(stopped, 'https://api.aquilla.app/identity')).toBe('live')
})
it.each([
  { BILLING_WEEKLY_USAGE_ENFORCE: undefined }, { BILLING_WEEKLY_USAGE_ENFORCE: 'false' },
  { ENVIRONMENT: 'development' }, { WRANGLER_LOCAL: '1' },
  { STRIPE_SECRET_KEY: 'sk_test_fixture' }, { BILLING_LIVE_HOSTS: undefined },
  { BASE_URL: 'https://evil.test' }, { BASE_URL: 'http://aquilla.app' },
  { BASE_URL: 'https://user@aquilla.app' }, { BASE_URL: 'https://aquilla.app:1234' },
])('refuses mismatched production configuration %j', override => {
  expect(workspaceCheckoutEnabled({ ...production, ...override }, 'https://api.aquilla.app/identity')).toBe(false)
})
it.each(['http://api.aquilla.app', 'https://evil.test', 'https://user@api.aquilla.app',
  'http://127.0.0.1', 'https://api.aquilla.app:1234'])('refuses live checkout from %s', url => {
  expect(workspaceCheckoutEnabled(production, url)).toBe(false)
})
