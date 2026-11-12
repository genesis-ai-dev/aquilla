import { describe, it, expect, vi, beforeEach } from "vitest"
import { waitFor } from "@testing-library/react"

import { createYouTubeCaptionCommit } from "./youtube-caption-commit"
import { prepareYouTubeCaptionImport } from "./youtube-captions"
import { emitParsedFile } from "../import"
import { publishStagedImport } from "../sync/bulk-import"

vi.mock("../import", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../import")>()
  return { ...actual, emitParsedFile: vi.fn() }
})

vi.mock("../sync/bulk-import", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sync/bulk-import")>()
  return { ...actual, publishStagedImport: vi.fn() }
})

beforeEach(() => {
  vi.resetAllMocks()
})

describe("createYouTubeCaptionCommit", () => {
  const prepared = prepareYouTubeCaptionImport({
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    captionName: "Captions.srt",
    captionText: "1\n00:00:01,000 --> 00:00:02,000\nHello world",
  })

  const ctx = {
    projectId: "p1",
    author: "dev",
    getToken: async () => "token",
  }

  const stagedResult = {
    ref: {
      id: "f1",
      name: "Captions",
      type: "srt" as const,
      createdAt: new Date().toISOString(),
      cellCount: 1,
      orderedBy: "time" as const,
    },
    speakerPairs: [],
  }

  it("stages with deferPublication:true and publishes prepared.videoUrl scoped to f1", async () => {
    vi.mocked(emitParsedFile).mockResolvedValueOnce(stagedResult)
    vi.mocked(publishStagedImport).mockResolvedValueOnce(undefined)

    const commit = createYouTubeCaptionCommit(prepared, ctx)
    const result = await commit()

    expect(result).toEqual({ ...stagedResult, ref: { ...stagedResult.ref, coreMediaUrl: prepared.videoUrl } })
    expect(vi.mocked(emitParsedFile)).toHaveBeenCalledOnce()
    const emitCall = vi.mocked(emitParsedFile).mock.calls[0][2]
    expect(emitCall.deferPublication).toBe(true)
    expect(vi.mocked(emitParsedFile)).toHaveBeenCalledWith(prepared, "srt", expect.objectContaining({ projectId: "p1" }))
    expect(vi.mocked(publishStagedImport)).toHaveBeenCalledOnce()
    const publishCall = vi.mocked(publishStagedImport).mock.calls[0][0]
    expect(publishCall.fileId).toBe("f1")
    expect(publishCall.coreMediaUrl).toBe(prepared.videoUrl)
  })

  it("retries publication on failure, reusing staged f1", async () => {
    vi.mocked(emitParsedFile).mockResolvedValueOnce(stagedResult)
    vi.mocked(publishStagedImport)
      .mockRejectedValueOnce(new Error("publish failed"))
      .mockResolvedValueOnce(undefined)

    const commit = createYouTubeCaptionCommit(prepared, ctx)
    await expect(commit()).rejects.toThrow("publish failed")

    expect(vi.mocked(emitParsedFile)).toHaveBeenCalledOnce()
    expect(vi.mocked(publishStagedImport)).toHaveBeenCalledOnce()

    const result = await commit()

    expect(result).toEqual({ ...stagedResult, ref: { ...stagedResult.ref, coreMediaUrl: prepared.videoUrl } })
    expect(vi.mocked(emitParsedFile)).toHaveBeenCalledOnce()
    expect(vi.mocked(publishStagedImport)).toHaveBeenCalledTimes(2)
    const first = vi.mocked(publishStagedImport).mock.calls[0][0]
    const retry = vi.mocked(publishStagedImport).mock.calls[1][0]
    expect(first).toMatchObject({
      publishEventId: expect.any(String), videoEventId: expect.any(String),
    })
    expect(retry).toMatchObject({
      publishEventId: first.publishEventId,
      videoEventId: first.videoEventId,
    })
  })

  it("shares stage and publish when invoked concurrently", async () => {
    let resolvePublish: () => void
    const publishPromise = new Promise<void>((resolve) => {
      resolvePublish = resolve
    })

    vi.mocked(emitParsedFile).mockResolvedValueOnce(stagedResult)
    vi.mocked(publishStagedImport).mockReturnValueOnce(publishPromise)

    const commit = createYouTubeCaptionCommit(prepared, ctx)
    const promise1 = commit()
    const promise2 = commit()

    expect(vi.mocked(emitParsedFile)).toHaveBeenCalledOnce()
    await waitFor(() => expect(vi.mocked(publishStagedImport)).toHaveBeenCalledOnce())
    resolvePublish!()
    const [result1, result2] = await Promise.all([promise1, promise2])

    expect(result1).toEqual({ ...stagedResult, ref: { ...stagedResult.ref, coreMediaUrl: prepared.videoUrl } })
    expect(result2).toEqual({ ...stagedResult, ref: { ...stagedResult.ref, coreMediaUrl: prepared.videoUrl } })
    expect(vi.mocked(emitParsedFile)).toHaveBeenCalledOnce()
    expect(vi.mocked(publishStagedImport)).toHaveBeenCalledOnce()
  })

  it("returns same result on repeated successful commit without further publication", async () => {
    vi.mocked(emitParsedFile).mockResolvedValueOnce(stagedResult)
    vi.mocked(publishStagedImport).mockResolvedValueOnce(undefined)

    const commit = createYouTubeCaptionCommit(prepared, ctx)
    const result1 = await commit()
    const result2 = await commit()

    expect(result1).toEqual({ ...stagedResult, ref: { ...stagedResult.ref, coreMediaUrl: prepared.videoUrl } })
    expect(result2).toEqual({ ...stagedResult, ref: { ...stagedResult.ref, coreMediaUrl: prepared.videoUrl } })
    expect(vi.mocked(emitParsedFile)).toHaveBeenCalledOnce()
    expect(vi.mocked(publishStagedImport)).toHaveBeenCalledOnce()
  })
})
