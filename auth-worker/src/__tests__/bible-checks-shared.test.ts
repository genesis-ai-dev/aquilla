// AQU-1688 — the Bible data check evaluator runs inside a worker.
//
// WHY: autopilot (AQU-1690) must gate its drafts with the SAME checks the editor
// shows a translator, through lintSpanDraft. That only works if the evaluator
// imports from auth-worker by a relative path, with no SPA aliases and no DOM.
// This test is that import, plus one golden case on real pack data, so a change
// that pulls an `@/` import or a browser API into db/shared/bible-checks fails
// here instead of in the autopilot build.

import { describe, it, expect } from "vitest"
import { compileFileExpectations } from "../../../db/shared/bible-checks/compile"
import { evaluateCell } from "../../../db/shared/bible-checks/evaluate"
import { JHN4_STRUCTURE, JHN4_VOICES } from "../../../db/shared/bible-checks/__fixtures__/pack"
import { readLanguageProfile } from "../../../db/shared/language-profile"

// The stored setting, read the way a worker reads the settings blob.
const profile = readLanguageProfile(
  JSON.stringify({
    quoteMarks: {
      levels: [{ open: "“", close: "”" }, { open: "‘", close: "’" }],
      continuation: "reopen-each-paragraph",
    },
  }),
)

describe("Bible data checks in a worker", () => {
  const expectations = compileFileExpectations([{ id: "c9", globalReferences: ["JHN 4:9"] }], JHN4_VOICES, JHN4_STRUCTURE)
  // World English Bible (public domain).
  const web =
    "The Samaritan woman therefore said to him, “How is it that you, being a Jew, ask for a drink from me, a Samaritan woman?” (For Jews have no dealings with Samaritans.)"

  it("passes JHN 4:9 when the woman's question is quoted and closed before the aside", () => {
    expect(evaluateCell(web, expectations.get("c9"), profile)).toEqual([])
  })

  it("flags JHN 4:9 when the closing mark is dropped, with a code and evidence, not a sentence", () => {
    const [finding] = evaluateCell(web.replace("woman?”", "woman?"), expectations.get("c9"), profile)
    expect(finding).toMatchObject({
      code: "bkp:V2",
      reason: "close-missing",
      severity: "warning",
      evidence: { kind: "speech", startRef: "JHN 4:9", startWord: 8, endWord: 18 },
    })
  })
})
