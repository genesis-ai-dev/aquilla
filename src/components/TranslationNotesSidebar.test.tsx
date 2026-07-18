// AQU-179 fix: the sidebar must mint its project-level token with the
// established "__project__" sentinel (shared with useComments /
// sync-worker authorize.ts), NOT an ad-hoc placeholder like "list". An ad-hoc
// fileId mints a token scoped to a nonexistent file — accepted by some
// validators, rejected by stricter ones — and the inconsistency is exactly how
// the wave-2 QA 401 surfaced. This test locks the convention so the token
// fileId can't silently drift again.
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, waitFor } from "@testing-library/react"

const fetchProjectFiles = vi.fn()
const fetchFileCells = vi.fn()
vi.mock("@/lib/sync/cells-read", () => ({
  fetchProjectFiles: (...args: unknown[]) => fetchProjectFiles(...args),
  fetchFileCells: (...args: unknown[]) => fetchFileCells(...args),
}))

import { TranslationNotesSidebar } from "./TranslationNotesSidebar"

describe("TranslationNotesSidebar token acquisition (AQU-179)", () => {
  beforeEach(() => {
    fetchProjectFiles.mockReset()
    fetchFileCells.mockReset()
  })

  it("mints the file-list token with the __project__ sentinel, then per-file tokens with real fileIds", async () => {
    const seen: string[] = []
    const getToken = vi.fn(async (fileId: string) => {
      seen.push(fileId)
      return `tok-${fileId}`
    })
    fetchProjectFiles.mockResolvedValue([
      { fileId: "tn-1", name: "notes.tsv", fileType: "tsv" },
    ])
    fetchFileCells.mockResolvedValue({ cells: [], nextCursor: undefined })

    render(
      <TranslationNotesSidebar
        projectId="proj-1"
        canonicalRef="GEN 1:1"
        getToken={getToken}
        visible={true}
        onToggle={() => {}}
      />,
    )

    await waitFor(() => expect(getToken).toHaveBeenCalled())
    // First mint = project-level list fetch → MUST be the sentinel.
    expect(seen[0]).toBe("__project__")
    expect(seen[0]).not.toBe("list")
    // Subsequent mints (per TN file) use the real fileId.
    await waitFor(() => expect(fetchFileCells).toHaveBeenCalled())
    expect(seen.slice(1)).toContain("tn-1")
    // The list fetch received the token minted for the sentinel.
    expect(fetchProjectFiles).toHaveBeenCalledWith("proj-1", "tok-__project__")
  })

  it("renders empty (no crash, no fetches) when the token mint returns null", async () => {
    const getToken = vi.fn(async () => null)
    render(
      <TranslationNotesSidebar
        projectId="proj-1"
        canonicalRef="GEN 1:1"
        getToken={getToken}
        visible={true}
        onToggle={() => {}}
      />,
    )
    await waitFor(() => expect(getToken).toHaveBeenCalled())
    expect(fetchProjectFiles).not.toHaveBeenCalled()
  })
})
