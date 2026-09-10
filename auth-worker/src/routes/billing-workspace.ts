import { Hono } from 'hono'
import { z } from 'zod'
import { readBillingOffers, unavailableOffers } from '../lib/billing/catalog'
import { paidOffers } from '../lib/billing/catalog-view'
import { reviewBillingPlan } from '../lib/billing/review'
import { authMiddleware, type AuthHonoEnv } from '../middleware/auth'
import { getEffectiveOrgRole } from '../services/org-permissions'
import { ROLE } from '../types'
import { readBillingWorkspace } from '../lib/billing/workspace'

const billingWorkspace = new Hono<AuthHonoEnv>()
billingWorkspace.get('/orgs/:orgId/billing/workspace', authMiddleware, async c => {
  const raw = c.req.param('orgId') ?? ''
  const orgId = Number(raw)
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(orgId) || orgId < 1) {
    return c.json({ error: 'invalid_org' }, 400)
  }
  const role = await getEffectiveOrgRole(c.env, orgId, c.get('user'))
  if (role == null || role < ROLE.MAINTAINER) {
    return c.json({ error: 'forbidden' }, 403)
  }
  c.header('Cache-Control', 'private, no-store')
  const workspace = await readBillingWorkspace(c.env.AQUILLA_PG, orgId)
  if (!workspace) return c.json({ error: 'not_found' }, 404)
  return c.json(workspace)
})
const selectionSchema = z.object({
  offer: z.enum(paidOffers), interval: z.enum(['month', 'year']), quantity: z.literal(1),
}).strict()

billingWorkspace.post('/orgs/:orgId/billing/review', authMiddleware, async c => {
  const raw = c.req.param('orgId') ?? ''
  const orgId = Number(raw)
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(orgId) || orgId < 1) {
    return c.json({ error: 'invalid_org' }, 400)
  }
  const role = await getEffectiveOrgRole(c.env, orgId, c.get('user'))
  if (role == null || role < ROLE.MAINTAINER) return c.json({ error: 'forbidden' }, 403)
  const selection = selectionSchema.safeParse(await c.req.json().catch(() => null))
  if (!selection.success) return c.json({ error: 'invalid_selection' }, 400)
  c.header('Cache-Control', 'private, no-store')
  const workspace = await readBillingWorkspace(c.env.AQUILLA_PG, orgId)
  if (!workspace) return c.json({ error: 'not_found' }, 404)
  // Eligibility precedes Stripe reads and never relies on browser-provided scope.
  if (workspace.eligibility.reason !== 'ready'
    || !workspace.eligibility.offers.includes(selection.data.offer)) {
    return c.json(reviewBillingPlan(workspace, selection.data, unavailableOffers()))
  }
  try {
    return c.json(reviewBillingPlan(workspace, selection.data, await readBillingOffers(c.env)))
  } catch {
    return c.json({ error: 'pricing_unavailable' }, 503)
  }
})
export default billingWorkspace
