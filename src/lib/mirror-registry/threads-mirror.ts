/**
 * Mirror: Y.Doc cell.threads (Y.Array of Y.Map) → local-store
 * `threads` + `thread_messages` rows, with outbox emission for the
 * cell-keyed conflict policies in DATA_PERSISTENCE_PLAN.md §9.2:
 *
 *   thread.create   — server-assigned id, additive, accept always
 *   thread.append   — additive, version-irrelevant, accept always
 *   thread.resolve  — LWW on state, accept always
 *
 * Bootstrap enumerates all cells with threads and copies their state
 * into local-store; idempotent thanks to INSERT OR REPLACE upserts and
 * a per-row diff guard before outbox emission.
 *
 * Observation strategy: observeDeep on the cells map. On any change,
 * the affected cell ids are derived from event.path (`path[0]` = cellId
 * for nested events). For each dirty cell, we re-walk its threads and
 * diff against local-store state. Newly seen threads/messages emit
 * create/append outbox records; status transitions emit resolve.
 */

import * as Y from "yjs"
import {
  enqueueOutboxRecord,
  getMessagesByThread,
  getThread,
} from "@/lib/local-store"
import {
  appendThreadMessage,
  resolveThreadStatus,
  upsertThread,
  type ThreadMessageRow,
  type ThreadRow,
} from "@/lib/local-store/threads"
import type { Mirror, MirrorContext } from "./registry"

interface LegacyMessage {
  id: string
  author: string
  text: string
  timestamp: string
}

export interface ThreadsMirrorOptions {
  yDoc: Y.Doc
}

export function createThreadsMirror(opts: ThreadsMirrorOptions): Mirror {
  const { yDoc } = opts

  return {
    name: "threads",
    async bootstrap(ctx) {
      const cellsMap = yDoc.getMap("cells") as Y.Map<unknown>
      for (const cellId of cellsMap.keys()) {
        const yCell = cellsMap.get(cellId)
        if (yCell instanceof Y.Map) {
          await syncCellThreads(ctx, cellId, yCell, { silent: true })
        }
      }
    },
    attach(ctx) {
      const cellsMap = yDoc.getMap("cells") as Y.Map<unknown>
      const handler = (events: Array<Y.YEvent<Y.AbstractType<unknown>>>) => {
        const dirtyCells = new Set<string>()
        for (const event of events) {
          for (const key of event.changes.keys.keys()) {
            dirtyCells.add(key)
          }
          if (typeof event.path[0] === "string") {
            dirtyCells.add(event.path[0])
          }
        }
        for (const cellId of dirtyCells) {
          const yCell = cellsMap.get(cellId)
          if (yCell instanceof Y.Map) {
            void syncCellThreads(ctx, cellId, yCell, { silent: false })
          }
        }
      }
      cellsMap.observeDeep(handler)
      let disposed = false
      return () => {
        if (disposed) return
        disposed = true
        cellsMap.unobserveDeep(handler)
      }
    },
  }
}

async function syncCellThreads(
  ctx: MirrorContext,
  cellId: string,
  yCell: Y.Map<unknown>,
  opts: { silent: boolean },
): Promise<void> {
  const threadsArr = yCell.get("threads")
  if (!(threadsArr instanceof Y.Array)) return

  for (let i = 0; i < threadsArr.length; i++) {
    const yThread = threadsArr.get(i)
    if (!(yThread instanceof Y.Map)) continue
    await syncOneThread(ctx, cellId, yThread, opts)
  }
}

async function syncOneThread(
  ctx: MirrorContext,
  cellId: string,
  yThread: Y.Map<unknown>,
  opts: { silent: boolean },
): Promise<void> {
  const threadId = yThread.get("id") as string | undefined
  if (!threadId) return

  const status = (yThread.get("status") as string | undefined) ?? "open"
  const createdBy =
    (yThread.get("createdBy") as string | undefined) ?? "anonymous"
  const createdAt =
    parseTimestamp(yThread.get("createdAt")) ?? ctx.now()
  const resolvedBy =
    (yThread.get("resolvedBy") as string | undefined) ?? null
  const resolvedAt = parseTimestamp(yThread.get("resolvedAt"))

  const existing = await getThread(ctx.store, threadId)
  const isNewThread = existing === null
  const statusChanged =
    !isNewThread &&
    (existing.status !== status ||
      existing.resolved_by !== resolvedBy ||
      existing.resolved_at !== resolvedAt)

  const row: ThreadRow = {
    id: threadId,
    cell_id: cellId,
    status,
    created_by: createdBy,
    created_at: createdAt,
    resolved_by: resolvedBy,
    resolved_at: resolvedAt,
    seq: existing?.seq ?? 0,
  }
  await upsertThread(ctx.store, row)

  if (!opts.silent && isNewThread) {
    await enqueueOutboxRecord(ctx.store, {
      local_id: `thread.create:${threadId}`,
      project_id: projectIdFromCellId(cellId),
      endpoint: `/projects/${projectIdFromCellId(cellId)}/threads`,
      payload: JSON.stringify({
        kind: "thread.create",
        cell_id: cellId,
        id: threadId,
        created_by: createdBy,
        created_at: createdAt,
      }),
      expected_version: null,
      created_at: ctx.now(),
    })
  }
  if (
    !opts.silent &&
    !isNewThread &&
    statusChanged &&
    status === "resolved" &&
    existing
  ) {
    await enqueueOutboxRecord(ctx.store, {
      local_id: `thread.resolve:${threadId}@${ctx.now()}`,
      project_id: projectIdFromCellId(cellId),
      endpoint: `/projects/${projectIdFromCellId(cellId)}/threads/${threadId}/resolve`,
      payload: JSON.stringify({
        kind: "thread.resolve",
        thread_id: threadId,
        expected_state: existing.status,
        to_state: "resolved",
      }),
      expected_version: null,
      created_at: ctx.now(),
    })
  }

  // Messages: thread.create emits the empty thread shell; every message
  // (including the first) flows through thread.append. Cleaner contract
  // than embedding a body in thread.create.
  const yMessages =
    (yThread.get("messages") as LegacyMessage[] | undefined) ?? []
  const known = await getMessagesByThread(ctx.store, threadId)
  const knownIds = new Set(known.map((m) => m.id))
  for (const m of yMessages) {
    if (!m || !m.id) continue
    const wasKnown = knownIds.has(m.id)
    const row: ThreadMessageRow = {
      id: m.id,
      thread_id: threadId,
      author_id: m.author ?? "anonymous",
      body: m.text ?? "",
      created_at: parseTimestamp(m.timestamp) ?? ctx.now(),
      seq: 0,
    }
    await appendThreadMessage(ctx.store, row)

    if (!opts.silent && !wasKnown) {
      await enqueueOutboxRecord(ctx.store, {
        local_id: `thread.append:${m.id}`,
        project_id: projectIdFromCellId(cellId),
        endpoint: `/projects/${projectIdFromCellId(cellId)}/threads/${threadId}/messages`,
        payload: JSON.stringify({
          kind: "thread.append",
          thread_id: threadId,
          id: m.id,
          author_id: m.author ?? "anonymous",
          body: m.text ?? "",
          created_at: parseTimestamp(m.timestamp) ?? ctx.now(),
        }),
        expected_version: null,
        created_at: ctx.now(),
      })
    }
  }

  if (statusChanged && status === "resolved" && resolvedBy && resolvedAt) {
    await resolveThreadStatus(ctx.store, threadId, {
      resolved_by: resolvedBy,
      resolved_at: resolvedAt,
    })
  }
}

function parseTimestamp(v: unknown): number | null {
  if (typeof v === "number") return v
  if (typeof v !== "string" || !v) return null
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : null
}

function projectIdFromCellId(cellId: string): string {
  const idx = cellId.indexOf(":")
  return idx === -1 ? "unknown" : cellId.slice(0, idx)
}
