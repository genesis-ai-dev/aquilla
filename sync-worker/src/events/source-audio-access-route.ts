// GET /api/v1/projects/:projectId/source-audio-access
//
// AQU-2682: { coversEveryLanguage } for the token's holder on this project.
// The app asks before it offers "Upload a recording to make lines" or
// attaching a film or recording by url: both store the file's source audio,
// which the events route refuses from someone whose access does not cover
// every language. Without this the app offered them to every Project Lead,
// and one limited to some languages was left with lines and no audio.
//
// The answer is `coversEveryLanguage` from source-audio-access.ts, the rule
// authorize() applies, read from the same token claims the events route will
// see. Auth: a sync token for this project, any role (it describes only the
// caller's own access).

import { verifyTokenForProject } from '../auth'
import { laneReadWallEnabled } from '../../../src/lib/lanes/write-wall'
import { loadTargetLanes } from './lane-read-wall'
import { requiredRoleFor } from './role-policy'
import { coversEveryLanguage } from './source-audio-access'

export interface SourceAudioAccessEnv {
  AQUILLA_PG?: AquillaDb
  SYNC_SECRET_KEY?: string
  LANE_READ_WALL?: string
}

const PATH_RE = /^\/api\/v1\/projects\/([^/]+)\/source-audio-access$/

export async function handleSourceAudioAccessRequest(
  request: Request,
  env: SourceAudioAccessEnv,
): Promise<Response | null> {
  const match = PATH_RE.exec(new URL(request.url).pathname)
  if (!match || request.method !== 'GET') return null

  if (!env.SYNC_SECRET_KEY) return new Response('SYNC_SECRET_KEY not configured', { status: 500 })
  if (!env.AQUILLA_PG) return new Response('AQUILLA_PG binding not configured', { status: 500 })
  const db = env.AQUILLA_PG

  const projectId = decodeURIComponent(match[1]!)
  const authHeader = request.headers.get('Authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  const auth = await verifyTokenForProject(token, projectId, env.SYNC_SECRET_KEY)
  if (!auth.ok) return new Response(auth.reason, { status: auth.status })

  const covers = await coversEveryLanguage({
    wallOn: laneReadWallEnabled(env.LANE_READ_WALL),
    claims: auth.claims,
    requiredRole: requiredRoleFor('cell.audio.attach'),
    loadLanes: () => loadTargetLanes(db, projectId),
  })
  return new Response(JSON.stringify({ coversEveryLanguage: covers }), {
    status: 200,
    // Grants change; the app re-asks rather than trusting a cached yes.
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}
