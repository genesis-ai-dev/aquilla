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
