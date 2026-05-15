// Hot-apply helper (legacy). Originally posted a `cell.commit` payload to
// the live DO so freshly-imported cells appeared in any open editor without
// a reload. Under AD-2 the durable record is the event log and clients
// rebuild from the projection; the hot-apply DO push is no longer wired
// into the events route. The module remains so external callers (e.g.
// future tooling) have a shim, but it currently no-ops.

import type { Server } from 'partyserver'
import { getServerByName } from 'partyserver'

export interface ApplyEventEnv {
  FileSync: DurableObjectNamespace
  SYNC_SECRET_KEY?: string
}

export interface ApplyEventInput {
  projectId: string
  fileId: string
  cellId: string
  payload: { value: string; valueHtml?: string }
}

/**
 * Send a cell-commit payload to the live DO. No-op when the DO is
 * unavailable or env is unconfigured; failures are logged but never thrown
 * so the caller can await alongside broadcasts.
 */
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
        kind: 'target.cell.commit',
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
