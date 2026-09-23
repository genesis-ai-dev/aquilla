import type { Env } from '../../types'

/** Weekly-allowance enforcement mode (decisions 2026-09-16).
 *  - off: legacy credit/word guards remain the only limits.
 *  - rehearsal: metering on, but only under wrangler local with loopback
 *    requests and a loopback provider. Anything else fails closed.
 *  - enforce: metering on for any provider. Once a producer is metered, the
 *    legacy guards and ledgers are retired for it: one authority, not two.
 */
export type WeeklyUsageMode = 'off' | 'rehearsal' | 'enforce'
export function weeklyUsageMode(env: Env): WeeklyUsageMode {
  if (env.BILLING_WEEKLY_USAGE_ENFORCE === 'true') return 'enforce'
  if (env.BILLING_CHAT_USAGE_REHEARSAL === 'true') return 'rehearsal'
  return 'off'
}

const loopback = (url: string | undefined) => {
  try {
    const parsed = new URL(url ?? '')
    return ['http:', 'https:'].includes(parsed.protocol)
      && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
      && !parsed.username && !parsed.password
  } catch { return false }
}

/** Whether this call meters: `on`, `off`, or `unavailable` (rehearsal outside
 *  loopback, which must refuse rather than run unmetered). Background work has
 *  no request URL; the provider URL alone carries the rehearsal gate. */
export function weeklyUsageActive(env: Env, requestUrl?: string): 'on' | 'off' | 'unavailable' {
  const mode = weeklyUsageMode(env)
  if (mode === 'off') return 'off'
  if (mode === 'enforce') return 'on'
  // Rehearsal is a local-dev mode: wrangler local, loopback request, loopback provider.
  return env.WRANGLER_LOCAL === '1' && loopback(env.OPENROUTER_BASE_URL)
    && (requestUrl === undefined || loopback(requestUrl)) ? 'on' : 'unavailable'
}
