// AQU-1832 — merging a pushed progress frame instead of refetching it.
//
// The push is allowed to save a read; it is never allowed to be the only way
// a number arrives. So the cases that matter most here are the REFUSALS: each
// one returns false, and the caller then does the exact invalidate-and-refetch
// it would have done before this existed. A merge that quietly guesses is
// worse than the request it saved.

import "fake-indexeddb/auto"
import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  applyPushedFileProgress,
  resetFileProgressResourceForTests,
  useFileProgressResource,
  type FileProgressResponse,
  type ProgressCounts,
  type PushedFileProgress,
} from "./file-progress-resource"

const counts = (filled: number, total = 4): ProgressCounts => ({
  totalCount: total,
  filledCount: filled,
  validatedCount: 0,
  validationLevels: [0],
  audioCount: 0,
  audioValidatedCount: 0,
})

function served(fileId: string, filled: number, revision = 1): FileProgressResponse {
  return {
    fileId,
    revision,
    validationCount: 1,
    file: counts(filled),
    sections: [
      { key: "GEN 1", ...counts(filled, 2) },
      { key: "GEN 2", ...counts(0, 2) },
    ],
    source: "projection",
  }
}

function push(over: Partial<PushedFileProgress> & { fileId: string }): PushedFileProgress {
  return {
    lane: "",
    revision: 2,
    validationCount: 1,
    complete: false,
    counts: counts(2),
    sections: [{ key: "GEN 1", ...counts(2, 2) }],
    ...over,
  }
}

const jsonResponse = (body: FileProgressResponse, etag: string) =>
  Response.json(body, { headers: { ETag: etag } })

/** Mount the resource with one server body already landed. */
async function mounted(fileId: string, body = served(fileId, 1)) {
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse(body, '"served"'))
  vi.stubGlobal("fetch", fetchMock)
  const hook = renderHook(() => useFileProgressResource("project", fileId, async () => "token"))
  await waitFor(() => expect(hook.result.current.progress?.revision).toBe(body.revision))
  fetchMock.mockClear()
  return { hook, fetchMock }
}

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  await resetFileProgressResourceForTests()
})

describe("AQU-1832 — applyPushedFileProgress", () => {
  it("lands a peer's numbers with no request of its own", async () => {
    const { hook, fetchMock } = await mounted("live")
    let merged = false
    await act(async () => {
      merged = applyPushedFileProgress("project", push({ fileId: "live" }))
    })
    expect(merged).toBe(true)
    expect(hook.result.current.progress?.file.filledCount).toBe(2)
    expect(hook.result.current.progress?.revision).toBe(2)
    // The whole point: no `/progress` read happened.
    expect(fetchMock).not.toHaveBeenCalled()
    hook.unmount()
  })

  it("upserts the sections it names and leaves the rest of the list alone", async () => {
    const { hook } = await mounted("upsert")
    await act(async () => { applyPushedFileProgress("project", push({ fileId: "upsert" })) })
    const sections = hook.result.current.progress!.sections
    // Order preserved — a partial frame must not reshuffle the chapter grid.
    expect(sections.map((s) => s.key)).toEqual(["GEN 1", "GEN 2"])
    expect(sections[0].filledCount).toBe(2)
    expect(sections[1].filledCount).toBe(0)
    hook.unmount()
  })

  it("replaces the whole list on a complete frame, so a vanished section vanishes", async () => {
    const { hook } = await mounted("complete")
    await act(async () => {
      applyPushedFileProgress("project", push({
        fileId: "complete",
        complete: true,
        sections: [{ key: "GEN 1", ...counts(2, 2) }],
      }))
    })
    expect(hook.result.current.progress!.sections.map((s) => s.key)).toEqual(["GEN 1"])
    hook.unmount()
  })

  it("refuses a partial frame naming a section the reader has never seen", async () => {
    // Appending it would put a chapter out of document order; only the read
    // route knows that order, so the read is what answers.
    const { hook } = await mounted("unknown-section")
    let merged = true
    await act(async () => {
      merged = applyPushedFileProgress("project", push({
        fileId: "unknown-section",
        sections: [{ key: "GEN 3", ...counts(1, 2) }],
      }))
    })
    expect(merged).toBe(false)
    expect(hook.result.current.progress!.sections.map((s) => s.key)).toEqual(["GEN 1", "GEN 2"])
    hook.unmount()
  })

  it("refuses when nothing has read this file+lane, rather than inventing a base", async () => {
    expect(applyPushedFileProgress("project", push({ fileId: "never-read" }))).toBe(false)
    // A named lane is a different resource from the default one.
    const { hook } = await mounted("lane-split")
    expect(applyPushedFileProgress("project", push({ fileId: "lane-split", lane: "fr" }))).toBe(false)
    expect(hook.result.current.progress!.file.filledCount).toBe(1)
    hook.unmount()
  })

  it("refuses to extend the pre-backfill fallback body", async () => {
    // Its section list is empty because the projection has not run, not
    // because the file has no chapters.
    const fallback = { ...served("fallback", 1), sections: [], source: "file-counter-fallback" as const }
    const { hook } = await mounted("fallback", fallback)
    expect(applyPushedFileProgress("project", push({ fileId: "fallback" }))).toBe(false)
    hook.unmount()
  })

  it("drops a frame older than what it holds, without buying a read to confirm", async () => {
    const { hook, fetchMock } = await mounted("stale", served("stale", 3, 5))
    let merged = false
    await act(async () => {
      merged = applyPushedFileProgress("project", push({ fileId: "stale", revision: 4, counts: counts(1) }))
    })
    // Handled, not refused: re-reading because two writers' passes finished
    // out of order would restore the request this exists to remove.
    expect(merged).toBe(true)
    expect(hook.result.current.progress!.file.filledCount).toBe(3)
    expect(fetchMock).not.toHaveBeenCalled()
    hook.unmount()
  })

  it("drops the stored ETag so the next read cannot be answered 304 against a body it no longer has", async () => {
    const { hook, fetchMock } = await mounted("etag")
    await act(async () => { applyPushedFileProgress("project", push({ fileId: "etag" })) })
    fetchMock.mockResolvedValue(jsonResponse(served("etag", 4, 9), '"fresh"'))
    await act(async () => { hook.result.current.retry() })
    await waitFor(() => expect(hook.result.current.progress?.revision).toBe(9))
    const headers = (fetchMock.mock.calls.at(-1)![1] as RequestInit).headers as Record<string, string>
    expect(headers["If-None-Match"]).toBeUndefined()
    hook.unmount()
  })

  it("keeps this client's own optimistic overlay on top of a peer's push", async () => {
    const { hook } = await mounted("overlay")
    const { setLocalFileProgress } = await import("./file-progress-resource")
    const local = { ...served("overlay", 9, 1), file: counts(9) }
    await act(async () => { setLocalFileProgress("project", "overlay", local, ["my-edit"]) })
    await act(async () => { applyPushedFileProgress("project", push({ fileId: "overlay" })) })
    // The un-flushed local edit still wins on screen, exactly as it does over
    // a server read — while the merged server body waits underneath it.
    expect(hook.result.current.progress!.file.filledCount).toBe(9)
    hook.unmount()
  })
})
