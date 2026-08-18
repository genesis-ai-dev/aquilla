// Comparing the two character sheets against each other. (AQU-646, 2026-08-18)
//
// The assertion that carries the most weight is the SILENCE: the two sheets
// write the same forty characters differently as a matter of course, and a
// comparison that reported every one of those would be noise nobody reads.

import { describe, it, expect } from "vitest"

import { compareCharacterSources, type ComparableCell } from "./character-agreement"
import { buildCueLinkIndex, type CueLink } from "@/lib/sync/cell-links-read"

const cell = (
  id: string,
  castName?: string,
  cameraState?: "on" | "off" | "mixed",
  original = "",
): ComparableCell => ({
  id,
  original,
  ...(castName !== undefined ? { metadata: { cast_name: castName } } : {}),
  ...(cameraState ? { cameraState } : {}),
})

const edge = (textCellId: string, cueCellId: string): CueLink => ({
  kind: "text-audio",
  fromFileId: "f-subs",
  fromCellId: textCellId,
  toFileId: "f-cues",
  toCellId: cueCellId,
  origin: "auto",
  confidence: 1,
})

const compare = (cue: ComparableCell, text: ComparableCell) =>
  compareCharacterSources({
    cues: [cue],
    textCells: [text],
    links: buildCueLinkIndex([edge(text.id, cue.id)]),
  }).open

describe("what it stays quiet about", () => {
  it("says nothing when the two sheets agree", () => {
    expect(compare(cell("c1", "JESUS", "on"), cell("s1", "JESUS", "on"))).toEqual([])
  })

  it("ignores the trailing full stop one sheet uses and the other does not", () => {
    // Verbatim from episode 101: the subtitle sheet writes "ANDREW.", the audio
    // sheet "ANDREW". Comparing raw strings would report all 637 rows.
    expect(compare(cell("c1", "ANDREW", "on"), cell("s1", "ANDREW.", "on"))).toEqual([])
  })

  it("ignores the non-breaking space the audio sheet separates with", () => {
    expect(compare(cell("c1", "MARY MAGDALENE", "on"), cell("s1", "MARY MAGDALENE.", "on")))
      .toEqual([])
  })

  it("ignores case and stray spacing", () => {
    expect(
      compare(cell("c1", "little mary  magdalene", "on"), cell("s1", "LITTLE MARY MAGDALENE.", "on")),
    ).toEqual([])
  })

  it("does not let MIXED contradict a specific state", () => {
    // A subtitle row spanning three heard lines is genuinely mixed while each
    // of those lines is individually on or off — the coarser source being
    // coarse, not a contradiction. Measured: without this the real episode-101
    // pair reports 189 camera conflicts instead of 79, burying the six speaker
    // disagreements that actually matter.
    expect(compare(cell("c1", "JESUS", "on"), cell("s1", "JESUS.", "mixed"))).toEqual([])
    expect(compare(cell("c1", "JESUS", "mixed"), cell("s1", "JESUS.", "off"))).toEqual([])
  })

  it("does not call a MISSING camera state a disagreement", () => {
    // A sheet with no camera column would otherwise contradict every row of
    // one that has it. That is an absence, not a finding.
    expect(compare(cell("c1", "JESUS", "on"), cell("s1", "JESUS."))).toEqual([])
    expect(compare(cell("c1", "JESUS"), cell("s1", "JESUS.", "off"))).toEqual([])
  })

  it("compares nothing when only ONE sheet has been imported", () => {
    // Nothing to disagree with. Reporting six hundred "the other sheet is
    // silent here" rows would bury the handful that matter.
    expect(compare(cell("c1"), cell("s1", "JESUS", "on"))).toEqual([])
    expect(compare(cell("c1", "JESUS", "on"), cell("s1"))).toEqual([])
  })

  it("compares nothing across a link that does not exist", () => {
    expect(
      compareCharacterSources({
        cues: [cell("c1", "JESUS", "on")],
        textCells: [cell("s1", "MARY", "off")],
        links: buildCueLinkIndex([]),
      }).open,
    ).toEqual([])
  })

  it("COUNTS a row serving several cues instead of offering it", () => {
    // Episode 101's "Good. Good." — one row labelled ANDREW covering an Andrew
    // line and a Simon line. Its single name cannot be right about both, the
    // per-line display is already correct, and offering buttons would invite
    // writing one speaker over the other. This is also what makes writing to
    // both cells safe everywhere else.
    const r = compareCharacterSources({
      cues: [cell("c1", "ANDREW", "on"), cell("c2", "SIMON", "off")],
      textCells: [cell("s1", "ANDREW.", "off")],
      links: buildCueLinkIndex([edge("s1", "c1"), edge("s1", "c2")]),
    })
    expect(r.open).toEqual([])
    expect(r.sharedRows).toBe(2)
  })
})

describe("what it reports", () => {
  it("flags two different people as a CHARACTER disagreement", () => {
    const [d] = compare(cell("c1", "JESUS", "on", "Peace."), cell("s1", "MARY", "on"))
    expect(d.name).toEqual({ kind: "character", subtitle: "MARY", audio: "JESUS" })
    expect(d.heard).toBe("Peace.")
  })

  it("flags the same person with a different shot", () => {
    const [d] = compare(cell("c1", "JESUS", "on"), cell("s1", "JESUS.", "off"))
    expect(d.name).toBeUndefined()
    expect(d.camera).toEqual({ subtitle: "off", audio: "on" })
  })

  it("flags one name typed two ways as a NAMING inconsistency", () => {
    // A real find in episode 101's own files, and a different thing from two
    // people: it is a typo to hand back, not a contradiction about who speaks.
    const [d] = compare(cell("c1", "MALE VENDOR #1", "on"), cell("s1", "MALEVENDOR #1", "on"))
    expect(d.name?.kind).toBe("naming")
  })

  it("puts BOTH axes on ONE row when a line differs about both", () => {
    // Episode 101's "Good." — SIMON on camera against ANDREW off. Two rows
    // would mean settling the name and watching a second row appear for the
    // shot, which reads like the fix did not take.
    const [d] = compare(cell("c1", "SIMON", "on", "Good."), cell("s1", "ANDREW.", "off"))
    expect(d.name).toEqual({ kind: "character", subtitle: "ANDREW.", audio: "SIMON" })
    expect(d.camera).toEqual({ subtitle: "off", audio: "on" })
  })

  it("puts a wrong speaker above a spelling difference", () => {
    const out = compareCharacterSources({
      cues: [cell("c1", "MALE VENDOR #1", "on"), cell("c2", "JESUS", "on")],
      textCells: [cell("s1", "MALEVENDOR #1", "on"), cell("s2", "MARY", "on")],
      links: buildCueLinkIndex([edge("s1", "c1"), edge("s2", "c2")]),
    }).open
    expect(out.map((d) => d.name?.kind)).toEqual(["character", "naming"])
  })
})

describe("the agreed axis rides along as context", () => {
  it("a speaker dispute carries the agreed camera angle", () => {
    const [d] = compare(cell("c1", "JESUS", "on", "Peace."), cell("s1", "MARY", "on"))
    expect(d.context).toEqual({ camera: "on" })
  })

  it("a camera dispute carries the agreed name", () => {
    const [d] = compare(cell("c1", "JESUS", "on"), cell("s1", "JESUS.", "off"))
    expect(d.context).toEqual({ name: "JESUS" })
  })

  it("a dispute about BOTH carries no context — nothing is agreed", () => {
    const [d] = compare(cell("c1", "SIMON", "on", "Good."), cell("s1", "ANDREW.", "off"))
    expect(d.context).toBeUndefined()
  })
})

describe("what has already been settled", () => {
  const settled = (over: Record<string, unknown> = {}) =>
    compareCharacterSources({
      // After a resolution BOTH cells agree — that is the point of it — so the
      // rejected answer survives only in the record.
      cues: [cell("c1", "NICODEMUS", "on", "I'm on official business.")],
      textCells: [cell("s1", "NICODEMUS.", "on")],
      links: buildCueLinkIndex([edge("s1", "c1")]),
      resolutions: {
        "s1 c1": { name: { chose: "subtitle", rejected: "QUINTUS" }, at: 5 },
        ...over,
      },
    })

  it("moves a settled link to Resolved rather than dropping it", () => {
    // Nothing ever leaves the drawer (Sam, 2026-08-18) — it moves out of the
    // way but stays readable and reversible.
    const r = settled()
    expect(r.open).toEqual([])
    expect(r.resolved).toHaveLength(1)
    expect(r.resolved[0].name).toEqual({
      chose: "subtitle",
      current: "NICODEMUS",
      rejected: "QUINTUS",
    })
  })

  it("keeps a link OPEN while any axis is still undecided", () => {
    const r = compareCharacterSources({
      cues: [cell("c1", "SIMON", "on", "Good.")],
      textCells: [cell("s1", "SIMON.", "off")],
      links: buildCueLinkIndex([edge("s1", "c1")]),
      resolutions: { "s1 c1": { name: { chose: "audio", rejected: "ANDREW." }, at: 5 } },
    })
    expect(r.resolved).toEqual([])
    expect(r.open).toHaveLength(1)
    // …and it says which half is already decided, so the row does not look
    // untouched.
    expect(r.open[0].camera).toBeDefined()
    expect(r.open[0].settled?.name?.rejected).toBe("ANDREW.")
  })

  it("says nothing about an agreeing link with no record — it was never an argument", () => {
    const r = compareCharacterSources({
      cues: [cell("c1", "JESUS", "on")],
      textCells: [cell("s1", "JESUS.", "on")],
      links: buildCueLinkIndex([edge("s1", "c1")]),
      resolutions: {},
    })
    expect(r.open).toEqual([])
    expect(r.resolved).toEqual([])
  })

  it("retires a record that rejects the value it chose — it says nothing", () => {
    // The re-click bug wrote records like {rejected: "NICODEMUS."} onto a pair
    // whose cells both say NICODEMUS. — a choice between a thing and itself.
    // Any such record written before the fix must not render as one.
    const r = compareCharacterSources({
      cues: [cell("c1", "NICODEMUS", "on")],
      textCells: [cell("s1", "NICODEMUS.", "on")],
      links: buildCueLinkIndex([edge("s1", "c1")]),
      resolutions: { "s1 c1": { name: { chose: "subtitle", rejected: "NICODEMUS" }, at: 5 } },
    })
    expect(r.open).toEqual([])
    expect(r.resolved).toEqual([])
  })

  it("shows the newest decision first", () => {
    const r = compareCharacterSources({
      cues: [cell("c1", "A", "on"), cell("c2", "B", "on")],
      textCells: [cell("s1", "A", "on"), cell("s2", "B", "on")],
      links: buildCueLinkIndex([edge("s1", "c1"), edge("s2", "c2")]),
      resolutions: {
        "s1 c1": { name: { chose: "subtitle", rejected: "X" }, at: 1 },
        "s2 c2": { name: { chose: "subtitle", rejected: "Y" }, at: 9 },
      },
    })
    expect(r.resolved.map((x) => x.cueCellId)).toEqual(["c2", "c1"])
  })
})
