// GET /api/v1/projects/:projectId/files/:fileId/removed-cells
//
// AQU-1068: which source cells has this file lost, and where did each one sit?
//
// The docx and pptx exporters run in the BROWSER — they fetch the client's
// original package from R2 and patch translations into it — so unlike the USFM
// exporter they cannot reach the event log themselves. Without this route they
// have no way to tell a removed paragraph from an untranslated one, because
// both are simply absent from the cell list, and every removal is silently
// undone at export.
//
// Returns each removed cell's create-time `metadata` verbatim. Decoding the
// package locator out of it (`aquillaImport.sourceLocator`) is the client's
// job and stays in src/lib/export/import-locators.ts, where that shape is
// already defined — the server has no business knowing what a docx paragraph
// path looks like.
//
// Auth is token-valid-for-project with no role floor, matching
// cell-history-read-route.ts, which exposes strictly more (whole event
// payloads for a cell that still exists).

import { verifyTokenForProject } from "../auth"
import { withCors } from "../cors"
import { removedCellsForFile } from "./removed-cells"

export interface RemovedCellsReadEnv {
  AQUILLA_PG?: AquillaDb
  SYNC_SECRET_KEY?: string
}

const PATH_RE = /^\/api\/v1\/projects\/([^/]+)\/files\/([^/]+)\/removed-cells$/

export async function handleRemovedCellsReadRequest(
  request: Request,
  env: RemovedCellsReadEnv,
): Promise<Response | null> {
  const url = new URL(request.url)
  const match = PATH_RE.exec(url.pathname)
  if (!match) return null
  if (request.method !== "GET") return null

  if (!env.SYNC_SECRET_KEY) {
    return withCors(new Response("SYNC_SECRET_KEY not configured", { status: 500 }), request)
  }
  if (!env.AQUILLA_PG) {
    return withCors(new Response("AQUILLA_PG binding not configured", { status: 500 }), request)
  }

  const projectId = decodeURIComponent(match[1])
  const fileId = decodeURIComponent(match[2])

  const authHeader = request.headers.get("Authorization") ?? ""
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null
  const auth = await verifyTokenForProject(token, projectId, env.SYNC_SECRET_KEY)
  if (!auth.ok) {
    return withCors(new Response(auth.reason, { status: auth.status }), request)
  }

  const removed = await removedCellsForFile(env.AQUILLA_PG, projectId, fileId)

  return withCors(
    new Response(JSON.stringify({ removed }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
    request,
  )
}
