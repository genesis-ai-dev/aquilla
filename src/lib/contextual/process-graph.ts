// Autopilot process graph — the real engine topology, plus a read model that
// lights nodes from durable activity the client already has. A phase only
// identifies a region; this file does not invent a more precise node.

import type {
  ContextualActivityDraft,
  ContextualActivityEvent,
  ContextualActivitySceneBrief,
  ContextualOverview,
  ContextualRunActivity,
  ContextualRunRecord,
} from "./transport"

export const PROCESS_NODE_IDS = [
  "scope",
  "segment",
  "construe",
  "expand_window",
  "register",
  "summarize",
  "persist",
  "draft",
  "lint_rules",
  "route_risk",
  "verify_force",
  "verify_ambiguity",
  "verify_naturalness",
  "quorum",
  "stage",
  "report",
] as const

export type ProcessNodeId = (typeof PROCESS_NODE_IDS)[number]

export type ProcessNodeState = "pending" | "active" | "done" | "failed"
export type ProcessEdgeKind = "flow" | "loop" | "redraft"

export interface ProcessNodeLayout {
  id: ProcessNodeId
  x: number
  y: number
}

export interface ProcessEdge {
  id: string
  from: ProcessNodeId
  to: ProcessNodeId
  kind: ProcessEdgeKind
}

/** One-row spine. Small nodes, modest gaps; verifiers sit above route→quorum. */
const X0 = 11
const STEP = 17
const Y = 24
const YV = 8

export const PROCESS_NODE_LAYOUT: readonly ProcessNodeLayout[] = [
  { id: "scope", x: X0, y: Y },
  { id: "segment", x: X0 + STEP, y: Y },
  { id: "construe", x: X0 + STEP * 2, y: Y },
  { id: "expand_window", x: X0 + STEP * 3, y: Y },
  { id: "register", x: X0 + STEP * 4, y: Y },
  { id: "summarize", x: X0 + STEP * 5, y: Y },
  { id: "persist", x: X0 + STEP * 6, y: Y },
  { id: "draft", x: X0 + STEP * 7, y: Y },
  { id: "lint_rules", x: X0 + STEP * 8, y: Y },
  { id: "route_risk", x: X0 + STEP * 9, y: Y },
  { id: "verify_force", x: X0 + STEP * 9 + 10, y: YV },
  { id: "verify_ambiguity", x: X0 + STEP * 9 + 23, y: YV },
  { id: "verify_naturalness", x: X0 + STEP * 9 + 36, y: YV },
  { id: "quorum", x: X0 + STEP * 11 + 20, y: Y },
  { id: "stage", x: X0 + STEP * 12 + 20, y: Y },
  { id: "report", x: X0 + STEP * 13 + 20, y: Y },
]

export const PROCESS_VIEWBOX = { width: 268, height: 42 }
export const PROCESS_NODE_SIZE = 7

export const PROCESS_EDGES: readonly ProcessEdge[] = [
  { id: "scope-segment", from: "scope", to: "segment", kind: "flow" },
  { id: "segment-construe", from: "segment", to: "construe", kind: "flow" },
  { id: "construe-expand", from: "construe", to: "expand_window", kind: "flow" },
  { id: "expand-construe", from: "expand_window", to: "construe", kind: "loop" },
  { id: "expand-register", from: "expand_window", to: "register", kind: "flow" },
  { id: "register-summarize", from: "register", to: "summarize", kind: "flow" },
  { id: "summarize-persist", from: "summarize", to: "persist", kind: "flow" },
  { id: "persist-draft", from: "persist", to: "draft", kind: "flow" },
  { id: "draft-lint", from: "draft", to: "lint_rules", kind: "flow" },
  { id: "lint-route", from: "lint_rules", to: "route_risk", kind: "flow" },
  { id: "route-force", from: "route_risk", to: "verify_force", kind: "flow" },
  { id: "route-ambiguity", from: "route_risk", to: "verify_ambiguity", kind: "flow" },
  { id: "route-naturalness", from: "route_risk", to: "verify_naturalness", kind: "flow" },
  { id: "force-quorum", from: "verify_force", to: "quorum", kind: "flow" },
  { id: "ambiguity-quorum", from: "verify_ambiguity", to: "quorum", kind: "flow" },
  { id: "naturalness-quorum", from: "verify_naturalness", to: "quorum", kind: "flow" },
  { id: "quorum-stage", from: "quorum", to: "stage", kind: "flow" },
  { id: "stage-report", from: "stage", to: "report", kind: "flow" },
  { id: "quorum-draft", from: "quorum", to: "draft", kind: "redraft" },
]

const READING: readonly ProcessNodeId[] = [
  "scope", "segment", "construe", "expand_window", "register", "summarize", "persist",
]
const DRAFTING: readonly ProcessNodeId[] = ["draft", "lint_rules"]
const CHECKING: readonly ProcessNodeId[] = [
  "route_risk", "verify_force", "verify_ambiguity", "verify_naturalness", "quorum",
]
const STAGING: readonly ProcessNodeId[] = ["stage", "report"]

const REGION_ORDER = ["reading", "drafting", "checking", "staging"] as const
type ProcessRegion = (typeof REGION_ORDER)[number]

const REGION_NODES: Record<ProcessRegion, readonly ProcessNodeId[]> = {
  reading: READING,
  drafting: DRAFTING,
  checking: CHECKING,
  staging: STAGING,
}

export interface ProcessSpanCursor {
  spanId: string
  spanLabel: string | null
  region: ProcessRegion
  failed: boolean
  complete: boolean
}

export interface ProcessNodeInspect {
  nodeId: ProcessNodeId
  state: ProcessNodeState
  spanLabels: string[]
  sceneBrief: ContextualActivitySceneBrief | null
  drafts: ContextualActivityDraft[]
  decision: ProcessDecision | null
}

export interface ProcessDecision {
  kind: "ambiguities" | "drafts" | "outcome" | "phase"
  spanLabel: string | null
  count?: number
  status?: string
  reasons?: string[]
}

export interface ProcessGraphModel {
  nodeStates: Record<ProcessNodeId, ProcessNodeState>
  edgeStates: Record<string, ProcessNodeState>
  liveSpanLabels: string[]
  lastDecision: ProcessDecision | null
  inspect: Record<ProcessNodeId, ProcessNodeInspect>
  live: boolean
}

const EMPTY_STATES = Object.fromEntries(
  PROCESS_NODE_IDS.map((id) => [id, "pending"]),
) as Record<ProcessNodeId, ProcessNodeState>

function normalizePhase(value: string | null | undefined): ProcessRegion | null {
  if (!value) return null
  const normalized = value.trim().toLowerCase().replace(/[….]+$/u, "")
  if (normalized === "reading" || normalized === "reading context") return "reading"
  if (normalized === "drafting" || normalized === "drafting translations") return "drafting"
  if (normalized === "checking" || normalized === "checking drafts") return "checking"
  if (
    normalized === "staging"
    || normalized === "saving drafts"
    || normalized === "staging reviewable drafts"
  ) {
    return "staging"
  }
  return null
}

function regionIndex(region: ProcessRegion): number {
  return REGION_ORDER.indexOf(region)
}

function nodesBefore(region: ProcessRegion): ProcessNodeId[] {
  return REGION_ORDER.slice(0, regionIndex(region)).flatMap((id) => [...REGION_NODES[id]])
}

function detailNumber(details: Record<string, unknown>, key: string): number | null {
  const value = details[key]
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function detailStringList(details: Record<string, unknown>, key: string): string[] {
  const value = details[key]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string" && item.length > 0)
}

function eventsForSpan(events: ContextualActivityEvent[], spanId: string): ContextualActivityEvent[] {
  return events.filter((event) => event.spanId === spanId)
}

function latestEvent(
  events: ContextualActivityEvent[],
  kinds: readonly string[],
): ContextualActivityEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (kinds.includes(events[i].kind)) return events[i]
  }
  return null
}

function cursorFromEvents(
  spanId: string,
  events: ContextualActivityEvent[],
): ProcessSpanCursor | null {
  const scoped = eventsForSpan(events, spanId)
  if (scoped.length === 0) return null
  const label = [...scoped].reverse().find((event) => event.spanLabel)?.spanLabel ?? null
  const outcome = latestEvent(scoped, ["span_outcome"])
  if (outcome) {
    const failed = outcome.status === "failed"
    const complete = (outcome.status === "complete" || outcome.status === "done") && !failed
    const phaseEvent = latestEvent(scoped, ["phase"])
    return {
      spanId,
      spanLabel: outcome.spanLabel ?? label,
      region: failed ? (normalizePhase(phaseEvent?.phase) ?? "staging") : "staging",
      failed,
      complete,
    }
  }
  if (latestEvent(scoped, ["drafts_staged"])) {
    return { spanId, spanLabel: label, region: "staging", failed: false, complete: false }
  }
  const phaseEvent = latestEvent(scoped, ["phase"])
  const region = normalizePhase(phaseEvent?.phase)
  if (region) {
    return { spanId, spanLabel: phaseEvent?.spanLabel ?? label, region, failed: false, complete: false }
  }
  if (latestEvent(scoped, ["scene_ready"])) {
    return { spanId, spanLabel: label, region: "drafting", failed: false, complete: false }
  }
  if (latestEvent(scoped, ["span_started"])) {
    return { spanId, spanLabel: label, region: "reading", failed: false, complete: false }
  }
  return null
}

function mergeState(current: ProcessNodeState, next: ProcessNodeState): ProcessNodeState {
  const rank: Record<ProcessNodeState, number> = { pending: 0, done: 1, failed: 2, active: 3 }
  return rank[next] > rank[current] ? next : current
}

function applyCursor(
  states: Record<ProcessNodeId, ProcessNodeState>,
  cursor: ProcessSpanCursor,
): void {
  if (cursor.complete) {
    for (const id of PROCESS_NODE_IDS) states[id] = mergeState(states[id], "done")
    return
  }
  for (const id of nodesBefore(cursor.region)) {
    states[id] = mergeState(states[id], "done")
  }
  const mark = cursor.failed ? "failed" : "active"
  for (const id of REGION_NODES[cursor.region]) {
    states[id] = mergeState(states[id], mark)
  }
}

function decisionFromEvents(events: ContextualActivityEvent[]): ProcessDecision | null {
  const outcome = latestEvent(events, ["span_outcome"])
  if (outcome) {
    const skipped = detailNumber(outcome.details, "skipped")
    return {
      kind: "outcome",
      spanLabel: outcome.spanLabel ?? null,
      count: skipped ?? detailNumber(outcome.details, "staged") ?? undefined,
      status: outcome.status,
      reasons: detailStringList(outcome.details, "reasons"),
    }
  }
  const staged = latestEvent(events, ["drafts_staged"])
  if (staged) {
    return {
      kind: "drafts",
      spanLabel: staged.spanLabel ?? null,
      count: detailNumber(staged.details, "count") ?? detailNumber(staged.details, "staged") ?? undefined,
    }
  }
  const scene = latestEvent(events, ["scene_ready"])
  if (scene) {
    return {
      kind: "ambiguities",
      spanLabel: scene.spanLabel ?? null,
      count: detailNumber(scene.details, "ambiguityCount") ?? undefined,
    }
  }
  const phase = latestEvent(events, ["phase"])
  if (phase) {
    return { kind: "phase", spanLabel: phase.spanLabel ?? null, status: phase.phase ?? undefined }
  }
  return null
}

function briefForSpan(
  briefs: ContextualActivitySceneBrief[],
  drafts: ContextualActivityDraft[],
  spanLabel: string | null,
): ContextualActivitySceneBrief | null {
  if (briefs.length === 0) return null
  if (!spanLabel) return briefs[briefs.length - 1] ?? null
  const matchingDraft = drafts.find((draft) => draft.provenance && JSON.stringify(draft.provenance).includes(spanLabel))
  if (matchingDraft?.sceneBriefId) {
    return briefs.find((brief) => brief.id === matchingDraft.sceneBriefId) ?? briefs[briefs.length - 1] ?? null
  }
  return briefs[briefs.length - 1] ?? null
}

function inspectForNode(
  nodeId: ProcessNodeId,
  state: ProcessNodeState,
  cursors: ProcessSpanCursor[],
  activity: ContextualRunActivity | null,
  decision: ProcessDecision | null,
): ProcessNodeInspect {
  const region = REGION_ORDER.find((id) => REGION_NODES[id].includes(nodeId)) ?? "reading"
  const relevant = cursors.filter((cursor) => (
    cursor.complete
    || cursor.region === region
    || regionIndex(cursor.region) > regionIndex(region)
  ))
  const spanLabels = [...new Set(relevant.map((cursor) => cursor.spanLabel).filter((label): label is string => Boolean(label)))]
  const latestLabel = spanLabels[0] ?? decision?.spanLabel ?? null
  return {
    nodeId,
    state,
    spanLabels,
    sceneBrief: briefForSpan(activity?.sceneBriefs ?? [], activity?.drafts ?? [], latestLabel),
    drafts: (activity?.drafts ?? []).filter((draft) => draft.status === "proposed").slice(0, 3),
    decision: relevant.length > 0 || state !== "pending" ? decision : null,
  }
}

function edgeState(
  edge: ProcessEdge,
  nodeStates: Record<ProcessNodeId, ProcessNodeState>,
): ProcessNodeState {
  const from = nodeStates[edge.from]
  const to = nodeStates[edge.to]
  if (from === "active" && (to === "active" || to === "pending")) return "active"
  if (to === "failed" || from === "failed") return to === "failed" ? "failed" : from
  if (from === "done" && to === "done") return "done"
  if (from === "done" && to === "active") return "active"
  return "pending"
}

function emptyInspect(decision: ProcessDecision | null): Record<ProcessNodeId, ProcessNodeInspect> {
  return Object.fromEntries(PROCESS_NODE_IDS.map((id) => [id, {
    nodeId: id,
    state: "pending" as const,
    spanLabels: [],
    sceneBrief: null,
    drafts: [],
    decision,
  }])) as Record<ProcessNodeId, ProcessNodeInspect>
}

export function emptyProcessGraph(live = false): ProcessGraphModel {
  return {
    nodeStates: { ...EMPTY_STATES },
    edgeStates: Object.fromEntries(PROCESS_EDGES.map((edge) => [edge.id, "pending"])),
    liveSpanLabels: [],
    lastDecision: null,
    inspect: emptyInspect(null),
    live,
  }
}

export function deriveProcessGraph(
  run: ContextualRunRecord | null | undefined,
  activity: ContextualRunActivity | null | undefined,
): ProcessGraphModel {
  const events = activity?.events ?? []
  const spanIds = [...new Set(events.map((event) => event.spanId).filter((id): id is string => Boolean(id)))]
  const cursors = spanIds
    .map((spanId) => cursorFromEvents(spanId, events))
    .filter((cursor): cursor is ProcessSpanCursor => cursor !== null)

  const nodeStates = { ...EMPTY_STATES }
  if (cursors.length === 0) {
    const region = normalizePhase(run?.phase)
    if (region && (run?.status === "running" || run?.status === "pausing")) {
      applyCursor(nodeStates, {
        spanId: "run",
        spanLabel: run.spanLabel,
        region,
        failed: false,
        complete: false,
      })
    } else if (run?.status === "done") {
      for (const id of PROCESS_NODE_IDS) nodeStates[id] = "done"
    } else if (run?.status === "failed") {
      for (const id of STAGING) nodeStates[id] = "failed"
      for (const id of [...READING, ...DRAFTING, ...CHECKING]) nodeStates[id] = "done"
    }
  } else {
    for (const cursor of cursors) applyCursor(nodeStates, cursor)
  }

  const lastDecision = decisionFromEvents(events)
  const liveCursors = cursors.filter((cursor) => !cursor.complete && !cursor.failed)
  const liveSpanLabels = [
    ...new Set([
      ...liveCursors.map((cursor) => cursor.spanLabel),
      run?.status === "running" || run?.status === "pausing" ? run.spanLabel : null,
    ].filter((label): label is string => Boolean(label))),
  ]
  const inspect = Object.fromEntries(PROCESS_NODE_IDS.map((id) => [
    id,
    inspectForNode(id, nodeStates[id], cursors, activity ?? null, lastDecision),
  ])) as Record<ProcessNodeId, ProcessNodeInspect>
  const edgeStates = Object.fromEntries(
    PROCESS_EDGES.map((edge) => [edge.id, edgeState(edge, nodeStates)]),
  )

  return {
    nodeStates,
    edgeStates,
    liveSpanLabels,
    lastDecision,
    inspect,
    live: run?.status === "running" || run?.status === "pausing" || liveCursors.length > 0,
  }
}

export function deriveProcessGraphFromOverview(overview: ContextualOverview | null | undefined): ProcessGraphModel {
  const files = overview?.files ?? []
  const working = files.some((file) => file.status === "running" || file.status === "pausing")
  const failed = files.some((file) => file.status === "failed")
  const done = files.length > 0 && files.every((file) => file.status === "done" || file.status === "terminated")
  const model = emptyProcessGraph(working)
  if (working) {
    for (const id of PROCESS_NODE_IDS) model.nodeStates[id] = "pending"
    for (const edge of PROCESS_EDGES) {
      if (edge.kind === "flow") model.edgeStates[edge.id] = "active"
    }
    model.live = true
    return model
  }
  if (failed) {
    for (const id of [...READING, ...DRAFTING, ...CHECKING]) model.nodeStates[id] = "done"
    for (const id of STAGING) model.nodeStates[id] = "failed"
    return model
  }
  if (done) {
    for (const id of PROCESS_NODE_IDS) model.nodeStates[id] = "done"
    for (const edge of PROCESS_EDGES) model.edgeStates[edge.id] = "done"
  }
  return model
}

export function layoutById(): Record<ProcessNodeId, ProcessNodeLayout> {
  return Object.fromEntries(PROCESS_NODE_LAYOUT.map((node) => [node.id, node])) as Record<
    ProcessNodeId,
    ProcessNodeLayout
  >
}
