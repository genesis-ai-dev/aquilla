import { describe, expect, it } from "vitest"
import {
  PROCESS_EDGES,
  PROCESS_NODE_IDS,
  deriveProcessGraph,
  deriveProcessGraphFromOverview,
  emptyProcessGraph,
  layoutById,
  processGraphTopology,
} from "./process-graph"
import type {
  ContextualActivityEvent,
  ContextualOverview,
  ContextualRunActivity,
  ContextualRunRecord,
} from "./transport"

const run: ContextualRunRecord = {
  runId: "run-1",
  fileId: "file-1",
  status: "running",
  phase: "Checking…",
  spanLabel: "LUK 1:1–1:8",
  done: 3,
  total: 10,
  failed: 0,
  unitsSpent: 0,
  callsSpent: 0,
  lastError: null,
  createdAt: "2026-08-16T10:00:00.000Z",
  updatedAt: "2026-08-16T10:02:00.000Z",
  activeDirections: [],
}

function event(patch: Partial<ContextualActivityEvent>): ContextualActivityEvent {
  return {
    id: patch.id ?? "e1",
    runId: "run-1",
    projectId: "p1",
    fileId: "file-1",
    kind: patch.kind ?? "phase",
    summary: patch.summary ?? "",
    details: patch.details ?? {},
    createdAt: patch.createdAt ?? "2026-08-16T10:01:00.000Z",
    ...patch,
  }
}

function activity(events: ContextualActivityEvent[]): ContextualRunActivity {
  return { run, events, sceneBriefs: [], drafts: [], truncated: false }
}

describe("deriveProcessGraph", () => {
  it("creates inspect state for every declared process node", () => {
    const model = emptyProcessGraph()

    expect(Object.keys(model.inspect)).toEqual([...PROCESS_NODE_IDS])
    for (const nodeId of PROCESS_NODE_IDS) {
      expect(model.inspect[nodeId]).toMatchObject({ nodeId, state: "pending" })
    }
  })

  it("lights the checking region for a live checking span", () => {
    const model = deriveProcessGraph(run, activity([
      event({
        id: "start",
        kind: "span_started",
        spanId: "s1",
        spanLabel: "LUK 1:1–1:8",
      }),
      event({
        id: "phase",
        kind: "phase",
        spanId: "s1",
        spanLabel: "LUK 1:1–1:8",
        phase: "checking",
      }),
    ]))

    expect(model.nodeStates.persist).toBe("done")
    expect(model.nodeStates.draft).toBe("done")
    expect(model.nodeStates.route_risk).toBe("active")
    expect(model.nodeStates.verify_ambiguity).toBe("active")
    expect(model.nodeStates.stage).toBe("pending")
    expect(model.liveSpanLabels).toEqual(["LUK 1:1–1:8"])
    // The flow into the checking region: AQU-1690's Bible checks now sit between lint and routing.
    expect(model.edgeStates["bible-route"]).toBe("active")
    expect(model.nodeStates.bible_checks).toBe("done")
  })

  it("drops opaque cell/span UUIDs from live and inspect labels", () => {
    const model = deriveProcessGraph({ ...run, spanLabel: "01920000-0000-7000-8000-000000000001" }, activity([
      event({
        id: "start",
        kind: "span_started",
        spanId: "s1",
        spanLabel: "01920000-0000-7000-8000-000000000001",
      }),
      event({
        id: "phase",
        kind: "phase",
        spanId: "s1",
        spanLabel: "01920000…00000008",
        phase: "checking",
      }),
    ]))

    expect(model.liveSpanLabels).toEqual([])
    expect(model.inspect.construe.spanLabels).toEqual([])
    expect(model.lastDecision?.spanLabel).toBeNull()
  })

  it("keeps two in-flight regions lit at once", () => {
    const model = deriveProcessGraph(run, activity([
      event({
        id: "a-start",
        kind: "span_started",
        spanId: "a",
        spanLabel: "LUK 1:1–1:8",
      }),
      event({
        id: "a-phase",
        kind: "phase",
        spanId: "a",
        spanLabel: "LUK 1:1–1:8",
        phase: "drafting",
      }),
      event({
        id: "b-start",
        kind: "span_started",
        spanId: "b",
        spanLabel: "LUK 1:9–1:15",
      }),
      event({
        id: "b-phase",
        kind: "phase",
        spanId: "b",
        spanLabel: "LUK 1:9–1:15",
        phase: "reading",
      }),
    ]))

    expect(model.nodeStates.construe).toBe("active")
    expect(model.nodeStates.draft).toBe("active")
    expect(model.liveSpanLabels).toEqual(["LUK 1:1–1:8", "LUK 1:9–1:15"])
  })

  it("settles every node when a span completes", () => {
    const model = deriveProcessGraph({ ...run, status: "done", phase: null }, activity([
      event({
        id: "out",
        kind: "span_outcome",
        spanId: "s1",
        spanLabel: "LUK 1:1–1:8",
        status: "complete",
        details: { staged: 3, skipped: 0, reasons: [] },
      }),
    ]))

    for (const id of PROCESS_NODE_IDS) {
      expect(model.nodeStates[id]).toBe("done")
    }
    expect(model.lastDecision).toMatchObject({ kind: "outcome", count: 0, status: "complete" })
    expect(model.live).toBe(false)
  })

  it("marks the checking region failed on a failed span outcome after checking", () => {
    const model = deriveProcessGraph({ ...run, status: "running" }, activity([
      event({
        id: "phase",
        kind: "phase",
        spanId: "s1",
        spanLabel: "LUK 1:1–1:8",
        phase: "checking",
      }),
      event({
        id: "out",
        kind: "span_outcome",
        spanId: "s1",
        spanLabel: "LUK 1:1–1:8",
        status: "failed",
        details: { reasons: ["span_failed"] },
      }),
    ]))

    expect(model.nodeStates.route_risk).toBe("failed")
    expect(model.nodeStates.quorum).toBe("failed")
    expect(model.nodeStates.persist).toBe("done")
  })

  it("falls back to the run phase when activity has no span events", () => {
    const model = deriveProcessGraph(run, activity([]))
    expect(model.nodeStates.construe).toBe("done")
    expect(model.nodeStates.verify_force).toBe("active")
    expect(model.liveSpanLabels).toEqual(["LUK 1:1–1:8"])
  })
})

// AQU-1685: a device without the Bible data experiment draws the graph from
// before AQU-1690's Bible data steps: no Bible facts or Bible checks node, no
// edge into or out of them, the old flows past them, the old spacing. Those
// flows still carry live state, so the graph still shows where a run is.
describe("processGraphTopology", () => {
  it("leaves out the Bible data steps without the experiment, and keeps the flow past them", () => {
    const without = processGraphTopology(false)
    const ids = without.nodes.map((node) => node.id)
    expect(ids).not.toContain("bible_facts")
    expect(ids).not.toContain("bible_checks")
    expect(ids).toHaveLength(PROCESS_NODE_IDS.length - 2)
    expect(without.edges.some((edge) => edge.from.startsWith("bible_") || edge.to.startsWith("bible_"))).toBe(false)
    expect(without.edges.map((edge) => edge.id)).toEqual(expect.arrayContaining(["segment-construe", "lint-route"]))
    const at = layoutById(without.nodes)
    const step = at.segment.x - at.scope.x
    expect(at.construe.x - at.segment.x).toBe(step)
    expect(at.route_risk.x - at.lint_rules.x).toBe(step)
    expect(without.viewBox.width).toBe(processGraphTopology(true).viewBox.width - 2 * step)
  })

  it("draws every node and edge with the experiment on", () => {
    const withBible = processGraphTopology(true)
    expect(withBible.nodes.map((node) => node.id)).toEqual([...PROCESS_NODE_IDS])
    expect(withBible.edges).toBe(PROCESS_EDGES)
  })

  it("gives the flows past the Bible data steps a live state", () => {
    const model = deriveProcessGraph(run, activity([
      event({ id: "start", kind: "span_started", spanId: "s1", spanLabel: "LUK 1:1–1:8" }),
      event({ id: "phase", kind: "phase", spanId: "s1", spanLabel: "LUK 1:1–1:8", phase: "checking" }),
    ]))
    expect(model.edgeStates["lint-route"]).toBe("active")
    expect(model.edgeStates["segment-construe"]).toBe("done")
  })
})

describe("deriveProcessGraphFromOverview", () => {
  it("uses a live glow-map without claiming a precise node", () => {
    const overview: ContextualOverview = {
      available: true,
      files: [{
        fileId: "f1",
        runId: "r1",
        status: "running",
        doneSpans: 1,
        totalSpans: 10,
        failedSpans: 0,
        unitsSpent: 0,
        proposedDrafts: 0,
        appliedDrafts: 0,
        updatedAt: "2026-08-16T10:02:00.000Z",
        lastError: null,
      }],
      activeRuns: 1,
      doneSpans: 1,
      totalSpans: 10,
      failedSpans: 0,
      unitsSpent: 0,
      proposedDrafts: 0,
      appliedDrafts: 0,
    }
    const model = deriveProcessGraphFromOverview(overview)
    expect(model.live).toBe(true)
    expect(model.nodeStates.draft).toBe("pending")
    expect(model.edgeStates["persist-draft"]).toBe("active")
    expect(PROCESS_EDGES.some((edge) => model.edgeStates[edge.id] === "active")).toBe(true)
  })
})
