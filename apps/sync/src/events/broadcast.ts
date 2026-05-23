// broadcastRealtime: sends a RealtimeMessage to all WS connections on a
// project's ProjectSync DO via its /__broadcast endpoint.
//
// Kept in its own module (same pattern as archive-broadcast.ts) so the route
// handler stays pure and unit-testable without a DO runtime.

// NOTE: This is a non-throwing helper, in contrast to notifyProjectDo in
// archive-broadcast.ts which throws on DO failure. Realtime invalidation
// is best-effort — clients also poll for missed events as a safety net.

import type { RealtimeMessage } from "./realtime"
import type { ProjectDoServerMessage } from "../project-do-handlers"

export interface BroadcastEnv {
  ProjectSync: DurableObjectNamespace
  SYNC_SECRET_KEY?: string
}

/**
 * Send a Realtime message to all WS connections on a project's DO.
 *
 * The route handler calls this once per accepted event. Projection-dirty
 * invalidation is intentionally not a separate wire frame anymore: clients
 * revalidate the active projected reads on `event.applied`, and polling
 * remains the safety net for missed frames.
 *
 * Failures are non-fatal: if the DO is unavailable, log and continue.
 * Clients also poll periodically as a safety net (Phase 1 outbox plan).
 */
export async function broadcastRealtime(
  env: BroadcastEnv,
  message: RealtimeMessage,
): Promise<void> {
  if (message.t !== "event") {
    return
  }

  if (!env.SYNC_SECRET_KEY) {
    console.warn("[broadcastRealtime] SYNC_SECRET_KEY not configured, skipping broadcast")
    return
  }

  const body: ProjectDoServerMessage = {
    t: "event.applied",
    id: message.id,
    kind: message.kind,
    project: message.project,
    ...(message.file ? { file: message.file } : {}),
    ...(message.cell ? { cell: message.cell } : {}),
    ...(message.by ? { by: message.by } : {}),
  }

  try {
    const id = env.ProjectSync.idFromName(message.project)
    const stub = env.ProjectSync.get(id)
    const res = await stub.fetch("http://do.internal/__broadcast", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.SYNC_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      console.warn(
        `[broadcastRealtime] ProjectSync returned HTTP ${res.status} for project=${message.project}`,
      )
    }
  } catch (err) {
    console.warn(`[broadcastRealtime] failed to reach ProjectSync for project=${message.project}:`, err)
  }
}
