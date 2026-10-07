// AQU-1547: auth-worker's `deterministicDownstreamFileId` is a hand copy of
// sync-worker's. It has to be — the two workers are separate packages with
// their own lockfiles, so production code mirrors a cross-worker contract
// rather than importing across the seam (the same idiom as the role-policy
// mirror).
//
// A copy that drifts is worse than no copy: the detach snapshot would stop
// recognising every file a live link mirrored, and would start minting a
// duplicate beside each one instead of freezing it. This test imports BOTH
// implementations and fails if they ever disagree.

import { describe, it, expect } from "vitest"
import { deterministicDownstreamFileId as authCopy } from "../services/source-linking"
import { deterministicDownstreamFileId as syncOriginal } from "../../../sync-worker/src/events/link-sync"

describe("deterministicDownstreamFileId parity with sync-worker (AQU-1547)", () => {
  const cases: [string, string][] = [
    ["proj-down", "up-file-1"],
    ["00000000-0000-4000-8000-000000000000", "ffffffff-ffff-4fff-bfff-ffffffffffff"],
    ["", ""],
    ["pélagie", "نص"],
    ["proj-with\0nul", "file-with\0nul"],
  ]

  for (const [downstreamProjectId, upstreamFileId] of cases) {
    it(`agrees for (${JSON.stringify(downstreamProjectId)}, ${JSON.stringify(upstreamFileId)})`, () => {
      expect(authCopy(downstreamProjectId, upstreamFileId)).toBe(
        syncOriginal(downstreamProjectId, upstreamFileId),
      )
    })
  }

  it("is uuid-shaped, stable, and distinct per (project, file)", () => {
    const id = authCopy("proj-down", "up-file-1")
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(authCopy("proj-down", "up-file-1")).toBe(id)
    expect(authCopy("proj-other", "up-file-1")).not.toBe(id)
    expect(authCopy("proj-down", "up-file-2")).not.toBe(id)
  })
})
