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
import { JHN_A_STRUCTURE, JHN_A_TEXT, JHN_A_VOICES } from "../../../db/shared/bible-checks/__fixtures__/pack-a"
import type { BibleCheckId } from "../../../db/shared/bible-checks/types"
import { JHN_B_PEOPLE, JHN_B_STRUCTURE, JHN_B_TEXT, JHN_B_VOICES } from "../../../db/shared/bible-checks/__fixtures__/pack-b"
import { buildNameTable } from "../../../db/shared/bible-checks/agreed-names"

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

// AQU-1697: check pack A's findings read the same way, from codes and pack data.
describe("formatting a check-pack-A finding", () => {
  const packA = {
    negators: ["not", "no"],
    numberWords: { "3": "three", "50": "fifty", "100": "hundred" },
    textualVariants: "bracket" as const,
  }
  const cellsA = ["JHN 21:11", "JHN 7:53"].map((ref) => ({ id: ref, globalReferences: [ref] }))
  const contextsA = buildCellCheckContexts(cellsA, JHN_A_VOICES, JHN_A_STRUCTURE, packA, JHN_A_TEXT)
  const findingA = (ref: string, checkId: BibleCheckId, text: string) => {
    const found = bibleCheckInfraction(`builtin:${checkId}`, checkId, ref, "f", text, contextsA.get(ref)?.bible)
    if (!found) throw new Error(`${checkId} did not fire on ${ref}`)
    return found
  }

  it("names the missing number and where the source states it", () => {
    const inf = findingA("JHN 21:11", "bkp:N1", "Simon Peter drew the net to land, full of great fish. The net wasn’t torn.")
    expect(formatInfractionReason(inf, t)).toBe(
      "The source has the number 153 in this verse, but the translation has neither its digits nor its number word.",
    )
    expect(formatInfractionEvidence(inf, t, format)).toEqual(["Macula: JHN 21:11 words 15–17"])
  })

  it("warns that a dropped negation can reverse the meaning", () => {
    const inf = findingA("JHN 21:11", "bkp:M3", "Simon Peter drew the net to land, full of 153 great fish. The net was torn.")
    expect(formatInfractionReason(inf, t)).toBe(
      "The source makes a negative statement in this verse, but the translation has none of the negative words from the Language profile. Without one, the meaning can be the opposite.",
    )
    expect(formatInfractionEvidence(inf, t, format)).toEqual(["Macula: negation in JHN 21:11"])
  })

  it("names the disputed passage and why it is disputed", () => {
    const inf = findingA("JHN 7:53", "bkp:S7", "Everyone went to his own house,")
    expect(formatInfractionReason(inf, t)).toBe(
      "The Language profile says to keep JHN 7:53–8:11 in brackets, but this cell does not have the brackets.",
    )
    expect(formatInfractionEvidence(inf, t, format)).toEqual([
      "JHN 7:53–8:11: in double brackets in the critical Greek text (NA28, SBLGNT)",
    ])
  })
})

// AQU-1699: check pack B's findings read the same way. WHY: a name finding must
// say whose name, what the project agreed, and where the decision comes from,
// so the translator can fix the verse or the decision.
describe("formatting a check-pack-B finding", () => {
  const decide = (key: string, value: string) => ({ id: key, key, value, scope: {}, author: "dev", at: "2026-10-06T00:00:00.000Z" })
  const names = buildNameTable({
    people: JHN_B_PEOPLE,
    text: JHN_B_TEXT,
    facts: [decide("render.person.Jesus.2", "Jesus"), decide("render.person.Peter", "Peter|Simon|Cephas")],
    sourceLanguage: "en",
  })
  const synthetic = {
    pronouns: {
      secondPerson: { numberDistinction: true, singular: ["yu"], plural: ["yupela"] },
      firstPersonPlural: { clusivity: true, inclusive: ["yumi"], exclusive: ["mipela"] },
    },
  }
  const cellsB = ["JHN 4:16", "JHN 4:22"].map((ref) => ({ id: ref, globalReferences: [ref] }))
  const contextsB = buildCellCheckContexts(cellsB, JHN_B_VOICES, JHN_B_STRUCTURE, synthetic, JHN_B_TEXT, { people: JHN_B_PEOPLE, names })
  const findingB = (ref: string, checkId: BibleCheckId, text: string) => {
    const found = bibleCheckInfraction(`builtin:${checkId}`, checkId, ref, "f", text, contextsB.get(ref)?.bible)
    if (!found) throw new Error(`${checkId} did not fire on ${ref}`)
    return found
  }

  it("names the implied subject, the name the translation used, and the decision behind the agreed name", () => {
    const inf = findingB("JHN 4:16", "bkp:P6", "Peter said to her, “Go, call your husband.”")
    expect(formatInfractionReason(inf, t)).toBe(
      "The source does not name who acts here, and the Bible data says that it is Jesus. But the translation names “Peter”.",
    )
    expect(formatInfractionEvidence(inf, t, format)).toEqual([
      "Macula: in JHN 4:16, word 1 has Jesus as its implied subject",
      "Agreed name: decision render.person.Jesus.2",
    ])
  })

  it("says which “you” the Greek has, choosing the sentence by number", () => {
    const inf = findingB("JHN 4:22", "bkp:P8", "Yu i lotu long samting yu i no save long en.")
    expect(formatInfractionReason(inf, t)).toBe(
      "Every “you” in the source of this verse speaks to several people, but the translation has a singular “you”.",
    )
    expect(formatInfractionEvidence(inf, t, format)).toEqual(["Macula: every “you” in JHN 4:22 is plural"])
  })

  it("names who “we” is and who is spoken to, for an exclusive “we”", () => {
    const inf = findingB("JHN 4:22", "bkp:P9", "Yupela i lotu. Yumi i lotu long samting yumi i save long en.")
    expect(formatInfractionReason(inf, t)).toBe("Here “we” does not include the people spoken to, but the translation has the inclusive “we”.")
    expect(formatInfractionEvidence(inf, t, format)).toEqual([
      "ACAI: JHN 4:22 word 6. “We”: Jews; Jesus. Spoken to: Samaritan woman; Samaritans.",
    ])
  })
})
