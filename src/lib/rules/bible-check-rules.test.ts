// AQU-1688 — Bible data checks through the per-cell rule engine.
//
// WHY: the checks must reach translators through the paths every other
// built-in check uses (violation marks, the Issues tab, the findings drawer),
// with the project's switch and severity, and only when the project has
// asked for them: Bible data checks on, and quotation marks in its Language
// profile. Real pack data (JHN 4) and World English Bible text.

import { describe, it, expect } from "vitest"
import { checkRulesForCell } from "./rule-engine"
import { resolveBuiltinRules } from "@/lib/lqa/builtin-resolver"
import { bibleChecksEnabled, bibleChecksGate, buildCellCheckContexts } from "@/lib/bible-data/check-context"
import type { CellData } from "@/hooks/useCells"
import type { RuleInfraction } from "@/lib/parsers/types"
import { JHN4_STRUCTURE, JHN4_VOICES } from "../../../db/shared/bible-checks/__fixtures__/pack"
import type { LanguageProfile } from "../../../db/shared/language-profile"

const ENGLISH: LanguageProfile = {
  quoteMarks: { levels: [{ open: "“", close: "”" }, { open: "‘", close: "’" }], continuation: "reopen-each-paragraph" },
}
const WEB_4_8 = "For his disciples had gone away into the city to buy food."
const WEB_4_9 =
  "The Samaritan woman therefore said to him, “How is it that you, being a Jew, ask for a drink from me, a Samaritan woman?” (For Jews have no dealings with Samaritans.)"

const REFS = [
  { id: "c8", globalReferences: ["JHN 4:8"] },
  { id: "c9", globalReferences: ["JHN 4:9"] },
]

function cell(id: string, translated: string): CellData {
  return {
    id, fileId: "f", original: "src", translated, context: "", group: "", type: "verse",
    status: "unvalidated", validationStatus: "none", activeValidators: [], validationHistory: [],
    history: [], threads: [],
  } as CellData
}

const bibleOnly = (infractions: RuleInfraction[]) => infractions.filter((i) => i.reason.startsWith("builtin:bkp:"))
const enabled = (options: { bibleChecks: boolean }) => resolveBuiltinRules(undefined, options).filter((r) => r.enabled)

describe("Bible data checks in checkRulesForCell", () => {
  const contexts = buildCellCheckContexts(REFS, JHN4_VOICES, JHN4_STRUCTURE, ENGLISH)

  it("reports a dropped closing mark in JHN 4:9 as builtin:bkp:V2, with the pack evidence as params", () => {
    const broken = cell("c9", WEB_4_9.replace("woman?”", "woman?"))
    const found = bibleOnly(checkRulesForCell(broken, "f", enabled({ bibleChecks: true }), contexts.get("c9")))
    expect(found).toEqual([
      expect.objectContaining({
        ruleId: "builtin:bkp:V2",
        reason: "builtin:bkp:V2",
        cellId: "c9",
        reasonParams: expect.objectContaining({
          kind: "close-missing",
          level: "1",
          evidence: "speech",
          startRef: "JHN 4:9",
          startWord: "8",
          endRef: "JHN 4:9",
          endWord: "18",
          speakerSources: "fcbh,macula",
        }),
      }),
    ])
  })

  it("passes the correct translation", () => {
    expect(bibleOnly(checkRulesForCell(cell("c9", WEB_4_9), "f", enabled({ bibleChecks: true }), contexts.get("c9")))).toEqual([])
  })

  it("points its spans at the marks in this cell's text, so the editor can mark them", () => {
    const quoted = cell("c8", `“${WEB_4_8}”`)
    const [v7] = bibleOnly(checkRulesForCell(quoted, "f", enabled({ bibleChecks: true }), contexts.get("c8")))
    expect(v7.ruleId).toBe("builtin:bkp:V7")
    expect(v7.spans.map((s) => [s.side, s.matchedText])).toEqual([["target", "“"], ["target", "”"]])
  })

  it("stays silent without this cell's context (no pack facts for it)", () => {
    const broken = cell("c9", WEB_4_9.replace("woman?”", "woman?"))
    expect(bibleOnly(checkRulesForCell(broken, "f", enabled({ bibleChecks: true })))).toEqual([])
  })

  it("is dormant while the Language profile has no quotation marks", () => {
    const dormant = buildCellCheckContexts(REFS, JHN4_VOICES, JHN4_STRUCTURE, {})
    const broken = cell("c9", WEB_4_9.replace("woman?”", "woman.").replace("Samaritans.)", "Samaritans.)”"))
    expect(bibleOnly(checkRulesForCell(broken, "f", enabled({ bibleChecks: true }), dormant.get("c9")))).toEqual([])
  })
})

describe("the checks enrichment gates the rules themselves", () => {
  const scripture = [{ type: "usfm" as const }]
  /** AQU-1685: the device-local Bible data experiment, switched on. */
  const experiment = { experimentalFlags: { bibleData: true } }

  it("with Bible data checks off, the rules do not exist, so broken text yields nothing", () => {
    const project = { ...experiment, bibleResourcesEnabled: true, bibleEnrichments: { checks: false }, files: scripture, languageProfile: ENGLISH }
    expect(bibleChecksGate(project)).toEqual({ state: "off" })
    const rules = enabled({ bibleChecks: false })
    expect(rules.some((r) => r.id.startsWith("builtin:bkp:"))).toBe(false)
    const contexts = buildCellCheckContexts(REFS, JHN4_VOICES, JHN4_STRUCTURE, ENGLISH)
    const broken = cell("c9", WEB_4_9.replace("woman?”", "woman?"))
    expect(bibleOnly(checkRulesForCell(broken, "f", rules, contexts.get("c9")))).toEqual([])
  })

  it("Bible data off turns the checks off whatever the enrichment says", () => {
    expect(
      bibleChecksGate({ ...experiment, bibleResourcesEnabled: false, bibleEnrichments: { checks: true }, files: scripture }),
    ).toEqual({ state: "off" })
  })

  // AQU-1685: Bible data checks are part of the Bible data experiment. On a
  // device that has not switched it on they are not rules at all (Rules →
  // Built-in checks does not list them) and nothing runs, whatever the
  // project's own choices, which a collaborator with the experiment on set.
  it("the Bible data experiment off on this device turns the checks off, and the rules do not exist", () => {
    const project = { bibleResourcesEnabled: true, bibleEnrichments: { checks: true }, files: scripture, languageProfile: ENGLISH }
    expect(bibleChecksEnabled(project)).toBe(false)
    expect(bibleChecksGate(project)).toEqual({ state: "off" })
    expect(bibleChecksGate({ ...project, experimentalFlags: { bibleData: false } })).toEqual({ state: "off" })
    expect(bibleChecksGate({ ...project, ...experiment }).state).toBe("on")
  })

  it("on but without quotation marks is dormant; with them, on", () => {
    const base = { ...experiment, bibleResourcesEnabled: true, files: scripture }
    expect(bibleChecksGate(base).state).toBe("dormant")
    expect(bibleChecksGate({ ...base, languageProfile: ENGLISH }).state).toBe("on")
  })
})

describe("Rules → Built-in checks configures them like any built-in", () => {
  it("adds the eight checks only when asked, with design-doc defaults (warning → major, info → minor)", () => {
    const rules = resolveBuiltinRules(undefined, { bibleChecks: true }).filter((r) => r.id.startsWith("builtin:bkp:"))
    expect(rules.map((r) => [r.id, r.severity, r.enabled])).toEqual([
      ["builtin:bkp:V1", "major", true],
      ["builtin:bkp:V2", "major", true],
      ["builtin:bkp:V3", "major", true],
      ["builtin:bkp:V5", "major", true],
      ["builtin:bkp:V7", "minor", true],
      ["builtin:bkp:V8", "minor", true],
      ["builtin:bkp:V9", "minor", true],
      ["builtin:bkp:M1", "major", true],
    ])
  })

  it("honours the project's switch and severity in algorithmicChecks", () => {
    const rules = resolveBuiltinRules(
      { "bkp:V7": { enabled: false }, "bkp:V2": { enabled: true, severity: "minor" } },
      { bibleChecks: true },
    )
    expect(rules.find((r) => r.id === "builtin:bkp:V7")?.enabled).toBe(false)
    expect(rules.find((r) => r.id === "builtin:bkp:V2")?.severity).toBe("minor")
    // A switched-off check reports nothing.
    const contexts = buildCellCheckContexts(REFS, JHN4_VOICES, JHN4_STRUCTURE, ENGLISH)
    const quoted = cell("c8", `“${WEB_4_8}”`)
    expect(bibleOnly(checkRulesForCell(quoted, "f", rules.filter((r) => r.enabled), contexts.get("c8")))).toEqual([])
  })
})
