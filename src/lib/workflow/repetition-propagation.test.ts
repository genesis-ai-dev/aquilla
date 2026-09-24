// AQU-1391 — the wiring the pure engine can't cover: per-cell AD-2 parents,
// per-cell AD-9 source pins, and the undo snapshot.

import { describe, it, expect } from "vitest"
import {
  planRepetitionPropagation,
  buildRepetitionCounts,
  type RepetitionCell,
} from "./repetition-propagation"

const cell = (over: Partial<RepetitionCell> & { id: string }): RepetitionCell => ({
  fileId: "f1",
  original: "Click Save.",
  translated: "",
  status: "empty",
  ...over,
})

describe("planRepetitionPropagation", () => {
  const confirmed = cell({
    id: "c1",
    translated: "Cliquez sur Enregistrer.",
    translatedHtml: "<p>Cliquez sur Enregistrer.</p>",
    status: "validated",
    targetEventId: "t1",
    sourceEventId: "s1",
  })

  it("pins every commit to its OWN target head and source event, not the confirmed cell's", () => {
    const commits = planRepetitionPropagation({
      confirmedCellId: "c1",
      cells: [
        confirmed,
        cell({ id: "c2", status: "unvalidated", targetEventId: "t2", sourceEventId: "s2" }),
        cell({ id: "c3", status: "empty", sourceEventId: "s3" }),
      ],
    })

    expect(commits.map((c) => c.cellId)).toEqual(["c2", "c3"])
    expect(commits[0]).toMatchObject({ parentId: "t2", sourceEventId: "s2" })
    // No target row projected yet: the source event is the genesis chain head,
    // and it is still this cell's own source pin.
    expect(commits[1]).toMatchObject({ parentId: "s3", sourceEventId: "s3" })
    for (const c of commits) {
      expect(c.parentId).not.toBe("t1")
      expect(c.sourceEventId).not.toBe("s1")
    }
  })

  it("prefers the workspace resolver's head (a pending outbox commit) over the lagging projection head", () => {
    const commits = planRepetitionPropagation({
      confirmedCellId: "c1",
      cells: [confirmed, cell({ id: "c2", status: "unvalidated", targetEventId: "t2", sourceEventId: "s2" })],
      resolveParentId: (c) => (c.id === "c2" ? "pending-2" : null),
    })
    expect(commits[0].parentId).toBe("pending-2")
  })

  it("carries the confirmed cell's value and rich text to each receiver", () => {
    const [commit] = planRepetitionPropagation({
      confirmedCellId: "c1",
      cells: [confirmed, cell({ id: "c2", status: "unvalidated", sourceEventId: "s2" })],
    })
    expect(commit.value).toBe("Cliquez sur Enregistrer.")
    expect(commit.valueHtml).toBe("<p>Cliquez sur Enregistrer.</p>")
  })

  it("snapshots the pre-propagation value so Undo can restore it", () => {
    const [commit] = planRepetitionPropagation({
      confirmedCellId: "c1",
      cells: [
        confirmed,
        cell({
          id: "c2",
          status: "unvalidated",
          translated: "ancienne valeur",
          translatedHtml: "<p>ancienne valeur</p>",
          sourceEventId: "s2",
        }),
      ],
    })
    expect(commit.previousValue).toBe("ancienne valeur")
    expect(commit.previousValueHtml).toBe("<p>ancienne valeur</p>")
  })

  it("skips validated cells, the confirmed cell, and cells already carrying the text", () => {
    const commits = planRepetitionPropagation({
      confirmedCellId: "c1",
      cells: [
        confirmed,
        cell({ id: "validated", status: "validated", translated: "autre", sourceEventId: "s2" }),
        cell({ id: "same", status: "unvalidated", translated: "Cliquez sur Enregistrer.", sourceEventId: "s3" }),
        cell({ id: "eligible", status: "unvalidated", sourceEventId: "s4" }),
      ],
    })
    expect(commits.map((c) => c.cellId)).toEqual(["eligible"])
  })

  it("matches on normalized source (case and whitespace) but not on different text", () => {
    const commits = planRepetitionPropagation({
      confirmedCellId: "c1",
      cells: [
        confirmed,
        cell({ id: "loose", original: "  click   SAVE. ", status: "empty", sourceEventId: "s2" }),
        cell({ id: "other", original: "Click Cancel.", status: "empty", sourceEventId: "s3" }),
      ],
    })
    expect(commits.map((c) => c.cellId)).toEqual(["loose"])
  })

  it("never writes across files", () => {
    const commits = planRepetitionPropagation({
      confirmedCellId: "c1",
      cells: [confirmed, cell({ id: "other-file", fileId: "f2", status: "empty", sourceEventId: "s2" })],
    })
    expect(commits).toEqual([])
  })

  it("returns nothing for an unknown cell, an empty source, or an empty translation", () => {
    expect(planRepetitionPropagation({ confirmedCellId: "nope", cells: [confirmed] })).toEqual([])
    expect(
      planRepetitionPropagation({
        confirmedCellId: "c1",
        cells: [{ ...confirmed, original: "   " }, cell({ id: "c2", original: "   ", status: "empty" })],
      }),
    ).toEqual([])
    expect(
      planRepetitionPropagation({
        confirmedCellId: "c1",
        cells: [{ ...confirmed, translated: "" }, cell({ id: "c2", status: "empty" })],
      }),
    ).toEqual([])
  })
})

describe("buildRepetitionCounts", () => {
  it("counts only sources that repeat, including validated occurrences", () => {
    const counts = buildRepetitionCounts([
      cell({ id: "a" }),
      cell({ id: "b", original: "click   save." , status: "validated" }),
      cell({ id: "c" }),
      cell({ id: "unique", original: "Click Cancel." }),
      cell({ id: "blank", original: "  " }),
    ])
    expect(counts.get("a")).toBe(3)
    expect(counts.get("b")).toBe(3)
    expect(counts.get("c")).toBe(3)
    expect(counts.has("unique")).toBe(false)
    expect(counts.has("blank")).toBe(false)
  })
})
