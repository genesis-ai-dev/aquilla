import posthog from "@/lib/posthog"
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
import { enqueueEvent, enqueueEvents, type BuildEventInput } from "@/lib/sync/events-emit"
import type { OutboxPayloadFor } from "@/lib/sync/outbox-types"
import type { StagedEvent } from "./protocol"
import { isSupportedApplyKind, type SupportedApplyKind } from "./role-floors"
import { resolveTargetCommitParent } from "@/lib/sync/target-commit-parent"
import { captureCellValidation } from "@/lib/cell-telemetry"

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

/** One staged event as a write, plus what to report once it's queued. */
interface AppliedEvent {
  input: BuildEventInput<SupportedApplyKind> & { id: string }
  afterEnqueue?: () => void
}

/**
 * Enqueue one staged event through the normal write path. Returns the
 * client-generated event id (the outbox handle / next chain parent).
 */
export async function applyStagedEvent(
  ev: StagedEvent,
  ctx: ApplyContext,
): Promise<string> {
  const { input, afterEnqueue } = buildAppliedEvent(ev, ctx)
  const { eventId } = await enqueueEvent(input)
  afterEnqueue?.()
  return eventId
}

/**
 * Turn one staged event into the write that applies it. The id is minted
 * here, not by the envelope builder, so a later event in the same proposal can
 * chain on it before anything is queued.
 */
function buildAppliedEvent(ev: StagedEvent, ctx: ApplyContext): AppliedEvent {
  const analytics = posthog.scope(undefined, ctx.author)
  if (!isSupportedApplyKind(ev.kind)) throw new UnsupportedAgentEventError(ev.kind)
  const id = uuidv7()

  switch (ev.kind) {
    case "target.cell.commit": {
      if (!ev.fileId || !ev.cellId) {
        throw new Error("agent apply: target.cell.commit needs fileId and cellId")
      }
      const live = ctx.resolveCell?.(ev.cellId)
      // Same precedence as the editor's commit paths (commitCompletedCell):
      // freshest known chain head → staged pin → source genesis fallback.
      // AQU-1578: an optimistic placeholder head ("") counts as unknown.
      const parentId = resolveTargetCommitParent({
        pending: [live?.targetEventId, ev.parentId],
        sourceEventId: live?.sourceEventId,
      })
      return { input: {
        id,
        kind: "target.cell.commit",
        projectId: ctx.projectId,
        fileId: ev.fileId,
        cellId: ev.cellId,
        parentId,
        author: ctx.author,
        // Verbatim passthrough: keeps ai_suggestion / agent_run_id /
        // sourceEventId exactly as the server staged them.
        payload: ev.payload as OutboxPayloadFor<"target.cell.commit">,
      } }
    }

    case "source.cell.create":
    case "target.cell.create": {
      // AQU-890: genesis events (isGenesisKind) — parentId is ALWAYS null; the
      // row's position comes from the anchor pointer, not a chain parent. The
      // payload repeats cellId the same way emitSourceCellCreate does, because
      // the projection reads the new row's id out of the payload.
      const cellId =
        (typeof ev.payload.cellId === "string" && ev.payload.cellId) || ev.cellId
      if (!ev.fileId || !cellId) {
        throw new Error(`agent apply: ${ev.kind} needs fileId and cellId`)
      }
      if (typeof ev.payload.value !== "string") {
        throw new Error(`agent apply: ${ev.kind} needs a string value`)
      }
      return { input: {
        id,
        kind: ev.kind,
        projectId: ctx.projectId,
        fileId: ev.fileId,
        cellId,
        parentId: null,
        author: ctx.author,
        // Verbatim passthrough (keeps ai_suggestion / agent_run_id); cellId and
        // anchorCellId go last so an absent key can't shadow the fallback.
        payload: {
          ...ev.payload,
          cellId,
          anchorCellId: (ev.payload.anchorCellId as string | null | undefined) ?? null,
        } as OutboxPayloadFor<"source.cell.create" | "target.cell.create">,
      } }
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
      return { input: {
        id,
        kind: "comment.create",
        projectId: ctx.projectId,
        fileId: ev.fileId ?? PROJECT_SENTINEL_FILE_ID,
        parentId: null,
        author: ctx.author,
        payload: payload as OutboxPayloadFor<"comment.create">,
      } }
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
      const { fileId, cellId } = ev
      return {
        input: {
          id,
          kind: "cell.validate",
          projectId: ctx.projectId,
          fileId,
          cellId,
          parentId: null,
          author: ctx.author,
          payload: { ...ev.payload, editEventId } as OutboxPayloadFor<"cell.validate">,
        },
        // AQU-1572: this path enqueues the event itself rather than through
        // `emitCellValidate`, so the emit seam never sees it and it reports its
        // own line, after the enqueue, in the seam's shape. The person
        // approved it, but the agent chose the line, so `source: "agent"`.
        afterEnqueue: () =>
          captureCellValidation(true, {
            medium: "text",
            projectId: ctx.projectId,
            fileId,
            cellId,
            lane: typeof ev.payload.targetLang === "string" ? ev.payload.targetLang : "",
            source: "agent",
            surface: "proposal",
          }, analytics),
      }
    }
  }
}

/** Which side of a cell's chain an applied event becomes the head of. */
function headSideFor(kind: string): "targetEventId" | "sourceEventId" | null {
  if (kind === "target.cell.commit" || kind === "target.cell.create") return "targetEventId"
  if (kind === "source.cell.create") return "sourceEventId"
  return null
}

/**
 * Apply a proposal's events in order, as ONE outbox write. Built in order on
 * purpose: two commits to the SAME cell within one proposal must chain (the
 * second's parentId is the first's event id), so later events see earlier
 * ones through the head map. Queued together so a chapter-sized proposal is
 * one write, not one per edit — and an event that can't be built refuses the
 * whole proposal before anything is queued. On desktop the batch can span
 * IndexedDB and the offline queue; IndexedDB is written first, so a failed
 * write there still queues nothing (see enqueueOutboxEvents).
 *
 * AQU-890: creates seed that map too, per side — a `target.cell.create` +
 * `target.cell.commit` pair in one proposal chains the commit onto the create,
 * and a `source.cell.create` gives a following target commit its AD-9 source
 * fallback instead of stranding it with a null parent.
 */
export async function applyStagedEvents(
  events: StagedEvent[],
  ctx: ApplyContext,
): Promise<string[]> {
  // Heads minted within this apply — overlays ctx.resolveCell.
  const localHeads = new Map<string, { targetEventId?: string; sourceEventId?: string }>()
  const resolveCell: ApplyContext["resolveCell"] = (cellId) => {
    const base = ctx.resolveCell?.(cellId)
    const local = localHeads.get(cellId)
    return local ? { ...base, ...local } : base
  }
  const applied = events.map((ev) => {
    const built = buildAppliedEvent(ev, { ...ctx, resolveCell })
    const side = headSideFor(ev.kind)
    const cellId =
      (typeof ev.payload.cellId === "string" && ev.payload.cellId) || ev.cellId
    if (side && cellId) {
      localHeads.set(cellId, { ...localHeads.get(cellId), [side]: built.input.id })
    }
    return built
  })
  const queued = await enqueueEvents(applied.map(({ input }) => input))
  for (const { afterEnqueue } of applied) afterEnqueue?.()
  return queued.map(({ eventId }) => eventId)
}
