/**
 * AQU-1894: "Recently deleted" never loaded. The trash list called
 * sync-worker `GET /api/v1/projects/:projectId/files?trash=1` with the
 * identity SESSION jwt, but `verifyTokenForProject` only accepts a project
 * sync token (`aud: "sync"`), so the read answered 401 every time and deleted
 * files could never be listed or restored.
 *
 * `fetchDeletedFilesWithProjectToken` is the extracted seam ProjectWorkspace's
 * `refreshDeletedFiles` now goes through. Tested directly rather than by
 * mounting the workspace, same pattern as `shouldSelfHealZeroFileLink`
 * (QA-BUG-1) and `shouldPatchSystemPrompt` (AQU-234).
 */

import { describe, it, expect, vi } from "vitest"
import { fetchDeletedFilesWithProjectToken } from "./project-workspace-helpers"
import type { FileSummary } from "@/lib/sync/cells-read-types"

const SESSION_JWT = "session-jwt-NOT-a-sync-token"
const SYNC_TOKEN = "minted-sync-token"

const row = (fileId: string) => ({ fileId, name: fileId }) as FileSummary

describe("fetchDeletedFilesWithProjectToken (AQU-1894)", () => {
  it("reads the trash listing with a minted sync token, never the session jwt", async () => {
    const fetchFiles = vi.fn(async () => [row("f-gone")])
    const files = await fetchDeletedFilesWithProjectToken({
      projectId: "proj-a",
      getTokenForFile: async () => SYNC_TOKEN,
      fetchFiles,
    })
    expect(files).toEqual([row("f-gone")])
    expect(fetchFiles).toHaveBeenCalledWith("proj-a", SYNC_TOKEN)
    // The regression itself: the session jwt must never reach sync-worker.
    expect(fetchFiles).not.toHaveBeenCalledWith("proj-a", SESSION_JWT)
  })

  it("mints against the __project__ sentinel, so a project whose only file was deleted still loads", async () => {
    const getTokenForFile = vi.fn(async () => SYNC_TOKEN)
    // No live files exist in this scenario — keying the mint on `files[0]`
    // would mint nothing and the trash list would stay permanently empty.
    await fetchDeletedFilesWithProjectToken({
      projectId: "proj-a",
      getTokenForFile,
      fetchFiles: async () => [row("f-the-only-one")],
    })
    expect(getTokenForFile).toHaveBeenCalledWith("__project__")
  })

  it("returns an empty list (not null) for a project with no deleted files", async () => {
    const files = await fetchDeletedFilesWithProjectToken({
      projectId: "proj-a",
      getTokenForFile: async () => SYNC_TOKEN,
      fetchFiles: async () => [],
    })
    // [] is a real empty trash: the caller renders the empty state and
    // reconciles optimistic rows away. Distinct from the null case below.
    expect(files).toEqual([])
  })

  it("returns null without reading when no token can be minted", async () => {
    const fetchFiles = vi.fn(async () => [row("f-gone")])
    const files = await fetchDeletedFilesWithProjectToken({
      projectId: "proj-a",
      getTokenForFile: async () => null,
      fetchFiles,
    })
    // null tells the caller to leave the current list alone rather than wipe
    // optimistic rows on a signed-out / mid-expiry mint failure.
    expect(files).toBeNull()
    expect(fetchFiles).not.toHaveBeenCalled()
  })

  it("propagates a failed read so the caller's catch keeps optimistic rows", async () => {
    await expect(
      fetchDeletedFilesWithProjectToken({
        projectId: "proj-a",
        getTokenForFile: async () => SYNC_TOKEN,
        fetchFiles: async () => {
          throw new Error("500 from sync-worker")
        },
      }),
    ).rejects.toThrow("500 from sync-worker")
  })
})
