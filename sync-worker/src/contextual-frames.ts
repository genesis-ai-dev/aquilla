// Contextual translation pipeline broadcast frames (slice D2).
//
// These types MIRROR the SPA's `src/lib/contextual/run-store.ts` frame
// interfaces byte-for-byte (same discriminant key `type`, same field names)
// — the SPA's `applyRemoteFrame` consumes exactly this shape off the project
// WebSocket. If a field changes here it must change there in the same PR.

export type ContextualBroadcastRunStatus =
  | "running"
  | "pausing"
  | "paused"
  | "parked"
  | "done"
  | "failed"
  | "terminated"

const RUN_STATUSES: ReadonlySet<string> = new Set([
  "running",
  "pausing",
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
  targetLang: string
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
  spanId?: string
}

export interface ContextualSpanFrame {
  type: "contextual.span"
  runId: string
  spanLabel: string
  staged: number
  skipped: number
  verdictSummary: string
  spanId?: string
  outcome?: "complete" | "partial" | "failed"
  reasons?: ContextualSpanReason[]
  calls?: number
  units?: number
}

/** A span lane opens (before the first model call — kills the start-up dead
 *  air a wave of spans would otherwise show). */
export interface ContextualSpanStartFrame {
  type: "contextual.span.start"
  runId: string
  fileId: string
  spanId: string
  spanLabel: string
}

/** Within-lane phase movement. */
export interface ContextualPhaseFrame {
  type: "contextual.phase"
  runId: string
  spanId: string
  spanLabel: string
  phase: ContextualSpanPhase
}

/** Verified text landing as reviewable drafts — the payload users wait for. */
export interface ContextualDraftsFrame {
  type: "contextual.drafts"
  runId: string
  fileId: string
  targetLang: string
  spanId?: string
  spanLabel: string
  draftCount?: number
  drafts: { draftId: string; cellId: string; text: string }[]
  truncated?: boolean
}

export type ContextualSpanPhase = "reading" | "drafting" | "checking" | "staging"

export type ContextualSpanReason =
  | "scene_construal_incomplete"
  | "draft_failed"
  | "no_draft_returned"
  | "verification_unavailable"
  | "rejected_by_quorum"
  | "target_already_filled"
  | "span_failed"

const SPAN_PHASES: ReadonlySet<string> = new Set(["reading", "drafting", "checking", "staging"])
const SPAN_OUTCOMES: ReadonlySet<string> = new Set(["complete", "partial", "failed"])
const SPAN_REASONS: ReadonlySet<string> = new Set([
  "scene_construal_incomplete",
  "draft_failed",
  "no_draft_returned",
  "verification_unavailable",
  "rejected_by_quorum",
  "target_already_filled",
  "span_failed",
])

/** Ceiling on drafts carried in one frame — mirrors MAX_DRAFTS_PER_FRAME in
 *  auth-worker/src/lib/contextual/tick.ts. A frame over this is rejected
 *  rather than fanned out; the client's snapshot refetch is the floor. */
const MAX_DRAFTS_PER_FRAME = 40

export type ContextualFrame =
  | ContextualRunStateFrame
  | ContextualSceneFrame
  | ContextualSpanFrame
  | ContextualSpanStartFrame
  | ContextualPhaseFrame
  | ContextualDraftsFrame

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
    if (typeof m.targetLang !== "string") return null
    if (typeof m.status !== "string" || !RUN_STATUSES.has(m.status)) return null
    if (typeof m.done !== "number" || typeof m.total !== "number") return null
    if (m.failed !== undefined && typeof m.failed !== "number") return null
    return {
      type: "contextual.run.state",
      runId: m.runId,
      fileId: m.fileId,
      targetLang: m.targetLang,
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
    if (m.spanId !== undefined && typeof m.spanId !== "string") return null
    return {
      type: "contextual.scene",
      runId: m.runId,
      sceneBriefId: m.sceneBriefId,
      spanLabel: m.spanLabel,
      ambiguityCount: m.ambiguityCount,
      ...(typeof m.spanId === "string" ? { spanId: m.spanId } : {}),
    }
  }

  if (m.type === "contextual.span") {
    if (typeof m.spanLabel !== "string") return null
    if (typeof m.staged !== "number" || typeof m.skipped !== "number") return null
    if (typeof m.verdictSummary !== "string") return null
    if (m.spanId !== undefined && typeof m.spanId !== "string") return null
    if (m.outcome !== undefined && (typeof m.outcome !== "string" || !SPAN_OUTCOMES.has(m.outcome))) return null
    if (m.calls !== undefined && typeof m.calls !== "number") return null
    if (m.units !== undefined && typeof m.units !== "number") return null
    if (
      m.reasons !== undefined &&
      (!Array.isArray(m.reasons) || !m.reasons.every((reason) => typeof reason === "string" && SPAN_REASONS.has(reason)))
    ) return null
    return {
      type: "contextual.span",
      runId: m.runId,
      spanLabel: m.spanLabel,
      staged: m.staged,
      skipped: m.skipped,
      verdictSummary: m.verdictSummary,
      ...(typeof m.spanId === "string" ? { spanId: m.spanId } : {}),
      ...(typeof m.outcome === "string" ? { outcome: m.outcome as ContextualSpanFrame["outcome"] } : {}),
      ...(Array.isArray(m.reasons) ? { reasons: m.reasons as ContextualSpanReason[] } : {}),
      ...(typeof m.calls === "number" ? { calls: m.calls } : {}),
      ...(typeof m.units === "number" ? { units: m.units } : {}),
    }
  }

  if (m.type === "contextual.span.start") {
    if (typeof m.fileId !== "string") return null
    if (typeof m.spanId !== "string" || m.spanId.length === 0) return null
    if (typeof m.spanLabel !== "string") return null
    return {
      type: "contextual.span.start",
      runId: m.runId,
      fileId: m.fileId,
      spanId: m.spanId,
      spanLabel: m.spanLabel,
    }
  }

  if (m.type === "contextual.phase") {
    if (typeof m.spanId !== "string" || m.spanId.length === 0) return null
    if (typeof m.spanLabel !== "string") return null
    if (typeof m.phase !== "string" || !SPAN_PHASES.has(m.phase)) return null
    return {
      type: "contextual.phase",
      runId: m.runId,
      spanId: m.spanId,
      spanLabel: m.spanLabel,
      phase: m.phase as ContextualSpanPhase,
    }
  }

  if (m.type === "contextual.drafts") {
    if (typeof m.fileId !== "string") return null
    if (typeof m.targetLang !== "string") return null
    if (typeof m.spanLabel !== "string") return null
    if (!Array.isArray(m.drafts) || (m.drafts.length === 0 && m.truncated !== true)) return null
    if (m.drafts.length > MAX_DRAFTS_PER_FRAME) return null
    if (m.truncated !== undefined && typeof m.truncated !== "boolean") return null
    if (m.spanId !== undefined && typeof m.spanId !== "string") return null
    if (m.draftCount !== undefined && (typeof m.draftCount !== "number" || m.draftCount < m.drafts.length)) return null
    const drafts: ContextualDraftsFrame["drafts"] = []
    for (const raw of m.drafts as unknown[]) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
      const d = raw as Record<string, unknown>
      if (typeof d.draftId !== "string" || d.draftId.length === 0) return null
      if (typeof d.cellId !== "string" || d.cellId.length === 0) return null
      if (typeof d.text !== "string") return null
      drafts.push({ draftId: d.draftId, cellId: d.cellId, text: d.text })
    }
    return {
      type: "contextual.drafts",
      runId: m.runId,
      fileId: m.fileId,
      targetLang: m.targetLang,
      ...(typeof m.spanId === "string" ? { spanId: m.spanId } : {}),
      spanLabel: m.spanLabel,
      ...(typeof m.draftCount === "number" ? { draftCount: m.draftCount } : {}),
      drafts,
      ...(m.truncated === true ? { truncated: true } : {}),
    }
  }

  return null
}
