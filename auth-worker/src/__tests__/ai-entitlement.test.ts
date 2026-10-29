// AQU-2061 (unified billing T4): the one entitlement check. Why these tests
// matter: every paid AI path will move onto checkAiEntitlement (T5–T9), so its
// decision table IS the billing policy. Shadow must never refuse an allowance
// (two weeks of shadow are the evidence for enforcement, spec §5.4); enforce
// must refuse with 402 (the client already expects 402, spec §5.3); Enterprise
// and BYOK must never be refused on allowance; and the platform ceiling, which
// protects OUR keys, must still stop metered and unmetered calls in every mode.
import { env, pg } from './helpers/pg-test-env'
import { seedUser } from './helpers/db'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  checkAiEntitlement, meterMode, paidFetch,
  type AiEntitlementEnv, type AiEntitlementRequest, type ByokKeyLookup, type MeterMode,
} from '../../../db/shared/ai-entitlement'
import { __resetAiSpendCeilingStateForTests } from '../../../db/shared/ai-spend-ceiling'
import { readProviderCostCents } from '../../../db/shared/billing-cost'
import { resolveOrgPlan, type OrgTier } from '../../../db/shared/org-plan'

const now = new Date('2026-10-19T12:00:00Z')
const ORG = 1
const orgKeys: ByokKeyLookup = async (_db, _org, provider) => provider === 'openrouter' ? 'sk-or-customer' : null
const config = (mode: MeterMode | undefined, extra: Partial<AiEntitlementEnv> = {}): AiEntitlementEnv => ({
  ENVIRONMENT: 'test', OPENROUTER_API_KEY: 'sk-or-house', MODAL_TOKEN: 'modal-house',
  ...(mode ? { BILLING_METER_MODE: mode } : {}), ...extra,
})
let seq = 0
const request = (over: Partial<AiEntitlementRequest> = {}): AiEntitlementRequest => ({
  orgId: ORG, userId: 1, projectId: 'p', rail: 'llm', provider: 'openrouter',
  estimateRawCents: 1, requestId: `r-${++seq}`, ...over,
})
const rows = () => pg.query<{ request_id: string; mode: string; decision: string; state: string }>(
  'SELECT request_id, mode, decision, state FROM workspace_usage_requests ORDER BY created_at, request_id').then(r => r.rows)

/** A Free/Team org already past 100% this week, so the decision matters. */
async function overLimitOrg(tier: OrgTier) {
  await pg.exec(`INSERT INTO organizations (id, name, owner_user_id, created_at) VALUES (${ORG}, 'o', 1, '2026-10-01T00:00:00Z');
    INSERT INTO projects (id, name, org_id, created_by) VALUES ('p', 'P', ${ORG}, 1);
    INSERT INTO org_billing (org_id, tier) VALUES (${ORG}, '${tier}')`)
  const plan = (await resolveOrgPlan(env.AQUILLA_PG, ORG, now))!
  if (plan.weeklyAllowanceUnits !== null) {
    // Settled metered usage at 101% of the allowance (micro-units = raw µ¢ × 4).
    const raw = Math.ceil(plan.weeklyAllowanceUnits * 1_000_000 * 1.01 / 4)
    await pg.query(`INSERT INTO workspace_usage_requests (org_id, request_id, user_id, project_id, rail, rate_version,
        multiplier, period_start, period_end, reserved_micro_units, state, raw_micro_cents, settled_micro_units, resolved_at, created_at)
      VALUES ($1, 'spent', 1, 'p', 'llm', '2026-09-cost-v1', 4, $2, $3, $4, 'settled', $5, $4, $6, $6)`,
    [ORG, plan.period.start, plan.period.end, raw * 4, raw, now.toISOString()])
  }
}

beforeEach(async () => {
  __resetAiSpendCeilingStateForTests()
  await seedUser(1, 'alice')
})
afterEach(() => vi.restoreAllMocks())

describe('mode × plan × BYOK decision table (org already over its weekly allowance)', () => {
  type Expect = { ok: true; mode: string; key: 'house' | 'org'; row: null | { mode: string; decision: string } } | { ok: false; status: number }
  const cases: [MeterMode, OrgTier, boolean, Expect][] = []
  for (const meter of ['off', 'shadow', 'enforce'] as const) {
    for (const tier of ['free', 'team', 'enterprise'] as const) {
      for (const byok of [false, true]) {
        let e: Expect
        if (byok) {
          // The customer's own key: never on our allowance, whatever the plan.
          e = { ok: true, mode: 'byok', key: 'org', row: meter === 'off' ? null : { mode: 'byok', decision: 'allow' } }
        } else if (tier === 'enterprise') {
          e = { ok: true, mode: 'unmetered', key: 'house', row: meter === 'off' ? null : { mode: 'unmetered', decision: 'allow' } }
        } else if (meter === 'enforce') {
          e = { ok: false, status: 402 }
        } else {
          e = { ok: true, mode: 'metered', key: 'house', row: meter === 'off' ? null : { mode: 'metered', decision: 'would_block' } }
        }
        cases.push([meter, tier, byok, e])
      }
    }
  }
  it.each(cases)('%s · %s · byok=%s', async (meter, tier, byok, expected) => {
    await overLimitOrg(tier)
    const req = request()
    const result = await checkAiEntitlement(env.AQUILLA_PG, config(meter), req, { now, ...(byok ? { byokKeys: orgKeys } : {}) })
    if (!expected.ok) {
      expect(result).toMatchObject({ ok: false, status: 402, reason: 'ai_allowance_exhausted',
        body: { error: 'ai_allowance_exhausted', tier, canUpgrade: tier === 'free', canByok: true } })
      // Enforce refuses before any reservation: nothing new is held.
      expect((await rows()).map(r => r.request_id)).toEqual(['spent'])
      return
    }
    expect(result).toMatchObject({ ok: true, mode: expected.mode, tier, key: { source: expected.key } })
    const written = (await rows()).filter(r => r.request_id === req.requestId)
    expect(written).toEqual(expected.row ? [{ request_id: req.requestId, ...expected.row, state: 'reserved' }] : [])
  })
})

describe('allowance edges', () => {
  it('admits under 100% and lets a bounded call finish up to 105%, in enforce', async () => {
    await pg.exec(`INSERT INTO organizations (id, name, owner_user_id, created_at) VALUES (${ORG}, 'o', 1, '2026-10-01T00:00:00Z');
      INSERT INTO projects (id, name, org_id, created_by) VALUES ('p', 'P', ${ORG}, 1)`)
    // Free = $1/week raw (100¢). 98¢ admits; then 6¢ would end at 104%: allowed.
    const e = config('enforce')
    expect((await checkAiEntitlement(env.AQUILLA_PG, e, request({ estimateRawCents: 98 }), { now })).ok).toBe(true)
    expect((await checkAiEntitlement(env.AQUILLA_PG, e, request({ estimateRawCents: 6 }), { now })).ok).toBe(true)
    // Past 100% nothing new starts, however small.
    expect(await checkAiEntitlement(env.AQUILLA_PG, e, request({ estimateRawCents: 0.01 }), { now })).toMatchObject({ status: 402 })
  })

  it('refuses a call whose bound alone would end past 105%', async () => {
    await overLimitOrg('free')
    await pg.exec("DELETE FROM workspace_usage_requests")
    expect(await checkAiEntitlement(env.AQUILLA_PG, config('enforce'), request({ estimateRawCents: 106 }), { now }))
      .toMatchObject({ ok: false, status: 402 })
  })

  it('keeps GPU and sandbox metered for a BYOK org: a customer key cannot pay for them', async () => {
    await overLimitOrg('team')
    const gpu = await checkAiEntitlement(env.AQUILLA_PG, config('enforce'),
      request({ rail: 'gpu', provider: 'modal' }), { now, byokKeys: async () => 'customer-modal' })
    expect(gpu).toMatchObject({ ok: false, status: 402, body: { canByok: false } })
  })

  it('refuses a replayed request id instead of authorizing a second provider call', async () => {
    await overLimitOrg('enterprise')
    const req = request()
    expect((await checkAiEntitlement(env.AQUILLA_PG, config('shadow'), req, { now })).ok).toBe(true)
    expect(await checkAiEntitlement(env.AQUILLA_PG, config('shadow'), req, { now })).toMatchObject({ ok: false, status: 409, reason: 'duplicate_request' })
  })
})

describe('platform spend ceiling', () => {
  // `0` is the panic position: no paid AI on our keys at all.
  const ceilingZero = (meter: MeterMode) => config(meter, { AI_DAILY_SPEND_CEILING_USD: '0' })

  it.each(['off', 'shadow', 'enforce'] as const)('stops metered and unmetered calls in %s mode, BYOK passes', async meter => {
    await overLimitOrg('enterprise')
    expect(await checkAiEntitlement(env.AQUILLA_PG, ceilingZero(meter), request(), { now }))
      .toMatchObject({ ok: false, status: 503, reason: 'ai_spend_ceiling_reached' })
    expect(await checkAiEntitlement(env.AQUILLA_PG, ceilingZero(meter), request(), { now, byokKeys: orgKeys }))
      .toMatchObject({ ok: true, mode: 'byok' })
  })

  it('refuses rather than run without a house key', async () => {
    await overLimitOrg('enterprise')
    expect(await checkAiEntitlement(env.AQUILLA_PG, config('shadow', { OPENROUTER_API_KEY: '' }), request(), { now }))
      .toMatchObject({ ok: false, status: 503, reason: 'provider_unconfigured' })
  })
})

describe('paidFetch', () => {
  it('passes the chosen key to the provider and settles from usage.cost', async () => {
    await overLimitOrg('enterprise')
    const req = request({ estimateRawCents: 50 })
    const seen: string[] = []
    const out = await paidFetch(env.AQUILLA_PG, config('shadow'), req,
      async key => { seen.push(key.apiKey); return { usage: { cost: 0.0125 } } }, readProviderCostCents, { now })
    expect(out.ok).toBe(true)
    expect(seen).toEqual(['sk-or-house'])
    const row = await pg.query<{ state: string; raw_micro_cents: number }>(
      'SELECT state, raw_micro_cents FROM workspace_usage_requests WHERE request_id = $1', [req.requestId])
    expect(row.rows).toEqual([{ state: 'settled', raw_micro_cents: 1_250_000 }])
  })

  it('releases the reservation when the provider call throws', async () => {
    await overLimitOrg('enterprise')
    const req = request()
    await expect(paidFetch(env.AQUILLA_PG, config('enforce'), req,
      async () => { throw new Error('provider down') }, () => 0, { now })).rejects.toThrow('provider down')
    expect((await rows()).find(r => r.request_id === req.requestId)?.state).toBe('released')
  })

  it('keeps the reservation held when the cost is unknown, and still returns the result', async () => {
    await overLimitOrg('enterprise')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const req = request()
    const out = await paidFetch(env.AQUILLA_PG, config('enforce'), req, async () => ({}), readProviderCostCents, { now })
    expect(out).toMatchObject({ ok: true, result: {} })
    expect((await rows()).find(r => r.request_id === req.requestId)?.state).toBe('reserved')
  })

  it('never calls the provider when refused', async () => {
    await overLimitOrg('free')
    const call = vi.fn(async () => ({}))
    expect(await paidFetch(env.AQUILLA_PG, config('enforce'), request(), call, () => 0, { now })).toMatchObject({ status: 402 })
    expect(call).not.toHaveBeenCalled()
  })
})

describe('BILLING_METER_MODE', () => {
  it('is off until set, and a typo degrades to shadow rather than switching the meter off', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(meterMode({})).toBe('off')
    expect(meterMode({ BILLING_METER_MODE: ' Enforce ' })).toBe('enforce')
    expect(meterMode({ BILLING_METER_MODE: 'enforced' })).toBe('shadow')
  })
})
