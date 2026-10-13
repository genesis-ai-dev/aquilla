// AQU-1697: check pack A's findings on autopilot drafts.
//
// WHY: autopilot stores a finding as `bkp:<check>` plus its params; the
// reviewer must see the same check name as Rules → Built-in checks and the
// same explanation as the editor, or one finding reads as two different things.

import { describe, expect, it } from "vitest"
import { t } from "@/lib/i18n/standalone"
import { formatList, formatPercent } from "@/lib/i18n/format"
import { bibleFindingEvidence, bibleFindingLabel } from "./bible-findings"
import { decodeBibleParams } from "../../../db/shared/bible-checks/params"

const format = { list: (items: readonly string[]) => formatList(items, "en"), percent: (n: number) => formatPercent(n, "en") }

describe("autopilot labels for check pack A", () => {
  it("names each check as Rules → Built-in checks does", () => {
    const label = (detail: string) => bibleFindingLabel({ code: `bkp:${detail}`, kind: "bkp", detail }, t)
    expect(label("N1")).toBe("Bible data: Number kept")
    expect(label("M3")).toBe("Bible data: Negation kept")
    expect(label("S6")).toBe("Bible data: Verses the oldest manuscripts lack")
    expect(label("S8")).toBe("Bible data: Verse numbering")
  })

  it("explains a stored M3 finding with the editor's words and evidence", () => {
    const params = decodeBibleParams("kind=negation-missing&expected=1&found=0&evidence=negation&refs=JHN+4%3A9")
    expect(bibleFindingEvidence({ code: "bkp:M3", kind: "bkp", detail: "M3", params }, t, format)).toEqual([
      "The source makes a negative statement in this verse, but the translation has none of the negative words from the Language profile. Without one, the meaning can be the opposite.",
      "Macula: negation in JHN 4:9",
    ])
  })
})
