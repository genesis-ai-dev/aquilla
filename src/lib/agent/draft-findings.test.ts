import { describe, expect, it } from "vitest"
import { findingsFromVerdicts, summarizeFindings } from "./draft-findings"

describe("findingsFromVerdicts", () => {
  it("reads codes and triage the pipeline stored, ignoring anything it does not know", () => {
    expect(findingsFromVerdicts({
      "dissent:naturalness": "flag",
      "lint:term-x": "flag",
      "future:thing": "flag",
      _triage: "human",
      _severity: "3",
      _decidedBy: "model",
    })).toEqual({
      findings: [
        { code: "dissent:naturalness", kind: "dissent", detail: "naturalness" },
        { code: "lint:term-x", kind: "lint", detail: "term-x" },
      ],
      triage: "human",
      severity: 3,
    })
  })

  // AQU-1690: autopilot stores a Bible data finding as bkp:<check>, with the
  // finding's reason and pack evidence as encoded params in the value.
  it("reads a Bible data finding with its reason and evidence params", () => {
    const value = "kind=close-after-aside&level=1&evidence=speech&startRef=JHN+4%3A9&startWord=8"
    expect(findingsFromVerdicts({ "bkp:V2": value, "bkp:V13": "flag", _triage: "human", _severity: "3" }).findings).toEqual([
      {
        code: "bkp:V2",
        kind: "bkp",
        detail: "V2",
        params: { kind: "close-after-aside", level: "1", evidence: "speech", startRef: "JHN 4:9", startWord: "8" },
      },
      { code: "bkp:V13", kind: "bkp", detail: "V13" },
    ])
  })

  it("treats a draft staged before findings existed as clean", () => {
    expect(findingsFromVerdicts(null)).toEqual({ findings: [], triage: null, severity: 0 })
    expect(findingsFromVerdicts({})).toEqual({ findings: [], triage: null, severity: 0 })
  })
})

describe("summarizeFindings", () => {
  it("counts what a reviewer needs to look at separately from advisory notes", () => {
    expect(summarizeFindings([
      { findings: [{ code: "unsupported", kind: "unsupported", detail: null }], triage: "human", severity: 3 },
      { findings: [{ code: "lint:x", kind: "lint", detail: "x" }], triage: "advisory", severity: 2 },
      { findings: [], triage: null, severity: 0 },
    ])).toEqual({ flagged: 2, needsHuman: 1, clean: 1 })
  })
})
