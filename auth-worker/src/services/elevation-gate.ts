// AQU-1322: admin power applies only while elevated, on project membership writes.
//
// resolveProjectRole adds a { source: "platform", level: 700 } contribution for
// every platform admin, and platform has the lowest tie priority. So a resolved
// role whose source is "platform" means the decision rests on admin power, not a
// genuine grant (override, group, org, creator). Those writes need the same
// step-up elevation the admin console demands. The org-side twin is
// resolveOrgWriteRole in routes/orgs.ts.

import type { Context } from "hono"
import type { AuthHonoEnv } from "../middleware/auth"
import { hasActiveElevation } from "../middleware/platform-admin"

/**
 * A 403 Response when `callerRole` rests on platform-admin power and the
 * request carries no active elevation; null when the write may proceed.
 */
export async function projectElevationDenial(
  c: Context<AuthHonoEnv>,
  callerRole: { source: string },
): Promise<Response | null> {
  if (callerRole.source !== "platform") return null
  if (await hasActiveElevation(c)) return null
  return c.json(
    { error: "elevation required to manage project membership with platform-admin access" },
    403,
  )
}
