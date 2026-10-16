// AQU-1686: the shared enrichment resolver must read the Bible data switch
// exactly as the SPA's `resolveBibleResourcesEnabled` does.
//
// They are two implementations of one rule. The SPA uses its own for the
// switch and Verse Resources; the shared one decides which layers load and
// what the server lets autopilot use. If they disagreed, a project could show
// Bible data as off while its enrichments still loaded, or the reverse.

import { describe, it, expect } from "vitest"
import { resolveBibleResourcesEnabled } from "@/lib/parsers/types"
import {
  BIBLE_ENRICHMENT_IDS,
  resolveBibleEnrichment,
} from "../../../db/shared/bible-enrichments"

describe("the shared resolver and resolveBibleResourcesEnabled", () => {
  it("agree on the switch for every explicit value and scripture state", () => {
    for (const explicit of [true, false, undefined]) {
      for (const hasScripture of [true, false]) {
        const switchOn = resolveBibleResourcesEnabled(explicit, hasScripture)
        // With every enrichment explicitly on, an enrichment is on exactly
        // when the switch is.
        const allOn = Object.fromEntries(BIBLE_ENRICHMENT_IDS.map((id) => [id, true]))
        for (const id of BIBLE_ENRICHMENT_IDS) {
          expect(
            resolveBibleEnrichment(
              { bibleResourcesEnabled: explicit, bibleEnrichments: allOn },
              id,
              hasScripture,
            ),
            `${id}, explicit=${String(explicit)}, scripture=${hasScripture}`,
          ).toBe(switchOn)
        }
      }
    }
  })
})
