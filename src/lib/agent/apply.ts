/**
 * apply.ts — turn server-staged agent events into REAL events on the
 * existing client write path.
 *
 * Per the implementation plan: Apply builds real events (client-generated
 * UUIDv7 ids via enqueueEvent, author = current user, clientTs = now) from
 * StagedEvent fields and pushes them through the SAME outbox → POST /events
 * path normal edits use — `enqueueEvent` in src/lib/sync/events-emit.ts
 * (the layer under emitTargetCellCommit / useComments.addComment /
 * emitCellValidate). Payloads pass through VERBATIM so the server-injected
 * `ai_suggestion: true` and `agent_run_id` provenance fields survive.
 *
 * Flushing the outbox + revalidating projections stays with the caller
 * (ProjectWorkspace wires flushOutboxBatch/revalidateCell), matching how
 * commitCompletedCell sequences its writes.
 */

import { v7 as uuidv7 } from "uuid"
import { enqueueEvent } from "@/lib/sync/events-emit"
import type { OutboxPayloadFor } from "@/lib/sync/outbox-types"
import type { StagedEvent } from "./protocol"
import { isSupportedApplyKind } from "./role-floors"

/**
 * Sentinel fileId for project-scoped comment.* events.
 * Must match PROJECT_SENTINEL_FILE_ID in sync-worker/src/events/authorize.ts
 * (same constant useComments.ts uses).
 */
const PROJECT_SENTINEL_FILE_ID = "__project__"

export class UnsupportedAgentEventError extends Error {
  kind: string
  constructor(kind: string) {
    super(`agent apply: unsupported event kind "${kind}"`)
    this.kind = kind
    this.name = "UnsupportedAgentEventError"
  }
}

export interface ApplyContext {
  projectId: string
  /** Current user — the applied events are authored by the USER, not the agent. */
  author: string
  /**
   * Live cell lookup (useCells projection). When available, the cell's
   * current chain head wins over the staged parentId — the staged pin may
   * have gone stale between stage time and the Apply click. The server's
   * parent-chain guard remains authoritative either way.
   */
  resolveCell?: (cellId: string) => {
    targetEventId?: string
    sourceEventId?: string
  } | undefined
}

/**
 * Enqueue one staged event through the normal write path. Returns the
 * client-generated event id (the outbox handle / next chain parent).
 */
export async function applyStagedEvent(
  ev: StagedEvent,
  ctx: ApplyContext,
): Promise<string> {
  if (!isSupportedApplyKind(ev.kind)) throw new UnsupportedAgentEventError(ev.kind)

  switch (ev.kind) {
    case "target.cell.commit": {
      if (!ev.fileId || !ev.cellId) {
        throw new Error("agent apply: target.cell.commit needs fileId and cellId")
      }
      const live = ctx.resolveCell?.(ev.cellId)
      // Same precedence as the editor's commit paths (commitCompletedCell):
      // freshest known chain head → staged pin → source genesis fallback.
      const parentId =
        live?.targetEventId ?? ev.parentId ?? live?.sourceEventId ?? null
      const { eventId } = await enqueueEvent({
        kind: "target.cell.commit",
        projectId: ctx.projectId,
        fileId: ev.fileId,
        cellId: ev.cellId,
        parentId,
        author: ctx.author,
        // Verbatim passthrough: keeps ai_suggestion / agent_run_id /
        // sourceEventId exactly as the server staged them.
        payload: ev.payload as OutboxPayloadFor<"target.cell.commit">,
      })
      return eventId
    }

    case "comment.create": {
      // Server-staged payloads carry commentId/scope; tolerate omissions the
      // same way useComments builds them client-side. Computed fields go
      // AFTER the spread so an absent/empty key can't shadow the fallback.
      const payload = {
        parentCommentId: null,
        ...ev.payload,
        commentId:
          typeof ev.payload.commentId === "string" && ev.payload.commentId
            ? ev.payload.commentId
            : uuidv7(),
        scope:
          ev.payload.scope ??
          (ev.cellId && ev.fileId
            ? { kind: "cell", fileId: ev.fileId, cellId: ev.cellId }
            : ev.fileId
              ? { kind: "file", fileId: ev.fileId }
              : { kind: "project" }),
      }
      const { eventId } = await enqueueEvent({
        kind: "comment.create",
        projectId: ctx.projectId,
        fileId: ev.fileId ?? PROJECT_SENTINEL_FILE_ID,
        parentId: null,
        author: ctx.author,
        payload: payload as OutboxPayloadFor<"comment.create">,
      })
      return eventId
    }

    case "cell.validate": {
      if (!ev.fileId || !ev.cellId) {
        throw new Error("agent apply: cell.validate needs fileId and cellId")
      }
      // The payload pins the exact edit being validated. Fall back to the
      // live chain head when the server staged without one.
      const editEventId =
        typeof ev.payload.editEventId === "string"
          ? ev.payload.editEventId
          : ctx.resolveCell?.(ev.cellId)?.targetEventId
      if (!editEventId) {
        throw new Error("agent apply: cell.validate needs an editEventId")
      }
      const { eventId } = await enqueueEvent({
        kind: "cell.validate",
        projectId: ctx.projectId,
        fileId: ev.fileId,
        cellId: ev.cellId,
        parentId: null,
        author: ctx.author,
        payload: { ...ev.payload, editEventId } as OutboxPayloadFor<"cell.validate">,
      })
      return eventId
    }
  }
}

/**
 * Apply a proposal's events in order. Sequential on purpose: two commits to
 * the SAME cell within one proposal must chain (the second's parentId is the
 * first's event id), so later events see earlier ones through the head map.
 */
export async function applyStagedEvents(
  events: StagedEvent[],
  ctx: ApplyContext,
): Promise<string[]> {
  const ids: string[] = []
  // Heads minted within this apply — overlays ctx.resolveCell.
  const localHeads = new Map<string, string>()
  const resolveCell: ApplyContext["resolveCell"] = (cellId) => {
    const base = ctx.resolveCell?.(cellId)
    const local = localHeads.get(cellId)
    return local ? { ...base, targetEventId: local } : base
  }
  for (const ev of events) {
    const id = await applyStagedEvent(ev, { ...ctx, resolveCell })
    ids.push(id)
    if (ev.kind === "target.cell.commit" && ev.cellId) {
      localHeads.set(ev.cellId, id)
    }
  }
  return ids
}
