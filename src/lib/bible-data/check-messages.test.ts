// AQU-1688 — a Bible data finding, explained and sourced.
//
// WHY (story "Fix a Bible data check finding"): every finding has a localized
// explanation tied to the cell and its evidence (dataset, record, confidence),
// e.g. "OpenText speech JHN 4:9 words 8–18, speaker from Clear
// speaker-quotations". The engine stores codes only, so these formatters are
// the whole path from a finding to that text.

import { describe, it, expect } from "vitest"
import { t } from "@/lib/i18n/standalone"
import { formatList, formatPercent } from "@/lib/i18n/format"
import { formatInfractionEvidence, formatInfractionReason } from "@/lib/rules/format-infraction"
import { bibleCheckInfraction } from "@/lib/rules/bible-check-rules"
import { buildCellCheckContexts } from "./check-context"
import type { RuleInfraction } from "@/lib/parsers/types"
import { JHN4_STRUCTURE, JHN4_VOICES } from "../../../db/shared/bible-checks/__fixtures__/pack"
import type { BibleCheckId } from "../../../db/shared/bible-checks/types"

const format = { list: (items: readonly string[]) => formatList(items, "en"), percent: (n: number) => formatPercent(n, "en") }
const profile = {
  quoteMarks: {
    levels: [{ open: "“", close: "”" }, { open: "‘", close: "’" }],
    continuation: "reopen-each-paragraph" as const,
  },
  // AQU-1691: M1 runs only once its own slot is saved; English asks with "?" alone.
  questionMarkers: {},
}
const cells = ["JHN 4:8", "JHN 4:9", "JHN 4:10", "JHN 4:11", "JHN 4:12"].map((ref) => ({ id: ref, globalReferences: [ref] }))
const contexts = buildCellCheckContexts(cells, JHN4_VOICES, JHN4_STRUCTURE, profile)

function infraction(ref: string, checkId: BibleCheckId, text: string): RuleInfraction {
  const found = bibleCheckInfraction(`builtin:${checkId}`, checkId, ref, "f", text, contexts.get(ref)?.bible)
  if (!found) throw new Error(`${checkId} did not fire on ${ref}`)
  return found
}

const WEB_4_9 =
  "The Samaritan woman therefore said to him, “How is it that you, being a Jew, ask for a drink from me, a Samaritan woman?” (For Jews have no dealings with Samaritans.)"

describe("formatting a Bible data finding", () => {
  it("explains a quotation closed after the narrator's aside, with the story's evidence line", () => {
    const inf = infraction("JHN 4:9", "bkp:V2", WEB_4_9.replace("woman?” (For", "woman? (For").replace("Samaritans.)", "Samaritans.)”"))
    expect(formatInfractionReason(inf, t)).toBe(
      "The quotation closes after the narration that follows it. Close it before that narration.",
    )
    expect(formatInfractionEvidence(inf, t, format)).toEqual([
      "OpenText speech JHN 4:9 words 8–18; speaker from Clear speaker-quotations, Macula (confidence 97%)",
    ])
  })

  it("names the level of a missing mark", () => {
    const inf = infraction("JHN 4:9", "bkp:V2", WEB_4_9.replace("woman?”", "woman?"))
    expect(formatInfractionReason(inf, t)).toContain("(level 1)")
  })

  it("names the marks the profile expects when a nested quotation uses the wrong ones", () => {
    const web = "Jesus answered her, “If you knew the gift of God, and who it is who says to you, “Give me a drink,” you would have asked him, and he would have given you living water.”"
    expect(formatInfractionReason(infraction("JHN 4:10", "bkp:V5", web), t)).toContain("‘ ’")
  })

  it("locates a speech that runs over several verses by both ends", () => {
    const inf = infraction("JHN 4:11", "bkp:V3", "The woman said to him, “Sir, where do you get that living water?”")
    expect(formatInfractionEvidence(inf, t, format)[0]).toMatch(/^OpenText speech JHN 4:11 word 5 to JHN 4:12 word 26; /)
  })

  it("says where nobody speaks, and where the source asks a question", () => {
    const v7 = infraction("JHN 4:8", "bkp:V7", "“For his disciples had gone away into the city to buy food.”")
    expect(formatInfractionEvidence(v7, t, format)).toEqual(["OpenText: no speech in JHN 4:8"])
    const m1 = infraction("JHN 4:9", "bkp:M1", WEB_4_9.replace("woman?”", "woman.”"))
    expect(formatInfractionEvidence(m1, t, format)).toEqual(["Macula: JHN 4:9 asks a question"])
  })

  it("adds the approximate line for part of a split verse", () => {
    const split = buildCellCheckContexts(
      [{ id: "a", globalReferences: ["JHN 4:8a"] }, { id: "b", globalReferences: ["JHN 4:8b"] }],
      JHN4_VOICES, JHN4_STRUCTURE, profile,
    )
    const inf = bibleCheckInfraction("builtin:bkp:V7", "bkp:V7", "a", "f", "“For his disciples", split.get("a")?.bible)!
    expect(formatInfractionEvidence(inf, t, format)[1]).toMatch(/^Approximate:/)
  })

  it("has no evidence line for any other check", () => {
    const other: RuleInfraction = { ruleId: "builtin:double-space", cellId: "c", fileId: "f", reason: "builtin:double-space", spans: [] }
    expect(formatInfractionEvidence(other, t, format)).toEqual([])
  })
})
