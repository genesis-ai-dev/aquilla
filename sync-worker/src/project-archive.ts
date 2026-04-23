// Admin handler for project-level archive notifications. Called by
// frontier-server after it flips projects.archived_at so live sync-worker
// DOs can inject the tombstone into their in-memory Y.Docs (observed by
// connected clients as a Y-update in milliseconds).
//
// Two durable side effects:
//   1. An R2 marker at projects/{projectId}/archive.json so cold DOs
//      reconstruct the tombstone on next onLoad.
//   2. Broadcast to each active file DO via its onRequest handler so its
//      in-memory `meta` Y.Map reflects the flag immediately.
//
// Auth: Bearer ${SYNC_SECRET_KEY}, same as /admin/files/*.

export interface ProjectArchiveEnv {
  FileSync: DurableObjectNamespace
  SNAPSHOTS: R2Bucket
  SYNC_SECRET_KEY?: string
}

export interface ArchiveMarker {
  archivedAt: string | null
  deletedBy: string | null
}

function archiveMarkerKey(projectId: string): string {
  return `projects/${projectId}/archive.json`
}

/** Broadcast hook — overridable in tests so we don't need a DO runtime. */
export type FileBroadcaster = (
  env: ProjectArchiveEnv,
  projectId: string,
  fileId: string,
  marker: ArchiveMarker
) => Promise<void>

/**
 * Handles POST /admin/projects/:projectId/archive. Returns null when the
 * path isn't a project-archive route so the caller can fall through.
 *
 * The broadcast function is mandatory — the real sync-worker supplies one
 * that uses `getServerByName` (see archive-broadcast.ts). Tests supply a
 * stub so they don't need to import the partyserver runtime.
 */
export async function handleProjectArchiveRequest(
  request: Request,
  env: ProjectArchiveEnv,
  broadcastFn: FileBroadcaster
): Promise<Response | null> {
  const url = new URL(request.url)
  const match = url.pathname.match(/^\/admin\/projects\/([^/]+)\/archive$/)
  if (!match) return null
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405 })
  }

  const auth = request.headers.get("Authorization") ?? ""
  const expected = env.SYNC_SECRET_KEY ? `Bearer ${env.SYNC_SECRET_KEY}` : null
  if (!expected || auth !== expected) {
    return new Response("unauthorized", { status: 401 })
  }

  const projectId = decodeURIComponent(match[1])
  let body: ArchiveMarker
  try {
    body = (await request.json()) as ArchiveMarker
  } catch {
    return new Response("bad request", { status: 400 })
  }

  // Persist a marker so cold-started DOs (after hibernation / eviction)
  // reconstruct the tombstone in onLoad. Omit entirely when unarchiving.
  if (body.archivedAt) {
    await env.SNAPSHOTS.put(archiveMarkerKey(projectId), JSON.stringify(body))
  } else {
    await env.SNAPSHOTS.delete(archiveMarkerKey(projectId))
  }

  // Enumerate every file we've ever persisted under this project — each
  // file has a DO that may be holding a live client. We wake each stub
  // and let it decide whether anyone is connected.
  const filePrefix = `projects/${projectId}/files/`
  const fileIds = new Set<string>()
  let cursor: string | undefined = undefined
  do {
    const page = await env.SNAPSHOTS.list({ prefix: filePrefix, cursor, delimiter: "/" })
    for (const prefix of page.delimitedPrefixes ?? []) {
      // prefix looks like "projects/{pid}/files/{fid}/"
      const parts = prefix.split("/")
      if (parts.length >= 4 && parts[3]) fileIds.add(parts[3])
    }
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)

  // Broadcast to each file DO. Failures are logged but don't fail the
  // request — the R2 marker guarantees eventual consistency on next load.
  const broadcasts: Promise<void>[] = []
  for (const fileId of fileIds) {
    broadcasts.push(
      broadcastFn(env, projectId, fileId, body).catch((err) => {
        console.warn(
          `[project-archive] DO notify failed for ${projectId}/${fileId}:`,
          err
        )
      })
    )
  }
  await Promise.all(broadcasts)

  return Response.json({ ok: true, fileCount: fileIds.size })
}

/**
 * Reads the current archive marker for a project, if any. Called by
 * FileSync.onLoad so cold DOs seed their Y.Doc with the tombstone before
 * serving any client.
 */
export async function readArchiveMarker(
  bucket: R2Bucket,
  projectId: string
): Promise<ArchiveMarker | null> {
  const obj = await bucket.get(archiveMarkerKey(projectId))
  if (!obj) return null
  try {
    return (await obj.json()) as ArchiveMarker
  } catch {
    return null
  }
}
