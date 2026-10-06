import type { Env } from '../../types'

const loopback = ['localhost', '127.0.0.1', '[::1]']
const hosts = (value: string | undefined) =>
  (value ?? '').split(',').map(host => host.trim()).filter(Boolean)

export function stripeLiveMode(env: Env): boolean {
  const key = env.STRIPE_SECRET_KEY?.trim() ?? ''
  if (!/^(sk|rk)_(test|live)_/.test(key)) throw new Error('Stripe key missing')
  return /^(sk|rk)_live_/.test(key)
}

/** Credentials and hosts identify the environment independently of sales. */
export function workspaceBillingMode(env: Env, requestUrl: string) {
  try {
    const request = new URL(requestUrl)
    const origin = new URL(env.BASE_URL ?? '')
    if (request.username || request.password || origin.username || origin.password) return null
    if (stripeLiveMode(env)) {
      const allowed = hosts(env.BILLING_LIVE_HOSTS)
      return env.ENVIRONMENT === 'production' && env.WRANGLER_LOCAL !== '1'
        && request.protocol === 'https:' && origin.protocol === 'https:'
        && !request.port && !origin.port
        && allowed.includes(request.hostname) && allowed.includes(origin.hostname)
        ? 'live' as const : null
    }
    if (env.BILLING_WORKSPACE_CHECKOUT_REHEARSAL !== 'true') return null
    if (env.WRANGLER_LOCAL === '1' && loopback.includes(request.hostname)
      && loopback.includes(origin.hostname)
      && ['http:', 'https:'].includes(origin.protocol)) return 'sandbox' as const
    const allowed = hosts(env.BILLING_SANDBOX_HOSTS)
    return env.ENVIRONMENT === 'development'
      && request.protocol === 'https:' && origin.protocol === 'https:'
      && !request.port && !origin.port
      && allowed.includes(request.hostname) && allowed.includes(origin.hostname)
      ? 'sandbox' as const : null
  } catch { return null }
}

export function workspaceCheckoutEnabled(env: Env, requestUrl: string) {
  const mode = workspaceBillingMode(env, requestUrl)
  return mode === 'sandbox'
    || (mode === 'live' && env.BILLING_WORKSPACE_CHECKOUT_ENABLED === 'true'
      && env.BILLING_WEEKLY_USAGE_ENFORCE === 'true')
}

export function billingReturnOrigin(env: Env) {
  const origin = new URL(env.BASE_URL ?? '')
  const allowed = stripeLiveMode(env) ? hosts(env.BILLING_LIVE_HOSTS)
    : hosts(env.BILLING_SANDBOX_HOSTS)
  const local = !stripeLiveMode(env) && env.WRANGLER_LOCAL === '1'
    && loopback.includes(origin.hostname)
    && ['http:', 'https:'].includes(origin.protocol)
  if ((!local && (origin.protocol !== 'https:' || origin.port
    || !allowed.includes(origin.hostname))) || origin.username || origin.password) {
    throw new Error('Billing requires an allowlisted return origin')
  }
  return origin.origin
}

export function validCheckoutSessionId(id: unknown, live: boolean): id is string {
  return typeof id === 'string'
    && (live ? /^cs_live_[a-zA-Z0-9_]+$/ : /^cs_test_[a-zA-Z0-9_]+$/).test(id)
}
