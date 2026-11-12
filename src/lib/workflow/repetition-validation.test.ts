// AQU-1486 — which repetitions "Validate all" signs off, and how a bulk run
// plans its repetition groups as a whole.

import { describe, it, expect } from "vitest"
import {
  candidateForRule,
  planBulkRepetitionGroups,
  planGroupRepetition,
  planRepetitionValidation,
  repetitionValidationRoom,
  ruleForPick,
  type RepetitionValidationCell,
} from "./repetition-validation"

const SOURCE = "Grace and peace to you."
const cell = (over: Partial<RepetitionValidationCell> & { id: string }): RepetitionValidationCell => ({
  fileId: "f1",
  original: SOURCE,
  translated: "",
  status: "empty",
  targetEventId: `t-${over.id}`,
  sourceEventId: `s-${over.id}`,
  ...over,
})
const everyone = () => true

describe("planRepetitionValidation", () => {
  it("validates what it fills plus identical rows nobody signed off, and nothing it may not touch", () => {
    const cells = [
      cell({ id: "seed", translated: "Neema na amani.", status: "validated", activeValidators: ["me"] }),
      cell({ id: "empty" }),
      cell({ id: "differs", translated: "Old text", status: "unvalidated" }),
      cell({ id: "identical", translated: "Neema na amani.", status: "unvalidated" }),
      cell({ id: "identicalMine", translated: "Neema na amani.", status: "unvalidated", activeValidators: ["me"] }),
      cell({ id: "validated", translated: "Other", status: "validated" }),
      cell({ id: "hidden", hidden: true }),
      cell({ id: "locked" }),
      cell({ id: "otherFile", fileId: "f2" }),
      cell({ id: "otherSource", original: "Something else." }),
    ]
    const plan = planRepetitionValidation({
      seedId: "seed",
      cells,
      username: "me",
      isWritable: (c) => c.id !== "locked",
    })
    expect(plan.fills.map((c) => c.cellId)).toEqual(["empty", "differs"])
    // Each fill is pinned to its own row, not the seed's (AQU-1391).
    expect(plan.fills[1]).toMatchObject({ parentId: "t-differs", previousValue: "Old text" })
    expect(plan.validateIds).toEqual(["empty", "differs", "identical"])
  })

  it("plans nothing for a row without a translation or a repeated source", () => {
    const cells = [cell({ id: "seed" }), cell({ id: "other" })]
    expect(planRepetitionValidation({ seedId: "seed", cells, username: "me", isWritable: everyone }))
      .toEqual({ fills: [], validateIds: [] })
  })

  // AQU-2045: every row made from a recording stores the same file name.
  it("on rows made from a recording, offers only the rows whose transcript repeats", () => {
    const fromRecording = (over: Partial<RepetitionValidationCell> & { id: string }) =>
      cell({ original: "speech.webm", medium: "media", ...over })
    const cells = [
      fromRecording({ id: "seed", transcription: "Amen.", translated: "Amina.", status: "validated", activeValidators: ["me"] }),
      fromRecording({ id: "sameWords", transcription: "Amen." }),
      fromRecording({ id: "sameWordsDone", transcription: "Amen.", translated: "Amina.", status: "unvalidated" }),
      fromRecording({ id: "otherWords", transcription: "Grace and peace." }),
      fromRecording({ id: "noTranscript" }),
    ]
    const plan = planRepetitionValidation({ seedId: "seed", cells, username: "me", isWritable: everyone })
    expect(plan.fills.map((c) => c.cellId)).toEqual(["sameWords"])
    expect(plan.validateIds).toEqual(["sameWords", "sameWordsDone"])
  })
})

describe("planBulkRepetitionGroups", () => {
  const cells = [
    cell({ id: "a1", translated: "Neema.", status: "unvalidated" }),
    cell({ id: "a2", translated: "Amani.", status: "unvalidated" }),
    cell({ id: "a3" }),
    cell({ id: "a4", translated: "Neema.", status: "unvalidated" }),
    cell({ id: "b1", original: "Second line.", translated: "Mstari.", status: "unvalidated" }),
    cell({ id: "b2", original: "Second line.", translated: "Mstari.", status: "unvalidated" }),
    cell({ id: "c1", original: "Third line.", translated: "Tatu.", status: "unvalidated" }),
    cell({ id: "c2", original: "Third line.", translated: "Tatu.", status: "validated" }),
  ]

  it("keeps the run's own rows as seeds, collects disagreeing translations, and drops groups with no target", () => {
    const groups = planBulkRepetitionGroups({
      seedIds: ["a4", "a1", "a2", "b1", "b2", "c1"],
      cells,
      isWritable: everyone,
    })
    // Group b has no row outside the run; group c's only other row is validated.
    expect(groups).toHaveLength(1)
    const [group] = groups
    // Document order, not selection order; a1 and a4 share one translation.
    expect(group.candidates.map((c) => [c.value, c.cellIds])).toEqual([
      ["Neema.", ["a1", "a4"]],
      ["Amani.", ["a2"]],
    ])
    expect(group.targets.map((c) => c.id)).toEqual(["a3"])
  })

  it("groups rows made from a recording by transcript (AQU-2045)", () => {
    const fromRecording = (over: Partial<RepetitionValidationCell> & { id: string }) =>
      cell({ original: "speech.webm", medium: "media", ...over })
    const groups = planBulkRepetitionGroups({
      seedIds: ["m1", "m2"],
      cells: [
        fromRecording({ id: "m1", transcription: "Amen.", translated: "Amina.", status: "unvalidated" }),
        fromRecording({ id: "m2", transcription: "Grace and peace.", translated: "Neema.", status: "unvalidated" }),
        fromRecording({ id: "m3", transcription: "Amen." }),
        fromRecording({ id: "m4" }),
      ],
      isWritable: everyone,
    })
    expect(groups.map((g) => g.targets.map((c) => c.id))).toEqual([["m3"]])
  })

  it("maps a pick to a reusable rule and back", () => {
    const [group] = planBulkRepetitionGroups({ seedIds: ["a1", "a2"], cells, isWritable: everyone })
    expect([ruleForPick(group, 0), ruleForPick(group, 1), ruleForPick(group, "skip")]).toEqual(["first", "last", "skip"])
    expect(candidateForRule(group, "first")?.value).toBe("Neema.")
    expect(candidateForRule(group, "last")?.value).toBe("Amani.")
    expect(candidateForRule(group, "skip")).toBeNull()

    // a3 is empty and a4 already says "Neema.": choosing it fills one row and
    // signs off both; choosing "Amani." rewrites a4 too.
    const neema = planGroupRepetition({ group, candidate: group.candidates[0], username: "me" })
    expect(neema.fills.map((c) => c.cellId)).toEqual(["a3"])
    expect(neema.validateIds).toEqual(["a3", "a4"])
    const amani = planGroupRepetition({ group, candidate: group.candidates[1], username: "me" })
    expect(amani.fills.map((c) => c.cellId)).toEqual(["a3", "a4"])
  })
})

describe("repetitionValidationRoom", () => {
  it("counts repetition votes toward the batch validation size", () => {
    expect([
      repetitionValidationRoom(undefined, 5),
      repetitionValidationRoom(0, 5),
      repetitionValidationRoom(20, 5),
      repetitionValidationRoom(5, 8),
    ]).toEqual([null, null, 15, 0])
  })
})
