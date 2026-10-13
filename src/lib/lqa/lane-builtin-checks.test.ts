import { describe, expect, it } from "vitest"
import type { ProjectRecord } from "@/lib/parsers/types"
import { settingsKeyDocLines, validateSettingsKeyValue } from "../../../db/shared/project-settings-keys"
import {
  laneCheckOverrides,
  laneLanguageForChecks,
  laneLanguageLabel,
  lanePunctuation,
  targetLaneRow,
  withLaneOverride,
} from "./lane-builtin-checks"

type LaneRow = NonNullable<ProjectRecord["lanes"]>[number]

const laneRow = (over: Partial<LaneRow>): LaneRow => ({
  id: "l1",
  role: "target",
  language: null,
  name: null,
  langCode: null,
  legacyTag: null,
  position: 0,
  archivedAt: null,
  ...over,
})

const project = (over: Partial<ProjectRecord>): ProjectRecord =>
  ({
    id: "p1",
    name: "P",
    sourceLanguage: "English",
    targetLanguage: "Spanish",
    createdAt: "2026-01-01T00:00:00.000Z",
    files: [],
    members: [],
    ...over,
  }) as ProjectRecord

const TWO_LANES = [
  laneRow({ id: "s", role: "source", language: "English", legacyTag: null }),
  laneRow({ id: "a", language: "Spanish", legacyTag: "" }),
  laneRow({ id: "b", language: "Thai", legacyTag: "th-lane" }),
]

describe("targetLaneRow", () => {
  it("finds the target lane by its legacy tag and never a source lane", () => {
    expect(targetLaneRow(TWO_LANES, "th-lane")?.id).toBe("b")
    expect(targetLaneRow(TWO_LANES, "")?.id).toBe("a")
    expect(targetLaneRow(TWO_LANES, "missing")).toBeUndefined()
  })
})

describe("laneLanguageForChecks", () => {
  it("reads the lane's code when the catalog knows its language", () => {
    expect(laneLanguageForChecks(project({ lanes: TWO_LANES }), "th-lane")).toBe("th")
  })

  it("falls back to the freeform label the user typed", () => {
    const lanes = [laneRow({ language: "Siberian Tatar", legacyTag: "x" })]
    expect(laneLanguageForChecks(project({ lanes }), "x")).toBe("Siberian Tatar")
  })

  it("uses the project's target language for the default lane before lane rows arrive", () => {
    expect(laneLanguageForChecks(project({ targetLanguage: "Thai" }), "")).toBe("Thai")
  })
})

describe("lanePunctuation", () => {
  it("gives each lane its own language's conventions", () => {
    const p = project({ lanes: TWO_LANES })
    expect(lanePunctuation(p, "th-lane").conventions?.noTerminalMark).toBe(true)
    // The table says nothing about Spanish, so that lane stays source-relative.
    expect(lanePunctuation(p, "").conventions).toBeNull()
  })

  it("lets the project's Language profile slot win in every lane", () => {
    const p = project({ lanes: TWO_LANES, languageProfile: { punctuation: { question: ["¿"] } } })
    expect(lanePunctuation(p, "th-lane").origin).toEqual({ kind: "profile" })
    expect(lanePunctuation(p, "th-lane").conventions?.question).toContain("¿")
    // "wins WHOLE": Thai's own answer is not blended in.
    expect(lanePunctuation(p, "th-lane").conventions?.noTerminalMark).toBe(false)
  })

  it("ignores a damaged profile slot rather than silencing the table", () => {
    const p = project({
      lanes: TWO_LANES,
      // A damaged stored slot, on purpose: "not one character" is a string the
      // type allows and the slot validator rejects.
      languageProfile: { punctuation: { question: ["not one character"] } },
    })
    expect(lanePunctuation(p, "th-lane").origin).toEqual({ kind: "language", subtag: "th" })
  })
})

describe("laneCheckOverrides", () => {
  const p = project({
    algorithmicChecks: {
      "end-punctuation-mismatch": { enabled: true, severity: "minor" },
      "double-space": { enabled: false },
    },
    algorithmicChecksByLane: {
      "th-lane": { "end-punctuation-mismatch": { enabled: false } },
    },
  })

  it("lays the lane's entries over the project-wide ones, per check id", () => {
    const overrides = laneCheckOverrides(p, "th-lane")
    expect(overrides?.["end-punctuation-mismatch"]).toEqual({ enabled: false })
    expect(overrides?.["double-space"]).toEqual({ enabled: false })
  })

  it("leaves a lane with no entry of its own on the project-wide set, by identity", () => {
    expect(laneCheckOverrides(p, "")).toBe(p.algorithmicChecks)
  })

  it("returns the project-wide set for a management surface (no lane)", () => {
    expect(laneCheckOverrides(p, undefined)).toBe(p.algorithmicChecks)
  })

  it("is undefined when the project has stored nothing", () => {
    expect(laneCheckOverrides(project({}), "")).toBeUndefined()
  })
})

describe("withLaneOverride", () => {
  it("adds one lane's one check without touching the others", () => {
    const stored = {
      a: { "double-space": { enabled: false } },
      b: { "repeated-word": { enabled: false } },
    }
    const next = withLaneOverride(stored, "a", "end-punctuation-mismatch", { enabled: false })
    expect(next.a).toEqual({
      "double-space": { enabled: false },
      "end-punctuation-mismatch": { enabled: false },
    })
    expect(next.b).toEqual(stored.b)
    expect(stored.a["double-space"]).toEqual({ enabled: false }) // no mutation
  })

  it("starts a lane's map when it has none", () => {
    expect(withLaneOverride(undefined, "", "double-space", { enabled: true, severity: "major" })).toEqual({
      "": { "double-space": { enabled: true, severity: "major" } },
    })
  })
})

describe("laneLanguageLabel", () => {
  it("is the label a person reads, not the code", () => {
    expect(laneLanguageLabel(project({ lanes: TWO_LANES }), "th-lane")).toBe("Thai")
    expect(laneLanguageLabel(project({ targetLanguage: "Spanish" }), "")).toBe("Spanish")
  })
})

describe("algorithmicChecksByLane as a project setting", () => {
  it("is a recognized key, so an agent naming it is not told it is unknown", () => {
    expect(validateSettingsKeyValue("algorithmicChecksByLane", { "": { "double-space": { enabled: false } } })).toBeNull()
    expect(validateSettingsKeyValue("algorithmicChecksByLane", null)).toBeNull()
    expect(validateSettingsKeyValue("algorithmicChecksByLane", "off")).not.toBeNull()
  })

  it("is documented for describe_command", () => {
    expect(settingsKeyDocLines().some((line) => line.startsWith("algorithmicChecksByLane:"))).toBe(true)
  })
})
