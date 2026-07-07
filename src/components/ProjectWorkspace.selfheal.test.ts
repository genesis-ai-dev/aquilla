/**
 * QA-BUG-1 (2026-07-06 live-UI QA, docs/swarm/LINKEDPROJ-UIQA.md): linked
 * projects were born with 0 files/0 cells with no client path to recover —
 * the lazy-pull trigger in useStaleSourceCells only fires once a FILE is
 * open, so a freshly created (or link-time-seed-failed) live-linked project
 * had no way to self-heal short of a manual API call.
 *
 * `shouldSelfHealZeroFileLink` is the pure gating guard ProjectWorkspace's
 * zero-file self-heal effect uses to decide whether to fire POST /link/sync
 * on project load. These tests cover the guard directly (same pattern as
 * `shouldPatchSystemPrompt` — FRO-234) rather than rendering the full
 * component, which requires no live-UI verification for the LOGIC (the
 * network call + refresh() side effect still needs a dev-stack check).
 */

import { describe, it, expect } from "vitest"
import { shouldSelfHealZeroFileLink } from "./ProjectWorkspace"

const BASE = {
  projectId: "proj-b",
  jwt: "jwt-token",
  sourceLinkMode: "live" as const,
  fileCount: 0,
  alreadyAttemptedProjectId: null,
}

describe("shouldSelfHealZeroFileLink (QA-BUG-1)", () => {
  it("fires for a live-linked project with 0 files and no prior attempt", () => {
    expect(shouldSelfHealZeroFileLink(BASE)).toBe(true)
  })

  it("does not fire when the project already has files", () => {
    expect(shouldSelfHealZeroFileLink({ ...BASE, fileCount: 3 })).toBe(false)
  })

  it("does not fire for clone-mode links (no ongoing mirror to trigger)", () => {
    expect(shouldSelfHealZeroFileLink({ ...BASE, sourceLinkMode: "clone" })).toBe(false)
  })

  it("does not fire for a self-contained project (sourceLinkMode null/undefined)", () => {
    expect(shouldSelfHealZeroFileLink({ ...BASE, sourceLinkMode: null })).toBe(false)
    expect(shouldSelfHealZeroFileLink({ ...BASE, sourceLinkMode: undefined })).toBe(false)
  })

  it("does not fire without a project id", () => {
    expect(shouldSelfHealZeroFileLink({ ...BASE, projectId: null })).toBe(false)
  })

  it("does not fire without a jwt (identity not loaded yet)", () => {
    expect(shouldSelfHealZeroFileLink({ ...BASE, jwt: null })).toBe(false)
  })

  it("does not re-fire for a project id already attempted this mount", () => {
    expect(
      shouldSelfHealZeroFileLink({ ...BASE, alreadyAttemptedProjectId: "proj-b" }),
    ).toBe(false)
  })

  it("fires again for a DIFFERENT project id even if another was already attempted", () => {
    expect(
      shouldSelfHealZeroFileLink({ ...BASE, alreadyAttemptedProjectId: "some-other-project" }),
    ).toBe(true)
  })
})
