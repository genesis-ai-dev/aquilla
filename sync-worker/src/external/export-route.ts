// External export surface — the agent-callable mirror of the import side
// (AQU-858; AGENT-API §1 user outcome 6, "round-trip export — reconstruct the
// original format, deliver").
//
//   GET /api/v1/external/projects/:projectId/files/:fileId/export?lane=<tag>
//   GET /api/v1/external/projects/:projectId/files/:fileId/export?side=source
//
// Imports already work end-to-end from a scoped PAT (upload an artifact →
// preview_import → prepare_import → commit). Getting the deliverable back out
// did not: a human had to click Export in the SPA. This route closes that loop
// so an agent can drive "messy files in → clean deliverable out" — the concrete
// driver being USFM handed back to Paratext.
//
// It is a THIN WRAPPER over the existing internal export route
// (events/export-route.ts), using the same in-process delegation as the
// external /files and /cells reads: authenticate the credential, check its
// org/project scope, resolve the caller's LIVE project role, mint a 30-second
// internal sync-token carrying THAT role, and hand the request to
// handleExportSourceRequest. Delegating rather than re-querying means:
//   - one implementation of round-trip fidelity (USFM lossless substitution,
//     R2/legacy blob resolution, raw-original fallbacks) — no second copy to
//     drift, and
//   - the org export floor (AQU-253 `resolveExportFloor`, default MAINTAINER)
//     is enforced for agents exactly as for humans. An agent can never pull a
//     deliverable a person with the same role could not.
//
// AQU-1454: `side` picks WHICH side of the file comes back, and the caller
// always picks — a response never carries both. `side=source` returns the
// curated source (source edits applied, hidden and deleted verses gone, added
// cells' source text in place, no translation anywhere), byte-identical to the
// in-app "Export source (.SFM)" download because it reaches the same internal
// route with the same `?side=source`. Absent or `side=target` is exactly
// today's translation round-trip for the requested lane. Any other value is a
// 400 naming the two accepted ones, so a typo can never silently deliver the
// side the caller did not ask for.
//
// Response: the reconstructed file bytes as-is, with the internal route's
// Content-Type / Content-Disposition and its two fidelity headers passed
// through — `X-Export-Mode: raw-sidecar|raw-original` (bytes preserved, no
// translations injected) and `X-Usfm-Lossy-Verse-Count` (0 = clean round-trip).
// Errors use the standard external envelope { error: { code, message } }.

import { externalError } from './errors'
import { mintInternalToken } from './read-routes'
import { authenticateAndScope, type ExternalReadsEnv } from './read-auth'
import { handleExportSourceRequest } from '../events/export-route'
import { countRecentRateLimitEvents, recordRateLimitEvent } from '../../../db/shared/rate-limit'

export type ExternalExportEnv = ExternalReadsEnv & { SNAPSHOTS: R2Bucket }

const FILE_EXPORT_RE = /^\/api\/v1\/external\/projects\/([^/]+)\/files\/([^/]+)\/export$/

// An export streams a whole file out of R2 and re-serializes it, so it belongs
// with the heavy R2-egress operations (artifact upload / artifact content,
// 120 per 15 minutes per credential) rather than with the cheap paginated
// reads at 300. Same reasoning as the 2026-08-20 pen-test pass that throttled
// artifact content: the expensive thing here is bytes leaving storage.
const EXPORT_MAX_PER_CREDENTIAL = 120

/** Fidelity/annotation headers the internal route sets — forwarded verbatim so
 *  an agent can tell a clean round-trip from a preserved-original fallback. */
const PASSTHROUGH_HEADERS = [
  'Content-Type',
  'Content-Disposition',
  'X-Export-Mode',
  'X-Usfm-Lossy-Verse-Count',
  // AQU-1454: `source` on a source-side body, absent on a target-side one —
  // the agent's proof that it received the side it asked for.
  'X-Export-Side',
] as const

/** AQU-1454: the only two sides a caller may ask for. */
const EXPORT_SIDES = ['source', 'target'] as const

/** Map the internal route's plain-text failures onto the stable external error
 *  codes. The internal messages are already actionable ("re-import to enable
 *  export", "export not yet supported for format …") so they are preserved. */
async function mapInternalFailure(res: Response): Promise<Response> {
  const message = (await res.text()).trim() || 'export failed'
  if (res.status === 403) return externalError('permission_denied', message, 403)
  if (res.status === 404) return externalError('not_found', message, 404)
  // 501 = a format whose target serializer does not exist server-side. It is a
  // property of the request (this file's format), not a server fault, so it
  // maps to validation_failed like the import side's unsupported formats.
  if (res.status === 501) return externalError('validation_failed', message, 400)
  if (res.status === 400) return externalError('validation_failed', message, 400)
  return externalError('job_failed', message, 500)
}

export async function handleExternalExportRequest(
  request: Request,
  env: ExternalExportEnv,
): Promise<Response | null> {
  const url = new URL(request.url)
  const match = FILE_EXPORT_RE.exec(url.pathname)
  if (!match) return null
  if (request.method !== 'GET') {
    return externalError(
      'validation_failed',
      `use GET ${url.pathname} to export a file`,
      405,
    )
  }

  const projectId = decodeURIComponent(match[1])
  const fileId = decodeURIComponent(match[2])

  const authed = await authenticateAndScope(request, env, projectId)
  if (!authed.ok) return authed.response

  // AQU-1454: validate the side BEFORE the rate-limit bookkeeping — a request
  // that names a side that does not exist never reaches storage, so it should
  // not spend the credential's export budget either.
  const sideParam = url.searchParams.get('side')
  if (sideParam !== null && !(EXPORT_SIDES as readonly string[]).includes(sideParam)) {
    return externalError(
      'validation_failed',
      `side must be one of ${EXPORT_SIDES.map((s) => `"${s}"`).join(' or ')} ` +
        `(got "${sideParam}") — one export returns one side, never both`,
      400,
    )
  }
  const sourceSide = sideParam === 'source'

  if (env.AQUILLA_PG) {
    const identifier = `credential:${authed.ctx.credential.credentialId}`
    const recent = await countRecentRateLimitEvents(env.AQUILLA_PG, 'external_export', identifier)
    if (recent >= EXPORT_MAX_PER_CREDENTIAL) {
      return externalError('rate_limited', 'export rate limit exceeded, slow down', 429)
    }
    await recordRateLimitEvent(env.AQUILLA_PG, 'external_export', identifier)
  }

  // AQU-538: exports are lane-specific; an omitted lane means the default lane.
  const lane = url.searchParams.get('lane')

  const token = await mintInternalToken(env, authed.ctx, projectId, fileId)
  const internalUrl = new URL(request.url)
  internalUrl.pathname = `/api/v1/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}/source`
  // The source side has no lane — one curated source serves every target
  // language — so a lane sent alongside it is dropped rather than forwarded,
  // which keeps the target-side query string byte-identical to today's.
  internalUrl.search = sourceSide
    ? '?side=source'
    : lane === null
      ? ''
      : `?lane=${encodeURIComponent(lane)}`

  const internalRes = await handleExportSourceRequest(
    new Request(internalUrl.toString(), { headers: { Authorization: `Bearer ${token}` } }),
    env,
  )
  if (!internalRes) return externalError('not_found', 'export route did not match', 404)
  if (!internalRes.ok) return mapInternalFailure(internalRes)

  const headers = new Headers()
  for (const name of PASSTHROUGH_HEADERS) {
    const value = internalRes.headers.get(name)
    if (value !== null) headers.set(name, value)
  }
  return new Response(internalRes.body, { status: 200, headers })
}
