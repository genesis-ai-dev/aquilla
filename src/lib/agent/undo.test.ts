import { describe, expect, it } from "vitest"
import type { AgentProposal, StagedEvent } from "./protocol"
import { proposalRowKey, type RowDecision } from "./working-set"
import { buildUndoEvents } from "./undo"

const commit = (cellId: string, over: Partial<StagedEvent> = {}): StagedEvent => ({
  kind: "target.cell.commit",
  fileId: "f1",
  cellId,
  parentId: `parent-${cellId}`,
  payload: {
    value: `[draft] ${cellId}`,
    sourceEventId: `src-${cellId}`,
    ai_suggestion: true,
    agent_run_id: "run-1",
  },
  display: { canonicalRef: `MRK 4:${cellId.slice(1)}`, before: `old ${cellId}`, after: `[draft] ${cellId}` },
  ...over,
})

const proposal = (events: StagedEvent[]): AgentProposal => ({
  proposalId: "prop-1",
  runId: "run-1",
  events,
  summary: "Draft cells",
})

const decision = (
  cellId: string,
  outcome: RowDecision["outcome"],
  appliedEventId?: string,
): [string, RowDecision] => [
  proposalRowKey("prop-1", cellId),
  { outcome, value: `[draft] ${cellId}`, appliedEventId },
]

describe("buildUndoEvents", () => {
  it("compensates accepted and edited rows back to display.before", () => {
    const p = proposal([commit("c1"), commit("c2")])
    const decided = new Map([decision("c1", "accepted", "e1"), decision("c2", "edited", "e2")])

    const plan = buildUndoEvents(p, decided)

    expect(plan.events).toHaveLength(2)
    expect(plan.skipped).toBe(0)
    expect(plan.cellIds).toEqual(["c1", "c2"])
    const [u1] = plan.events
    expect(u1.kind).toBe("target.cell.commit")
    expect(u1.payload.value).toBe("old c1")
    expect(u1.parentId).toBe("e1") // chains on the accept's own event
    expect(plan.restoredValues.get("c2")).toBe("old c2")
  })

  it("carries undo provenance, never agent provenance", () => {
    const p = proposal([commit("c1")])
    const plan = buildUndoEvents(p, new Map([decision("c1", "accepted", "e1")]))

    const payload = plan.events[0].payload
    expect(payload.undo_of_agent_run_id).toBe("run-1")
    expect(payload.agent_run_id).toBeUndefined()
    expect(payload.ai_suggestion).toBeUndefined()
    // The AD-9 pin from the original staged commit survives.
    expect(payload.sourceEventId).toBe("src-c1")
  })

  it("ignores pending, rejected, and already-undone rows", () => {
    const p = proposal([commit("c1"), commit("c2"), commit("c3"), commit("c4")])
    const decided = new Map([
      decision("c1", "accepted", "e1"),
      decision("c2", "rejected"),
      decision("c3", "undone", "e3"),
      // c4 undecided
    ])

    const plan = buildUndoEvents(p, decided)

    expect(plan.cellIds).toEqual(["c1"])
    expect(plan.skipped).toBe(0) // ignored rows are not "skipped" — they wrote nothing
  })

  it("skips rows whose chain head moved on since the accept", () => {
    const p = proposal([commit("c1"), commit("c2")])
    const decided = new Map([decision("c1", "accepted", "e1"), decision("c2", "accepted", "e2")])
    const heads = new Map([
      ["c1", "e1"], // untouched — undoable
      ["c2", "someone-elses-edit"], // edited since — must not clobber
    ])

    const plan = buildUndoEvents(p, decided, (cellId) => heads.get(cellId))

    expect(plan.cellIds).toEqual(["c1"])
    expect(plan.skipped).toBe(1)
  })

  it("still undoes when the read model lags the apply (head = pre-apply pin)", () => {
    // AD-3: reads come from the server and the outbox never overlays them, so
    // right after Apply the projection may still show the stage-time head.
    const p = proposal([commit("c1")]) // staged parentId = "parent-c1"
    const decided = new Map([decision("c1", "accepted", "e1")])

    const plan = buildUndoEvents(p, decided, () => "parent-c1")

    expect(plan.cellIds).toEqual(["c1"])
    expect(plan.skipped).toBe(0)
  })

  it("restores empty string when the cell had no pre-run value", () => {
    const p = proposal([commit("c1", { display: { before: undefined, after: "[draft] c1" } })])
    const plan = buildUndoEvents(p, new Map([decision("c1", "accepted", "e1")]))

    expect(plan.events[0].payload.value).toBe("")
    expect(plan.restoredValues.get("c1")).toBe("")
  })

  it("records the drafted text as the undo's display.before", () => {
    const p = proposal([commit("c1")])
    const plan = buildUndoEvents(p, new Map([decision("c1", "accepted", "e1")]))

    expect(plan.events[0].display.before).toBe("[draft] c1")
    expect(plan.events[0].display.after).toBe("old c1")
  })
})
