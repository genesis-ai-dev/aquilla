import { Hono } from 'hono'
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
export default billingWorkspace
