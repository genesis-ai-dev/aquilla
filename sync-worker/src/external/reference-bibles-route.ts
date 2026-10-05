// AQU-1573: discovery read for the reference Bibles installed on this server.
//
//   GET /api/v1/external/reference-bibles   → { data: ReferenceBibleSummary[], nextCursor: null }
//
// An agent setting up a sermon or curriculum project needs the Bible ids it
// may name in PatchSettings / ProjectSetup `referenceBibleVersions`; without
// this it could only guess and read the validation_failed that lists them.
// The MCP tool `list_reference_bibles` returns the same list.
//
// Credential-only, like /me and /orgs: the built-in texts are public domain
// and belong to no project, so there is no project scope to check. Read rate
// limit applies. Mounted from read-routes.ts so the MCP tier's delegation and
// REST share one router.

import { listReferenceBibles } from "../../../db/shared/reference-bible"
import { externalError } from "./errors"
import { authenticateCredential, checkReadRateLimit, type ExternalReadsEnv } from "./read-auth"

const REFERENCE_BIBLES_RE = /^\/api\/v1\/external\/reference-bibles\/?$/

export async function handleExternalReferenceBiblesRequest(
  request: Request,
  env: ExternalReadsEnv,
): Promise<Response | null> {
  if (!REFERENCE_BIBLES_RE.test(new URL(request.url).pathname)) return null
  if (!env.AQUILLA_PG) return externalError("job_failed", "AQUILLA_PG not configured", 500)
  const authed = await authenticateCredential(request, env)
  if (!authed.ok) return authed.response
  const limited = await checkReadRateLimit(env.AQUILLA_PG, authed.credential.credentialId)
  if (limited) return limited
  const data = await listReferenceBibles(env.AQUILLA_PG)
  return Response.json({ data, nextCursor: null })
}
