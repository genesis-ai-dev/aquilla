import { describe, expect, it } from "vitest"

import { splitPendingActions } from "./pending-groups"
import type { ContextualActivityDraft, ContextualDecisionView } from "./transport"

function draft(
  spanId: string,
  spanLabel: string,
  cellId: string,
  createdAt: string,
  fileId = "file-1",
): ContextualActivityDraft {
  return {
    id: `draft-${cellId}`,
    fileId,
    cellId,
    cellLabel: cellId,
    spanLabel,
    status: "proposed",
    createdAt,
    provenance: { spanId },
  }
}

function decision(
  id: string,
  spanId: string | null,
  status: ContextualDecisionView["status"] = "open",
): ContextualDecisionView {
  return {
    id,
    fileId: "file-1",
    spanId,
    cellIds: [],
    reason: `why ${id}`,
    readinessItem: null,
    blastRadius: 0,
    status,
    assignedUserId: null,
  }
}

/** Three passages staged in passage order, 10 drafts in the last one. */
function backlog(): ContextualActivityDraft[] {
  return [
    draft("span-1", "LUK 1:1–1:8", "LUK 1:1", "2026-09-17T01:00:00.000Z"),
    draft("span-1", "LUK 1:1–1:8", "LUK 1:2", "2026-09-17T01:00:01.000Z"),
    draft("span-2", "LUK 2:1–2:6", "LUK 2:1", "2026-09-17T02:00:00.000Z"),
    ...Array.from({ length: 10 }, (_, i) =>
      draft("span-3", "LUK 3:1–3:10", `LUK 3:${i + 1}`, `2026-09-17T03:00:0${i}.000Z`)),
  ]
}

describe("splitPendingActions", () => {
  it("leads with the last passage staged and collapses the rest to a count", () => {
    const split = splitPendingActions(backlog(), [])
    expect(split.current?.spanLabel).toBe("LUK 3:1–3:10")
    expect(split.current?.drafts).toHaveLength(10)
    // The remainder is a count, not a flat pile of every earlier draft.
    expect(split.restDraftCount).toBe(3)
    expect(split.restPassageCount).toBe(2)
    expect(split.restFileCount).toBe(1)
  })

  it("orders the collapsed remainder by passage, not by arrival", () => {
    // Feed the drafts newest-first, the order the keyset cursor actually returns.
    const split = splitPendingActions([...backlog()].reverse(), [])
    expect(split.rest.map((group) => group.spanLabel)).toEqual([
      "LUK 1:1–1:8",
      "LUK 2:1–2:6",
    ])
    expect(split.current?.spanLabel).toBe("LUK 3:1–3:10")
  })

  it("makes the blocked passage current, ahead of the last one staged", () => {
    const split = splitPendingActions(backlog(), [decision("d1", "span-2")])
    expect(split.current?.spanLabel).toBe("LUK 2:1–2:6")
    expect(split.current?.decisions.map((d) => d.id)).toEqual(["d1"])
    // The passage that was merely last still exists — as part of the count.
    expect(split.rest.map((group) => group.spanLabel)).toEqual([
      "LUK 1:1–1:8",
      "LUK 3:1–3:10",
    ])
  })

  it("never collapses an open decision into the remainder count", () => {
    const split = splitPendingActions(backlog(), [decision("d1", "span-2")])
    const collapsed = split.rest.flatMap((group) => group.decisions)
    expect(collapsed).toEqual([])
    expect(split.current?.decisions).toHaveLength(1)
  })

  it("keeps a decision whose passage staged no draft out of the count", () => {
    const split = splitPendingActions(backlog(), [decision("d9", "span-unstaged")])
    expect(split.unplacedDecisions.map((d) => d.id)).toEqual(["d9"])
    expect(split.rest.flatMap((group) => group.decisions)).toEqual([])
  })

  it("surfaces open decisions when there are no drafts at all", () => {
    const split = splitPendingActions([], [decision("d1", "span-2")])
    expect(split.current).toBeNull()
    expect(split.restDraftCount).toBe(0)
    expect(split.unplacedDecisions.map((d) => d.id)).toEqual(["d1"])
  })

  it("ignores decisions that are not open", () => {
    const split = splitPendingActions(backlog(), [decision("d1", "span-2", "resolved")])
    // A resolved question must not drag the reviewer back to a finished passage.
    expect(split.current?.spanLabel).toBe("LUK 3:1–3:10")
    expect(split.unplacedDecisions).toEqual([])
  })

  it("reports no remainder when the backlog is only the current passage", () => {
    const single = [
      draft("span-1", "LUK 1:1–1:8", "LUK 1:1", "2026-09-17T01:00:00.000Z"),
      draft("span-1", "LUK 1:1–1:8", "LUK 1:2", "2026-09-17T01:00:01.000Z"),
    ]
    const split = splitPendingActions(single, [])
    expect(split.current?.drafts).toHaveLength(2)
    expect(split.rest).toEqual([])
    expect(split.restDraftCount).toBe(0)
    expect(split.restPassageCount).toBe(0)
  })

  it("prefers the live run passage over the last one staged", () => {
    const split = splitPendingActions(backlog(), [], "LUK 2:1–2:6")
    expect(split.current?.spanLabel).toBe("LUK 2:1–2:6")
  })

  it("counts files, not passages, when the backlog spans several files", () => {
    const split = splitPendingActions([
      draft("span-a", "GEN 1:1–1:5", "GEN 1:1", "2026-09-17T01:00:00.000Z", "file-a"),
      draft("span-b", "EXO 1:1–1:5", "EXO 1:1", "2026-09-17T02:00:00.000Z", "file-b"),
      draft("span-c", "EXO 2:1–2:5", "EXO 2:1", "2026-09-17T03:00:00.000Z", "file-b"),
      draft("span-d", "LEV 1:1–1:5", "LEV 1:1", "2026-09-17T04:00:00.000Z", "file-c"),
    ], [])
    expect(split.current?.fileId).toBe("file-c")
    expect(split.restPassageCount).toBe(3)
    expect(split.restFileCount).toBe(2)
  })

  it("groups drafts that carry no span id by their passage label", () => {
    const unlabelled: ContextualActivityDraft[] = [
      { id: "a", fileId: "f", cellId: "LUK 1:1", spanLabel: "LUK 1:1–1:4", status: "proposed", createdAt: "2026-09-17T01:00:00.000Z" },
      { id: "b", fileId: "f", cellId: "LUK 1:2", spanLabel: "LUK 1:1–1:4", status: "proposed", createdAt: "2026-09-17T01:00:01.000Z" },
      { id: "c", fileId: "f", cellId: "LUK 2:1", spanLabel: "LUK 2:1–2:4", status: "proposed", createdAt: "2026-09-17T02:00:00.000Z" },
    ]
    const split = splitPendingActions(unlabelled, [])
    expect(split.current?.spanLabel).toBe("LUK 2:1–2:4")
    expect(split.restPassageCount).toBe(1)
    expect(split.rest[0]?.drafts).toHaveLength(2)
  })

  it("sorts undated drafts last rather than treating them as the earliest passage", () => {
    const split = splitPendingActions([
      draft("span-1", "LUK 1:1–1:8", "LUK 1:1", "2026-09-17T01:00:00.000Z"),
      { id: "undated", fileId: "file-1", cellId: "LUK 9:1", spanLabel: "LUK 9:1–9:4", status: "proposed", provenance: { spanId: "span-9" } },
    ], [])
    expect(split.current?.spanLabel).toBe("LUK 9:1–9:4")
    expect(split.rest.map((group) => group.spanLabel)).toEqual(["LUK 1:1–1:8"])
  })
})
