// Admin HTTP endpoint for R2 cleanup after a file is deleted from codex-db.
// Exported as a standalone function so it can be unit-tested without pulling
// the partyserver import graph (which references cloudflare:* URLs Node
// doesn't resolve).

export interface AdminEnv {
  SNAPSHOTS: R2Bucket
  SYNC_SECRET_KEY?: string
}

/**
 * Handles DELETE /admin/files/:projectId/:fileId. Returns null when the path
 * isn't an admin route so the caller can fall through to partyserver.
 *
 * Auth: Authorization: Bearer ${SYNC_SECRET_KEY}. Reuses the JWT-signing
 * secret as a shared admin key — only frontier-server (which already holds
 * SYNC_SECRET_KEY for token signing) can call this.
 */
export async function handleAdminRequest(
  request: Request,
  env: AdminEnv
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!url.pathname.startsWith("/admin/")) return null
  if (request.method !== "DELETE") {
    return new Response("method not allowed", { status: 405 })
  }

  const auth = request.headers.get("Authorization") ?? ""
  const expected = env.SYNC_SECRET_KEY ? `Bearer ${env.SYNC_SECRET_KEY}` : null
  if (!expected || auth !== expected) {
    return new Response("unauthorized", { status: 401 })
  }

  const match = url.pathname.match(/^\/admin\/files\/([^/]+)\/([^/]+)$/)
  if (!match) return new Response("not found", { status: 404 })
  const projectId = decodeURIComponent(match[1])
  const fileId = decodeURIComponent(match[2])

  // Enumerate every object under projects/{pid}/files/{fid}/ so snapshot,
  // tails, and checkpoints all disappear in one call. list() paginates at
  // 1000 keys by default — loop with cursor until drained.
  const prefix = `projects/${projectId}/files/${fileId}/`
  const allKeys: string[] = []
  let cursor: string | undefined = undefined
  do {
    const page = await env.SNAPSHOTS.list({ prefix, cursor })
    for (const obj of page.objects) allKeys.push(obj.key)
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)

  if (allKeys.length === 0) {
    return Response.json({ ok: true, deleted: 0 })
  }

  // R2 delete() per-call key limit is 1000. Chunk to stay under it.
  const CHUNK = 1000
  for (let i = 0; i < allKeys.length; i += CHUNK) {
    await env.SNAPSHOTS.delete(allKeys.slice(i, i + CHUNK))
  }

  return Response.json({ ok: true, deleted: allKeys.length })
}
