// Admin HTTP endpoint for R2 cleanup after a file is deleted from codex-db.
// Exported as a standalone function so it can be unit-tested without pulling
// the partyserver import graph (which references cloudflare:* URLs Node
// doesn't resolve).

import { adminBearerMatches } from "./lib/admin-secret"

export interface AdminEnv {
  SNAPSHOTS: R2Bucket
  /**
   * Dedicated admin bearer. Preferred over SYNC_SECRET_KEY — see the auth note
   * on handleAdminRequest. Provision with `wrangler secret put ADMIN_SECRET`.
   */
  ADMIN_SECRET?: string
  SYNC_SECRET_KEY?: string
  R2_KEY_PREFIX?: string
}

function r2KeyPrefix(env: Pick<AdminEnv, "R2_KEY_PREFIX">): string {
  const p = env.R2_KEY_PREFIX?.trim().replace(/^\/+|\/+$/g, "") ?? ""
  return p ? `${p}/` : ""
}

/**
 * Handles DELETE /admin/files/:projectId/:fileId. Returns null when the path
 * isn't an admin route so the caller can fall through to partyserver.
 *
 * Auth: `Authorization: Bearer ${ADMIN_SECRET}`.
 *
 * OPS-2: this route historically accepted `SYNC_SECRET_KEY` — the JWT *signing*
 * key — as its bearer. That works, but it means every ad-hoc admin call puts a
 * key that can mint sync tokens for any project into shell history, terminal
 * scrollback, and any proxy's logs. `ADMIN_SECRET` is a dedicated credential
 * whose whole blast radius is these two R2 routes.
 *
 * `SYNC_SECRET_KEY` is still accepted as a fallback, and ONLY when
 * `ADMIN_SECRET` is unset, so an environment that has not been provisioned yet
 * keeps working and the rollout can be done one environment at a time without
 * locking ops out. Once `ADMIN_SECRET` is set everywhere, delete the fallback
 * branch and drop `SYNC_SECRET_KEY` from AdminEnv — at that point a signing key
 * presented here is rejected, which is the actual goal.
 */
export async function handleAdminRequest(
  request: Request,
  env: AdminEnv
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!url.pathname.startsWith("/admin/")) return null

  // Match path BEFORE checking method so we return 405 (not 404) for a
  // recognized resource hit with the wrong method.
  const inspectMatch = url.pathname.match(/^\/admin\/files\/([^/]+)\/([^/]+)\/inspect$/)
  const fileMatch = url.pathname.match(/^\/admin\/files\/([^/]+)\/([^/]+)$/)
  if (!inspectMatch && !fileMatch) return new Response("not found", { status: 404 })

  // Auth gate applies to every recognized admin route.
  const auth = request.headers.get("Authorization") ?? ""
  if (!adminBearerMatches(auth, env)) {
    return new Response("unauthorized", { status: 401 })
  }

  // GET /admin/files/:projectId/:fileId/inspect — returns counts and sizes
  // for the file's R2 keys. Read-only; useful for diagnosing OOMs from the
  // command line without needing the R2 list CLI.
  if (inspectMatch) {
    if (request.method !== "GET") return new Response("method not allowed", { status: 405 })
    const projectId = decodeURIComponent(inspectMatch[1])
    const fileId = decodeURIComponent(inspectMatch[2])
    const prefix = `${r2KeyPrefix(env)}projects/${projectId}/files/${fileId}/`
    const objects: Array<{ key: string; size: number }> = []
    let cursor: string | undefined = undefined
    do {
      const page = await env.SNAPSHOTS.list({ prefix, cursor })
      for (const obj of page.objects) objects.push({ key: obj.key, size: obj.size })
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor)
    let tailCount = 0
    let tailBytes = 0
    let tailMaxBytes = 0
    let otherCount = 0
    let otherBytes = 0
    for (const o of objects) {
      const tail = `${prefix}tail/`
      if (o.key.startsWith(tail)) {
        tailCount++
        tailBytes += o.size
        if (o.size > tailMaxBytes) tailMaxBytes = o.size
      } else {
        otherCount++
        otherBytes += o.size
      }
    }
    return Response.json({
      ok: true,
      prefix,
      tail: { count: tailCount, totalBytes: tailBytes, maxBytes: tailMaxBytes },
      other: { count: otherCount, totalBytes: otherBytes },
      total: objects.length,
    })
  }

  // DELETE /admin/files/:projectId/:fileId — wipe all R2 objects for the file.
  if (request.method !== "DELETE") return new Response("method not allowed", { status: 405 })
  const match = fileMatch!
  const projectId = decodeURIComponent(match[1])
  const fileId = decodeURIComponent(match[2])

  // Enumerate every object under projects/{pid}/files/{fid}/ so tails,
  // checkpoints, and per-cell audio all disappear in one call.
  // list() paginates at 1000 keys by default — loop with cursor until drained.
  const prefix = `${r2KeyPrefix(env)}projects/${projectId}/files/${fileId}/`
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
