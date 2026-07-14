/**
 * runCheck (deterministic check → CheckFindingsDrawer) is async: it awaits
 * runDeterministicCheck for the active file, then commits the result. If the
 * user switches files mid-run, the resolving result describes the PREVIOUS
 * file and must not overwrite the now-active file's drawer state.
 *
 * `shouldApplyCheckResult` is the pure guard runCheck consults on resolve
 * (against the latest active file via activeFileIdRef). Tested directly — the
 * same extract-the-guard pattern as `shouldSelfHealZeroFileLink` — since
 * rendering the full ProjectWorkspace isn't needed to prove the logic.
 */
import { describe, it, expect } from "vitest"
import { shouldApplyCheckResult } from "./ProjectWorkspace"

describe("shouldApplyCheckResult (mid-check file-switch guard)", () => {
  it("applies a result whose file is still the active file", () => {
    expect(shouldApplyCheckResult("fileA", "fileA")).toBe(true)
  })

  it("drops a result once the active file has switched away", () => {
    // Result computed for fileA, but the user is now on fileB.
    expect(shouldApplyCheckResult("fileA", "fileB")).toBe(false)
  })

  it("drops a result when no file is active anymore (file closed)", () => {
    expect(shouldApplyCheckResult("fileA", null)).toBe(false)
  })

  it("never applies a result with no file id", () => {
    expect(shouldApplyCheckResult(null, null)).toBe(false)
    expect(shouldApplyCheckResult(null, "fileA")).toBe(false)
  })
})
