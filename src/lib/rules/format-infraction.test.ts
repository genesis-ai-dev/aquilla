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
})
