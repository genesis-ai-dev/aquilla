// Sends a cell.commit payload to the live FileSync DO so it can apply the
// event to its in-memory Y.Doc. Companion to broadcastRealtime: realtime is
// for client cache invalidation, applyEvent is for server-side Y.Doc state.
//
// Used after a successful POST /events D1 commit so cells imported via the
// CQRS route appear in any currently-open editor without a reload. Mode is
// `new-only` on the DO side so existing cells (with active edits) aren't
// clobbered — see hydrate.ts.
//
// Failure is non-fatal: if the DO is unavailable the cells still land in
// D1, and the next time anyone opens the project the hydrate path or a
// fresh DO load will pick them up. Mirrors broadcastRealtime's no-throw
// contract so route.ts's `await Promise.all(...)` is safe.

import type { Server } from 'partyserver'
import { getServerByName } from 'partyserver'
import type { CellCommitPayload } from './hydrate'

export interface ApplyEventEnv {
  FileSync: DurableObjectNamespace
  SYNC_SECRET_KEY?: string
}

export interface ApplyEventInput {
  projectId: string
  fileId: string
  cellId: string
  payload: CellCommitPayload
}

export async function applyEventToLiveDoc(
  env: ApplyEventEnv,
  input: ApplyEventInput,
): Promise<void> {
  if (!env.SYNC_SECRET_KEY) {
    console.warn('[applyEventToLiveDoc] SYNC_SECRET_KEY not configured, skipping')
    return
  }
  const docName = `${input.projectId}--${input.fileId}`
  try {
    const stub = await getServerByName(
      env.FileSync as unknown as DurableObjectNamespace<Server>,
      docName,
    )
    const res = await stub.fetch('http://do.internal/__apply-event', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.SYNC_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        kind: 'cell.commit',
        cellId: input.cellId,
        payload: input.payload,
      }),
    })
    if (!res.ok) {
      console.warn(
        `[applyEventToLiveDoc] DO returned HTTP ${res.status} for docName=${docName}`,
      )
    }
  } catch (err) {
    console.warn(`[applyEventToLiveDoc] failed to reach DO for docName=${docName}:`, err)
  }
}
