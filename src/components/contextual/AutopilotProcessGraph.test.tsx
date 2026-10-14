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

  // AQU-1685: the Bible data steps belong to the Bible data experiment. A
  // device without it draws the graph from before them; one with it, both steps.
  it("draws the Bible facts and Bible checks steps only with the Bible data experiment on", () => {
    render(<AutopilotProcessGraph run={run} activity={activity} />)
    expect(screen.queryByRole("button", { name: "Bible facts" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Bible checks" })).toBeNull()
    expect(screen.getByRole("button", { name: "Situation" })).toBeInTheDocument()
    cleanup()
    render(<AutopilotProcessGraph run={run} activity={activity} bibleData />)
    expect(screen.getByRole("button", { name: "Bible facts" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Bible checks" })).toBeInTheDocument()
  })

  // AQU-1685: a span outcome's "bible_data_*" reasons say the Bible data pack
  // did not load. Like the rest of Bible data they show only with the experiment.
  it("lists a span's Bible data reasons in inspect only with the Bible data experiment on", () => {
    const outcome = {
      ...activity.events[0],
      id: "e3",
      kind: "span_outcome",
      status: "partial",
      details: { reasons: ["target_already_filled", "bible_data_offline"] },
      createdAt: "2026-08-16T10:01:30.000Z",
    } as ContextualRunActivity["events"][number]
    const withOutcome = { ...activity, events: [...activity.events, outcome] }
    render(<AutopilotProcessGraph run={run} activity={withOutcome} />)
    fireEvent.click(screen.getByRole("button", { name: "Situation" }))
    let inspect = screen.getByTestId("autopilot-process-graph-inspect")
    expect(inspect).toHaveTextContent("target_already_filled")
    expect(inspect).not.toHaveTextContent("bible_data_offline")
    cleanup()
    render(<AutopilotProcessGraph run={run} activity={withOutcome} bibleData />)
    fireEvent.click(screen.getByRole("button", { name: "Situation" }))
    inspect = screen.getByTestId("autopilot-process-graph-inspect")
    expect(inspect).toHaveTextContent("target_already_filled · bible_data_offline")
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

  it("shows a passage range in inspect instead of cell UUIDs", () => {
    const opaque = "01920000-0000-7000-8000-000000000001"
    render(<AutopilotProcessGraph
      run={{ ...run, spanLabel: opaque }}
      activity={{
        ...activity,
        events: activity.events.map((event) => ({ ...event, spanLabel: "1–12" })),
        sceneBriefs: [{
          ...activity.sceneBriefs[0],
          startCellId: opaque,
          endCellId: opaque,
          spanLabel: "1–12",
        }],
      }}
    />)
    fireEvent.click(screen.getByRole("button", { name: "Situation" }))
    const inspect = screen.getByTestId("autopilot-process-graph-inspect")
    expect(inspect).toHaveTextContent("1–12")
    expect(inspect).not.toHaveTextContent(opaque)
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
