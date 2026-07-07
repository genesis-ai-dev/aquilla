// FRO-346: best-effort notification to aquilla-sync-worker when a project
// member is removed, so the per-project ProjectSync DO can eject the removed
// user's live WebSocket sessions and denylist their still-valid (≤15 min)
// sync tokens.
//
// Best-effort by contract: the hard revocation guarantees live elsewhere
// (sync-token mint re-resolves the role; the sync-worker's POST /events
// re-checks membership per flush). This call only accelerates the live
// session's eject, so a failure must never block or fail the removal itself.
// Mirrors notifySyncWorkerOfArchive in routes/projects.ts.

import type { Env } from "../types"

export async function notifySyncWorkerOfMemberRemoval(
  env: Pick<Env, "SYNC_WORKER_URL" | "SYNC_SECRET_KEY">,
  projectId: string,
  removed: { userId: number; username?: string },
): Promise<void> {
  if (!env.SYNC_WORKER_URL || !env.SYNC_SECRET_KEY) return
  try {
    await fetch(
      `${env.SYNC_WORKER_URL.replace(/\/$/, "")}/admin/projects/${encodeURIComponent(projectId)}/member-removed`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.SYNC_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          userId: removed.userId,
          ...(removed.username ? { username: removed.username } : {}),
        }),
      },
    )
  } catch (err) {
    console.warn(
      `sync-worker member-removed notification failed for ${projectId}/${removed.userId}:`,
      err,
    )
  }
}
