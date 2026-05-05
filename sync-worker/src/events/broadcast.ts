// broadcastRealtime: sends a RealtimeMessage to all WS connections on a
// given file's DO via the FileSync DO's /__broadcast endpoint.
//
// Kept in its own module (same pattern as archive-broadcast.ts) so the route
// handler stays pure and unit-testable without a DO runtime.

// NOTE: This is a non-throwing helper, in contrast to notifyFileDo in
// archive-broadcast.ts which throws on DO failure. Realtime invalidation
// is best-effort — clients also poll for missed events as a safety net.
// Archival tombstones need acknowledgment; Realtime fan-out does not.

import type { Server } from "partyserver"
import { getServerByName } from "partyserver"
import type { RealtimeMessage } from "./realtime"
import { serializeRealtimeMessage } from "./realtime"

export interface BroadcastEnv {
  FileSync: DurableObjectNamespace
  SYNC_SECRET_KEY?: string
}

/**
 * Send a Realtime message to all WS connections on a given file's DO.
 *
 * The route handler accumulates eventFrames + dirtyTables during a request
 * and calls broadcastRealtime once per (project, file, message) combo at
 * the end. The actual fan-out to WS connections happens inside the
 * FileSync DO's __broadcast endpoint via partyserver's broadcast API.
 *
 * Failures are non-fatal: if the DO is unavailable, log and continue.
 * Clients also poll periodically as a safety net (Phase 1 outbox plan).
 */
export async function broadcastRealtime(
  env: BroadcastEnv,
  message: RealtimeMessage,
): Promise<void> {
  // Need a file to route to a per-file DO.
  if (!("file" in message) || !message.file) {
    console.warn("[broadcastRealtime] skipping message without file:", message.t)
    return
  }

  if (!env.SYNC_SECRET_KEY) {
    console.warn("[broadcastRealtime] SYNC_SECRET_KEY not configured, skipping broadcast")
    return
  }

  const project = message.project
  const file = message.file
  const docName = `${project}--${file}`

  try {
    const stub = await getServerByName(
      env.FileSync as unknown as DurableObjectNamespace<Server>,
      docName,
    )
    const body = serializeRealtimeMessage(message)
    const res = await stub.fetch("http://do.internal/__broadcast", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.SYNC_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body,
    })
    if (!res.ok) {
      console.warn(
        `[broadcastRealtime] DO returned HTTP ${res.status} for docName=${docName}`,
      )
    }
  } catch (err) {
    console.warn(`[broadcastRealtime] failed to reach DO for docName=${docName}:`, err)
  }
}
