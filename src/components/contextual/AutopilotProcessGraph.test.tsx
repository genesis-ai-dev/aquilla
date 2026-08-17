import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { AutopilotProcessGraph } from "./AutopilotProcessGraph"
import type {
  ContextualOverview,
  ContextualRunActivity,
  ContextualRunRecord,
} from "@/lib/contextual/transport"

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

const activity: ContextualRunActivity = {
  run,
  events: [{
    id: "e1",
    runId: "run-1",
    projectId: "p1",
    fileId: "file-1",
    kind: "phase",
    spanId: "s1",
    spanLabel: "LUK 1:1–1:8",
    phase: "checking",
    summary: "Checking drafts",
    details: {},
    createdAt: "2026-08-16T10:01:00.000Z",
  }, {
    id: "e2",
    runId: "run-1",
    projectId: "p1",
    fileId: "file-1",
    kind: "scene_ready",
    spanId: "s1",
    spanLabel: "LUK 1:1–1:8",
    summary: "Scene ready",
    details: { ambiguityCount: 2 },
    createdAt: "2026-08-16T10:00:30.000Z",
  }],
  sceneBriefs: [{
    id: "brief-1",
    l1Summary: "A teacher addresses a crowd.",
    construal: "The teacher warns the crowd.",
    ambiguityRegister: [{ id: "a1", question: "Is the warning ironic?" }],
  }],
  drafts: [],
  truncated: false,
}

afterEach(() => {
  cleanup()
})

describe("AutopilotProcessGraph", () => {
  it("shows the live span, last decision, and full process map", () => {
    render(<AutopilotProcessGraph run={run} activity={activity} />)
    expect(screen.getByRole("img", { name: "Autopilot process graph" })).toBeInTheDocument()
    expect(screen.getByText("Now: LUK 1:1–1:8")).toBeInTheDocument()
    expect(screen.getByText("Noted 2 parts of the meaning not to over-specify in LUK 1:1–1:8")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "What a span is" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Situation" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Not too specific" })).toBeInTheDocument()
  })

  it("opens structured inspect without replacing the graph", () => {
    render(<AutopilotProcessGraph run={run} activity={activity} />)
    fireEvent.click(screen.getByRole("button", { name: "Situation" }))
    const inspect = screen.getByTestId("autopilot-process-graph-inspect")
    expect(inspect).toHaveTextContent("Read the situation in this piece of text: who is there, and what they do.")
    expect(inspect).toHaveTextContent("A teacher addresses a crowd.")
    expect(inspect).toHaveTextContent("Is the warning ironic?")
    expect(screen.getByRole("img", { name: "Autopilot process graph" })).toBeInTheDocument()
  })

  it("renders an unlabeled miniature on the project card", () => {
    const overview: ContextualOverview = {
      available: true,
      files: [{
        fileId: "f1",
        runId: "r1",
        status: "running",
        doneSpans: 1,
        totalSpans: 8,
        failedSpans: 0,
        unitsSpent: 0,
        proposedDrafts: 0,
        appliedDrafts: 0,
        updatedAt: "2026-08-16T10:02:00.000Z",
        lastError: null,
      }],
      activeRuns: 1,
      doneSpans: 1,
      totalSpans: 8,
      failedSpans: 0,
      unitsSpent: 0,
      proposedDrafts: 0,
      appliedDrafts: 0,
    }
    render(<AutopilotProcessGraph overview={overview} compact />)
    expect(screen.getByTestId("autopilot-process-graph-mini")).toBeInTheDocument()
    expect(screen.queryByText("Process")).not.toBeInTheDocument()
    expect(screen.queryByText("Now: LUK 1:1–1:8")).not.toBeInTheDocument()
  })
})
