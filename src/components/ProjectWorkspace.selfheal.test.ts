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
 * `shouldPatchSystemPrompt` — AQU-234) rather than rendering the full
 * component, which requires no live-UI verification for the LOGIC (the
 * network call + refresh() side effect still needs a dev-stack check).
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { selfHealZeroFileLink, shouldSelfHealZeroFileLink } from "./project-workspace-helpers"
import {
  isLinkSeedFailed,
  markLinkSeedFailed,
  resetLinkSeedStatusForTests,
} from "@/lib/sync/link-seed-status"

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

/**
 * AQU-1544: the self-heal above used to end in `if (ok) refresh()` and nothing
 * else, so a heal that failed left a live-linked project with an empty file
 * list and no explanation — for the person who had just linked it, and for a
 * teammate opening it later. A failed heal now parks the failure in
 * `link-seed-status`, which is what puts LinkSeedFailedBanner and its "Try
 * again" on screen.
 */
describe("selfHealZeroFileLink (AQU-1544)", () => {
  beforeEach(() => resetLinkSeedStatusForTests())

  it("refreshes the project when the sync works and parks nothing", async () => {
    const triggerSync = vi.fn().mockResolvedValue(true)
    const refresh = vi.fn()

    const outcome = await selfHealZeroFileLink({ projectId: "proj-b", jwt: "tok", triggerSync, refresh })

    expect(outcome).toBe("healed")
    expect(triggerSync).toHaveBeenCalledWith("tok", "proj-b")
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(isLinkSeedFailed("proj-b")).toBe(false)
  })

  it("parks the failure for the banner when the sync fails, instead of failing quietly", async () => {
    const triggerSync = vi.fn().mockResolvedValue(false)
    const refresh = vi.fn()

    const outcome = await selfHealZeroFileLink({ projectId: "proj-b", jwt: "tok", triggerSync, refresh })

    expect(outcome).toBe("failed")
    expect(refresh).not.toHaveBeenCalled()
    expect(isLinkSeedFailed("proj-b")).toBe(true)
  })

  // The Import dialog and the create dialog each retry once and park the
  // failure themselves. Arriving on the project page must not spend a third
  // attempt behind the banner that is already showing.
  it("makes no further attempt when a link flow already parked the failure", async () => {
    markLinkSeedFailed("proj-b")
    const triggerSync = vi.fn().mockResolvedValue(true)
    const refresh = vi.fn()

    const outcome = await selfHealZeroFileLink({ projectId: "proj-b", jwt: "tok", triggerSync, refresh })

    expect(outcome).toBe("skipped")
    expect(triggerSync).not.toHaveBeenCalled()
    expect(isLinkSeedFailed("proj-b")).toBe(true)
  })
})
