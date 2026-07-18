import { renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useWorkspaceTabs } from "./useWorkspaceTabs"

const PROJECT_ID = "project-1"
const STORAGE_KEY = `codex:tabs:${PROJECT_ID}`

function renderTabs(props: {
  fileIds: string[]
  filesReady: boolean
  activeFileId: string | null
  setActiveFileId?: (fileId: string | null) => void
}) {
  return renderHook(
    (nextProps: typeof props) =>
      useWorkspaceTabs({
        projectId: PROJECT_ID,
        fileIds: nextProps.fileIds,
        filesReady: nextProps.filesReady,
        activeFileId: nextProps.activeFileId,
        setActiveFileId: nextProps.setActiveFileId ?? vi.fn(),
      }),
    { initialProps: props },
  )
}

describe("useWorkspaceTabs", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it("creates an active file tab synchronously while project files are still loading", () => {
    const { result } = renderTabs({
      fileIds: [],
      filesReady: false,
      activeFileId: "file-a",
    })

    expect(result.current.tabs).toHaveLength(1)
    expect(result.current.tabs[0]?.fileId).toBe("file-a")
    expect(result.current.activeTabId).toBe(result.current.tabs[0]?.id)
  })

  it("does not prune restored tabs while the file list is still loading", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ tabs: [{ id: "tab-a", fileId: "file-a" }], lastActiveFileId: "file-a" }),
    )

    const { result } = renderTabs({
      fileIds: [],
      filesReady: false,
      activeFileId: "file-a",
    })

    await waitFor(() => {
      expect(result.current.tabs).toEqual([{ id: "tab-a", fileId: "file-a" }])
    })
  })

  it("prunes stale tabs after files are loaded and keeps the active file tab", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ tabs: [{ id: "stale-tab", fileId: "missing-file" }] }),
    )

    const { result, rerender } = renderTabs({
      fileIds: [],
      filesReady: false,
      activeFileId: "file-a",
    })

    expect(result.current.tabs.map((tab) => tab.fileId)).toEqual(["missing-file", "file-a"])

    rerender({
      fileIds: ["file-a"],
      filesReady: true,
      activeFileId: "file-a",
    })

    await waitFor(() => {
      expect(result.current.tabs.map((tab) => tab.fileId)).toEqual(["file-a"])
    })
  })
})
