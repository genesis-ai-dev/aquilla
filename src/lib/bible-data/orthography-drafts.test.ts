import { describe, expect, it } from "vitest"
import {
  orthographyDraft,
  orthographyExceptionsCsv,
  orthographyValue,
  type OrthographyDraft,
} from "./language-profile-drafts"
import { CANONICAL_APOSTROPHE, orthographyProblem } from "../../../db/shared/orthography"

const empty: OrthographyDraft = { rules: "", apostrophe: CANONICAL_APOSTROPHE, exceptions: [], added: "" }

describe("orthographyDraft", () => {
  it("opens an empty row on the canonical apostrophe", () => {
    expect(orthographyDraft(undefined)).toEqual(empty)
  })

  it("shows the stored rules one per line, and keeps each exception whole", () => {
    const draft = orthographyDraft({
      rules: [["sh", "ş"], ["ch", "ç"]],
      apostrophe: CANONICAL_APOSTROPHE,
      exceptions: [{ word: "Ishoq", status: "pending", by: "u_7", ref: "GEN 17:19" }],
    })
    expect(draft.rules).toBe("sh > ş\nch > ç")
    expect(draft.exceptions).toEqual([{ word: "Ishoq", status: "pending", by: "u_7", ref: "GEN 17:19" }])
  })
})

describe("orthographyValue", () => {
  it("stores nothing while the row has no rules", () => {
    expect(orthographyValue(empty)).toBeNull()
    expect(orthographyValue({ ...empty, added: "Ishoq" })).toBeNull()
  })

  it("reads a rule written with any of the arrows people type", () => {
    for (const arrow of [">", "→", "=>", "->"]) {
      expect(orthographyValue({ ...empty, rules: `sh ${arrow} ş` })?.rules).toEqual([["sh", "ş"]])
    }
  })

  it("lower-cases the old spelling, since the capitals are derived", () => {
    expect(orthographyValue({ ...empty, rules: "SH > Ş" })?.rules).toEqual([["sh", "Ş"]])
  })

  it("refuses a line that is not a pair rather than storing half of it", () => {
    expect(orthographyValue({ ...empty, rules: "sh > ş\nchch" })).toBeNull()
  })

  it("adds pasted words as approved, one per line, without duplicating", () => {
    const value = orthographyValue({
      ...empty,
      rules: "sh > ş",
      exceptions: [{ word: "Isʼhoq", status: "approved" }],
      added: "asʼhob\n\nIsʼhoq\n masʼhur ",
    })
    expect(value?.exceptions).toEqual([
      { word: "Isʼhoq", status: "approved" },
      { word: "asʼhob", status: "approved" },
      { word: "masʼhur", status: "approved" },
    ])
  })

  it("never approves a pending entry as a side effect of pasting it again", () => {
    const value = orthographyValue({
      ...empty,
      rules: "sh > ş",
      exceptions: [{ word: "Ishoq", status: "pending", by: "u_7" }],
      added: "Ishoq",
    })
    expect(value?.exceptions).toEqual([{ word: "Ishoq", status: "pending", by: "u_7" }])
  })

  it("produces a value the slot validator accepts", () => {
    const value = orthographyValue({
      ...empty,
      rules: "sh > ş\nch > ç",
      added: "Isʼhoq",
    })
    expect(orthographyProblem(value)).toBeNull()
  })

  it("round-trips a stored slot through the draft unchanged", () => {
    const stored = {
      rules: [["sh", "ş"], ["oʻ", "ö"]],
      apostrophe: CANONICAL_APOSTROPHE,
      exceptions: [{ word: "Isʼhoq", status: "approved", by: "u_1", ref: "GEN 21:3" }],
    }
    expect(orthographyValue(orthographyDraft(stored))).toEqual(stored)
  })
})

describe("orthographyExceptionsCsv", () => {
  it("writes a header and one row per word, quoting every cell", () => {
    expect(
      orthographyExceptionsCsv([
        { word: "Isʼhoq", status: "approved", by: "u_1", ref: "GEN 21:3" },
        { word: "Ishoq", status: "pending" },
      ]),
    ).toBe(
      'word,status,proposed_by,reference\n' +
        '"Isʼhoq","approved","u_1","GEN 21:3"\n' +
        '"Ishoq","pending","",""',
    )
  })

  it("escapes a quote inside a word rather than breaking the row", () => {
    expect(orthographyExceptionsCsv([{ word: 'a"b', status: "approved" }])).toContain('"a""b"')
  })
})
