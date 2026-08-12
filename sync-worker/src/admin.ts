// Admin HTTP endpoint for R2 cleanup after a file is deleted from codex-db.
// Exported as a standalone function so it can be unit-tested without pulling
// the partyserver import graph (which references cloudflare:* URLs Node
// doesn't resolve).

import { secureCompare as constantTimeEqual } from "./lib/secure-compare"

export interface AdminEnv {
  SNAPSHOTS: R2Bucket
  /**
   * Dedicated admin bearer. Preferred over SYNC_SECRET_KEY; see
   * `adminCredential` for the migration ordering.
   */
  ADMIN_SECRET?: string
  SYNC_SECRET_KEY?: string
  R2_KEY_PREFIX?: string
}

/**
 * Which secret guards `/admin/*`, and why there are two.
 *
 * `SYNC_SECRET_KEY` is the *token-signing key*: anything holding it can mint a
 * sync token for any project. Accepting it as a plaintext bearer means every
 * ops invocation of an admin route puts that key into shell history, terminal
 * scrollback, and any intermediary's request log — a single careless paste is
 * a full compromise of the trust tree. That is OPS-2 of
 * docs/OPSEC-REVIEW-2026-08-10.md, and it is a secrets-provisioning problem
 * rather than a code bug: the code would be fine if the value were dedicated.
 *
 * So this prefers `ADMIN_SECRET` and falls back to `SYNC_SECRET_KEY` when it
 * is unbound. The fallback is what makes the change deployable unattended —
 * flipping the check over outright would 401 every admin call in any
 * environment where the new secret had not been provisioned yet, i.e. lock ops
 * out of the routes they would need to fix it. The intended order is:
 *
 *   1. deploy this (both accepted; nothing breaks),
 *   2. `wrangler secret put ADMIN_SECRET` per environment,
 *   3. cut callers over,
 *   4. delete the fallback branch below — at which point the signing key stops
 *      being an admin credential.
 *
 * Until step 4 the exposure is unchanged; what this buys is that step 2 can
 * happen whenever an operator gets to it, without a coordinated deploy.
 */
export function adminCredential(
  env: Pick<AdminEnv, "ADMIN_SECRET" | "SYNC_SECRET_KEY">,
): { secret: string; source: "admin-secret" | "sync-secret-key-fallback" } | null {
  // ADMIN_SECRET is trimmed so an unset-but-present secret ("" or whitespace,
  // which is how a cleared Cloudflare secret can surface) does not shadow the
  // fallback and lock ops out of the routes they would use to fix it.
  const dedicated = env.ADMIN_SECRET?.trim()
  if (dedicated) return { secret: dedicated, source: "admin-secret" }
  // SYNC_SECRET_KEY is deliberately NOT trimmed: it is compared against a
  // bearer that auth-worker builds from its own copy of the same value,
  // untrimmed. Trimming on one side only would 401 every call if the secret
  // ever carried stray whitespace. This preserves the pre-ADMIN_SECRET
  // behaviour exactly, which is the point of a fallback.
  if (env.SYNC_SECRET_KEY) {
    return { secret: env.SYNC_SECRET_KEY, source: "sync-secret-key-fallback" }
  }
  return null
}

function r2KeyPrefix(env: Pick<AdminEnv, "R2_KEY_PREFIX">): string {
  const p = env.R2_KEY_PREFIX?.trim().replace(/^\/+|\/+$/g, "") ?? ""
  return p ? `${p}/` : ""
}

/**
 * Handles DELETE /admin/files/:projectId/:fileId. Returns null when the path
 * isn't an admin route so the caller can fall through to partyserver.
 *
 * Auth: `Authorization: Bearer ${ADMIN_SECRET}`, falling back to
 * `SYNC_SECRET_KEY` while that secret is still being provisioned. See
 * `adminCredential` for why both are accepted and how the fallback retires.
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
  const credential = adminCredential(env)
  if (!credential || !constantTimeEqual(auth, `Bearer ${credential.secret}`)) {
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
