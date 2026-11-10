import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"

const { alignReimportedIdmlFile, toast } = vi.hoisted(() => ({
  alignReimportedIdmlFile: vi.fn(),
  toast: { add: vi.fn(() => "toast-1"), update: vi.fn(), close: vi.fn() },
}))

vi.mock("@/lib/idml/align-reimported-targets", () => ({ alignReimportedIdmlFile }))
vi.mock("@/components/ui/toast", () => ({ toast }))

import {
  adoptedFilesAwaitingIdmlAlignment,
  markAdoptedFilesForIdmlAlignment,
  resetAdoptedIdmlAlignmentForTests,
} from "@/lib/idml/link-adopted-align"
import type { IdmlReimportAlignHost } from "@/lib/idml/align-reimported-targets"
import { useAdoptedIdmlAlignment, type UseAdoptedIdmlAlignmentArgs } from "./useAdoptedIdmlAlignment"

const host: IdmlReimportAlignHost = {
  ask: async () => "",
  author: "dev",
  model: "frontier-default",
  provider: "frontier",
  flush: async () => {},
}

const FILES = [
  { id: "own-notes", name: "Notes.idml", type: "idml" },
  { id: "own-mrk", name: "MRK", type: "usfm" },
]

function outcome(extra: Partial<{ aligned: unknown[]; manual: unknown[] }> = {}) {
  return { aligned: [], unchanged: 0, failed: 0, skipped: 0, manual: [], ...extra }
}

function argsFor(overrides: Partial<UseAdoptedIdmlAlignmentArgs> = {}): UseAdoptedIdmlAlignmentArgs {
  return {
    projectId: "proj",
    files: FILES,
    jwt: "jwt",
    lane: "",
    getToken: async () => "token",
    host,
    sourceLanguage: "en",
    targetLanguage: "pt",
    syncLink: vi.fn(async () => true),
    ...overrides,
  }
}

beforeEach(() => {
  localStorage.clear()
  resetAdoptedIdmlAlignmentForTests()
  alignReimportedIdmlFile.mockReset()
  alignReimportedIdmlFile.mockResolvedValue(outcome({ aligned: [{}, {}] }))
  toast.add.mockClear()
  toast.update.mockClear()
  toast.close.mockClear()
})

afterEach(() => {
  resetAdoptedIdmlAlignmentForTests()
})

describe("useAdoptedIdmlAlignment", () => {
  // WHY: the whole point — a link that replaced an IDML file's source has to
  // end the way a re-import does, with the kept translations placed into the
  // new source. The join is the sync's first step, so the sync runs first; a
  // file that is not IDML has nothing to place and is simply forgotten.
  it("syncs the link, then runs the re-import placement over the recorded IDML files and forgets the rest", async () => {
    markAdoptedFilesForIdmlAlignment("proj", ["own-notes", "own-mrk", "own-gone"])
    const args = argsFor()

    renderHook(() => useAdoptedIdmlAlignment(args))

    await waitFor(() => expect(alignReimportedIdmlFile).toHaveBeenCalledTimes(1))
    expect(args.syncLink).toHaveBeenCalledWith("jwt", "proj")
    expect(alignReimportedIdmlFile).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "proj",
      fileId: "own-notes",
      lane: "",
      host,
      sourceLanguage: "en",
      targetLanguage: "pt",
    }))
    await waitFor(() => expect(adoptedFilesAwaitingIdmlAlignment("proj")).toEqual([]))
    expect(toast.update).toHaveBeenLastCalledWith("toast-1", expect.objectContaining({
      type: "success",
      title: "2 translations in Notes.idml were placed into the linked source.",
    }))
  })

  it("runs nothing while the project's files are still loading, and once they arrive", async () => {
    markAdoptedFilesForIdmlAlignment("proj", ["own-notes"])
    const { rerender } = renderHook(
      (props: UseAdoptedIdmlAlignmentArgs) => useAdoptedIdmlAlignment(props),
      { initialProps: argsFor({ files: undefined }) },
    )
    expect(alignReimportedIdmlFile).not.toHaveBeenCalled()

    rerender(argsFor())

    await waitFor(() => expect(alignReimportedIdmlFile).toHaveBeenCalledTimes(1))
  })

  // WHY: placing against the OLD source (the join not landed yet) would find
  // nothing to do and forget the file. When the sync cannot run the record
  // stays, for the next load — and the translations are never touched.
  it("leaves the file recorded and places nothing when the link cannot be synced", async () => {
    markAdoptedFilesForIdmlAlignment("proj", ["own-notes"])
    const args = argsFor({ syncLink: vi.fn(async () => false) })

    renderHook(() => useAdoptedIdmlAlignment(args))

    await waitFor(() => expect(args.syncLink).toHaveBeenCalledTimes(1))
    expect(alignReimportedIdmlFile).not.toHaveBeenCalled()
    expect(adoptedFilesAwaitingIdmlAlignment("proj")).toEqual(["own-notes"])
    expect(toast.add).not.toHaveBeenCalled()
  })

  it("keeps a file whose placement failed for the next load, and says so once", async () => {
    markAdoptedFilesForIdmlAlignment("proj", ["own-notes"])
    alignReimportedIdmlFile.mockRejectedValueOnce(new Error("offline"))
    const args = argsFor()

    const { rerender } = renderHook(
      (props: UseAdoptedIdmlAlignmentArgs) => useAdoptedIdmlAlignment(props),
      { initialProps: args },
    )

    await waitFor(() => expect(toast.update).toHaveBeenCalledWith("toast-1", expect.objectContaining({
      type: "error",
      title: "Couldn't place the translations in Notes.idml into the linked source: offline",
    })))
    expect(adoptedFilesAwaitingIdmlAlignment("proj")).toEqual(["own-notes"])
    // A new file-list identity (a project refresh) does not retry it this session.
    rerender(argsFor({ files: [...FILES] }))
    expect(alignReimportedIdmlFile).toHaveBeenCalledTimes(1)
  })

  it("marks cells the model could not place and closes quietly when every translation already fits", async () => {
    markAdoptedFilesForIdmlAlignment("proj", ["own-notes"])
    alignReimportedIdmlFile.mockResolvedValueOnce(outcome({ aligned: [{}], manual: [{}] }))
    renderHook(() => useAdoptedIdmlAlignment(argsFor()))
    await waitFor(() => expect(toast.update).toHaveBeenCalledWith("toast-1", expect.objectContaining({
      type: "warning",
      title: "1 translation in Notes.idml could not be placed into the linked source automatically. It is marked for Align styles.",
    })))

    resetAdoptedIdmlAlignmentForTests()
    markAdoptedFilesForIdmlAlignment("proj-2", ["own-notes"])
    alignReimportedIdmlFile.mockResolvedValueOnce(outcome())
    renderHook(() => useAdoptedIdmlAlignment(argsFor({ projectId: "proj-2" })))
    await waitFor(() => expect(toast.close).toHaveBeenCalledWith("toast-1"))
    expect(adoptedFilesAwaitingIdmlAlignment("proj-2")).toEqual([])
  })
})
