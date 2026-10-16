/**
 * AQU-1805: the preflight the rule-fix commit path consults per cell.
 *
 * The rule drawer proposes a fix; ProjectWorkspace commits it. On an IDML cell
 * that commit rewrites protected runs, and AQU-742 is what careless rewriting
 * there costs — the anchors InDesign needs are dropped and the file stops
 * round-tripping. `replaceProtectedIdmlText` can only put the change back
 * inside the protected HTML when it is given a literal find/replace pair, so a
 * regex sweep (which has no such pair) must be refused rather than committed
 * as flattened text.
 *
 * Tested directly — the same extract-the-guard pattern as
 * `shouldApplyCheckResult` — since rendering the full ProjectWorkspace isn't
 * needed to prove the decision.
 */
import { describe, it, expect } from "vitest"
import { ruleFixPreflight } from "./project-workspace-helpers"

const literal = { find: "allah", replace: "God" }
const regexSweep = {}

describe("ruleFixPreflight (rule fix → cell commit)", () => {
  it("commits an ordinary cell's fix as plain text", () => {
    expect(ruleFixPreflight(false, literal)).toBe("plain")
    expect(ruleFixPreflight(false, regexSweep)).toBe("plain")
  })

  it("re-applies a literal fix inside an IDML cell's protected runs", () => {
    expect(ruleFixPreflight(true, literal)).toBe("protected")
  })

  it("refuses a regex sweep on an IDML cell rather than flattening its anchors", () => {
    expect(ruleFixPreflight(true, regexSweep)).toBe("refuse")
  })

  it("refuses a half-specified pair — both sides are needed to re-apply it", () => {
    expect(ruleFixPreflight(true, { find: "allah" })).toBe("refuse")
    expect(ruleFixPreflight(true, { replace: "God" })).toBe("refuse")
  })

  it("treats an empty-string replacement as a real pair (a deletion is a fix)", () => {
    expect(ruleFixPreflight(true, { find: "allah", replace: "" })).toBe("protected")
  })
})
