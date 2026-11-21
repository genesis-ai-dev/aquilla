import { describe, expect, it } from "vitest"
import { resetEvents, SETTLED_TEXT, shortEdit, TYPED_SENTENCE, type TargetCell } from "./scenario-reset"

const meta = { projectId: "p", fileId: "f", author: "dev", now: 1 }
const cell = (cellId: string, value: string): TargetCell => ({
  cellId,
  value,
  eventId: `head-${cellId}`,
  sourceEventId: `src-${cellId}`,
  laneId: "lane-es",
  targetLang: "Spanish",
})

describe("resetEvents", () => {
  // PERF-BACKLOG item 37: text the scenario typed piles up run after run, rows grow taller, and
  // render counts drift on an unchanged tree. Every pass must start from the same cells.
  it("puts every cell a run typed into back to the settled text, whatever piled up", () => {
    const events = resetEvents(
      [
        cell("GEN 1:3", `${TYPED_SENTENCE}${TYPED_SENTENCE}Settled text.`),
        cell("GEN 1:4", "Short edit 1Short edit 1Short edit 1 "),
        cell("GEN 1:5", `${shortEdit(0)}${TYPED_SENTENCE}`),
      ],
      meta,
    )
    expect(events.filter((e) => e.kind === "target.cell.commit").map((e) => [e.cellId, e.payload.value])).toEqual([
      ["GEN 1:3", SETTLED_TEXT],
      ["GEN 1:4", SETTLED_TEXT],
      ["GEN 1:5", SETTLED_TEXT],
    ])
  })

  it("chains each reset on the cell's head and keeps its lane and source pin, so it is not a stale sibling", () => {
    const [commit] = resetEvents([cell("GEN 1:4", "Short edit 3 ")], meta)
    expect(commit.kind).toBe("target.cell.commit")
    expect(commit.parentId).toBe("head-GEN 1:4")
    expect(commit.payload).toMatchObject({ laneId: "lane-es", targetLang: "Spanish", sourceEventId: "src-GEN 1:4" })
  })

  // The editor validates a human edit. A reset left unvalidated turns the scenario's next commit
  // into a change of the validated set, which costs a confidence read and extra renders.
  it("validates each reset commit on the same lane, as the editor validates an edit", () => {
    const [commit, validate] = resetEvents([cell("GEN 1:4", "Short edit 3 ")], meta)
    expect(validate.kind).toBe("cell.validate")
    expect(validate.parentId).toBeNull()
    expect(validate.payload).toEqual({ editEventId: commit.id, laneId: "lane-es", targetLang: "Spanish" })
  })

  it("leaves cells the scenario never typed into, and cells already settled, alone", () => {
    const events = resetEvents([cell("GEN 1:9", "En el principio creó Dios"), cell("GEN 1:3", SETTLED_TEXT)], meta)
    expect(events).toEqual([])
  })

  it("does not settle a cell to empty text: the budgets describe an edit, not a first translation", () => {
    expect(SETTLED_TEXT.trim()).not.toBe("")
  })
})
