// Contextual translation pipeline broadcast frames (slice D2).
//
// These types MIRROR the SPA's `src/lib/contextual/run-store.ts` frame
// interfaces byte-for-byte (same discriminant key `type`, same field names)
// — the SPA's `applyRemoteFrame` consumes exactly this shape off the project
// WebSocket. If a field changes here it must change there in the same PR.

export type ContextualBroadcastRunStatus =
  | "running"
  | "paused"
  | "parked"
  | "done"
  | "failed"
  | "terminated"

const RUN_STATUSES: ReadonlySet<string> = new Set([
  "running",
  "paused",
  "parked",
  "done",
  "failed",
  "terminated",
])

export interface ContextualRunStateFrame {
  type: "contextual.run.state"
  runId: string
  fileId: string
  status: ContextualBroadcastRunStatus
  done: number
  total: number
  failed?: number
}

export interface ContextualSceneFrame {
  type: "contextual.scene"
  runId: string
  sceneBriefId: string
  spanLabel: string
  ambiguityCount: number
}

export interface ContextualSpanFrame {
  type: "contextual.span"
  runId: string
  spanLabel: string
  staged: number
  skipped: number
  verdictSummary: string
}

export type ContextualFrame =
  | ContextualRunStateFrame
  | ContextualSceneFrame
  | ContextualSpanFrame

/**
 * Validate an untrusted JSON body into a ContextualFrame. Returns null on any
 * shape mismatch — the admin route 400s rather than fanning out a malformed
 * frame to WS clients.
 */
export function parseContextualFrame(value: unknown): ContextualFrame | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const m = value as Record<string, unknown>
  if (typeof m.runId !== "string" || m.runId.length === 0) return null

  if (m.type === "contextual.run.state") {
    if (typeof m.fileId !== "string") return null
    if (typeof m.status !== "string" || !RUN_STATUSES.has(m.status)) return null
    if (typeof m.done !== "number" || typeof m.total !== "number") return null
    if (m.failed !== undefined && typeof m.failed !== "number") return null
    return {
      type: "contextual.run.state",
      runId: m.runId,
      fileId: m.fileId,
      status: m.status as ContextualBroadcastRunStatus,
      done: m.done,
      total: m.total,
      ...(typeof m.failed === "number" ? { failed: m.failed } : {}),
    }
  }

  if (m.type === "contextual.scene") {
    if (typeof m.sceneBriefId !== "string") return null
    if (typeof m.spanLabel !== "string") return null
    if (typeof m.ambiguityCount !== "number") return null
    return {
      type: "contextual.scene",
      runId: m.runId,
      sceneBriefId: m.sceneBriefId,
      spanLabel: m.spanLabel,
      ambiguityCount: m.ambiguityCount,
    }
  }

  if (m.type === "contextual.span") {
    if (typeof m.spanLabel !== "string") return null
    if (typeof m.staged !== "number" || typeof m.skipped !== "number") return null
    if (typeof m.verdictSummary !== "string") return null
    return {
      type: "contextual.span",
      runId: m.runId,
      spanLabel: m.spanLabel,
      staged: m.staged,
      skipped: m.skipped,
      verdictSummary: m.verdictSummary,
    }
  }

  return null
}
