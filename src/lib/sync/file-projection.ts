// Best-effort notification to auth-worker that a file has been removed
// from a project, so its projection rows in codex-db (files + cells + FTS)
// get cleaned up. Kept out of ProjectWorkspace so it can be unit-tested
// cheaply and reused by any future file-management surface.

import { FRONTIER_API_URL } from "./sync-token"

export interface DeleteFileProjectionOptions {
  jwt: string | null
  projectId: string
  fileId: string
  apiUrl?: string
}

/**
 * Fires and forgets. Returns true on 2xx, false on anything else (including
 * a missing jwt, which means the user isn't authenticated and we never tried
 * — the D1 rows remain, but local delete already succeeded so the user's
 * editor is consistent). Callers should not block on this result.
 */
export async function deleteFileProjection(
  opts: DeleteFileProjectionOptions
): Promise<boolean> {
  if (!opts.jwt) return false
  const apiUrl = opts.apiUrl ?? FRONTIER_API_URL
  const url = `${apiUrl}/api/v2/projects/${encodeURIComponent(opts.projectId)}/files/${encodeURIComponent(opts.fileId)}`
  try {
    const res = await fetch(url, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${opts.jwt}` },
    })
    if (!res.ok) {
      console.warn(
        `[file-projection] DELETE ${opts.projectId}/${opts.fileId} → HTTP ${res.status}`
      )
      return false
    }
    return true
  } catch (err) {
    console.warn("[file-projection] DELETE failed:", err)
    return false
  }
}
