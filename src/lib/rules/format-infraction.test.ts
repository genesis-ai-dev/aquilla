import { describe, expect, it } from "vitest"
import { formatInfractionReason } from "./format-infraction"
import { translate } from "@/lib/i18n/translate"
import type { TFunction } from "@/lib/i18n/I18nProvider"
import type { RuleInfraction } from "@/lib/parsers/types"

// AQU-1573: the reference-quote reason picks its sentence by `kind` and
// interpolates the verse labels and the Bible's name verbatim.
const t: TFunction = (key, vars) => translate(undefined, key, vars)

function infraction(reasonParams: Record<string, string>): RuleInfraction {
  return { ruleId: "builtin:reference-quote", cellId: "c", fileId: "f", reason: "builtin:reference-quote", reasonParams, spans: [] }
}

describe("formatInfractionReason — reference Bible quotes", () => {
  it("says the translation leaves out a reference, and counts them", () => {
    expect(formatInfractionReason(infraction({ kind: "dropped", refs: "Isaiah 40:25", count: "1" }), t)).toBe(
      "The source cites Isaiah 40:25, but the translation leaves out the reference",
    )
    expect(
      formatInfractionReason(infraction({ kind: "dropped", refs: "Romans 5:8, John 15:13", count: "2", version: "Van Dyck" }), t),
    ).toBe("The source cites Romans 5:8, John 15:13, but the translation leaves out the references")
  })

  it("adds the left-out reference after a quote sentence", () => {
    expect(
      formatInfractionReason(
        infraction({ kind: "differs", refs: "Romans 8:28", version: "Van Dyck", droppedRefs: "Romans 8:28", droppedCount: "1" }),
        t,
      ),
    ).toBe(
      "The quote of Romans 8:28 does not match Van Dyck word for word. " +
        "The source cites Romans 8:28, but the translation leaves out the reference",
    )
  })

  it("says a changed quote does not match word for word", () => {
    expect(formatInfractionReason(infraction({ kind: "differs", refs: "Romans 8:28", version: "Van Dyck" }), t)).toBe(
      "The quote of Romans 8:28 does not match Van Dyck word for word",
    )
  })

  it("says a visibly quoted verse was not taken from the Bible", () => {
    expect(formatInfractionReason(infraction({ kind: "missing", refs: "Psalm 23:1", version: "Van Dyck" }), t)).toBe(
      "The source quotes Psalm 23:1, but the translation does not use the Van Dyck wording",
    )
  })

  it("says both, each naming its own verses, when one cell has a changed quote and a fresh one", () => {
    expect(
      formatInfractionReason(
        infraction({ kind: "both", refs: "Romans 8:28", missingRefs: "Psalm 23:1", version: "Van Dyck" }),
        t,
      ),
    ).toBe(
      "The quote of Romans 8:28 does not match Van Dyck word for word. " +
        "The source quotes Psalm 23:1, but the translation does not use the Van Dyck wording",
    )
  })
})
