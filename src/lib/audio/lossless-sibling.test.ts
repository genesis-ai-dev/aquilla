import { beforeEach, describe, expect, it, vi } from "vitest"

const { probeMock, uploadMock } = vi.hoisted(() => ({
  probeMock: vi.fn(),
  uploadMock: vi.fn(),
}))

vi.mock("./upload", async (importActual) => {
  const actual = await importActual<typeof import("./upload")>()
  return { ...actual, probeCellAudioPresent: probeMock, uploadCellAudio: uploadMock }
})

import {
  resetAudioQualityPrefCacheForTests,
  setAudioQualityPref,
} from "@/lib/store/audio-quality-pref"

import {
  losslessSiblingPresent,
  markLosslessSiblingPresent,
  preferredPlaybackExt,
  resetLosslessSiblingMemoForTests,
  uploadLosslessSiblingBestEffort,
} from "./lossless-sibling"

const args = {
  projectId: "p1",
  fileId: "f1",
  audioId: "audio-c1-123-abc",
  getSyncToken: async () => "tok",
}

describe("lossless-sibling", () => {
  beforeEach(() => {
    localStorage.removeItem("aq.audio-quality.v1")
    resetAudioQualityPrefCacheForTests()
    resetLosslessSiblingMemoForTests()
    probeMock.mockReset()
    uploadMock.mockReset()
  })

  describe("losslessSiblingPresent", () => {
    it("probes the wav sibling and memoizes 'present' forever", async () => {
      probeMock.mockResolvedValue("present")
      expect(await losslessSiblingPresent(args)).toBe(true)
      expect(await losslessSiblingPresent(args)).toBe(true)
      expect(probeMock).toHaveBeenCalledTimes(1)
      expect(probeMock).toHaveBeenCalledWith(expect.objectContaining({ ext: "wav" }))
    })

    it("memoizes 'missing' forever — ids are immutable", async () => {
      probeMock.mockResolvedValue("missing")
      expect(await losslessSiblingPresent(args)).toBe(false)
      expect(await losslessSiblingPresent(args)).toBe(false)
      expect(probeMock).toHaveBeenCalledTimes(1)
    })

    it("does NOT memoize 'unknown' — a blip must not downgrade the session", async () => {
      probeMock.mockResolvedValueOnce("unknown").mockResolvedValueOnce("present")
      expect(await losslessSiblingPresent(args)).toBe(false)
      expect(await losslessSiblingPresent(args)).toBe(true)
      expect(probeMock).toHaveBeenCalledTimes(2)
    })

    it("dedupes concurrent probes onto one in-flight request", async () => {
      let release: (v: string) => void = () => {}
      probeMock.mockReturnValue(new Promise((r) => (release = r)))
      const a = losslessSiblingPresent(args)
      const b = losslessSiblingPresent(args)
      release("present")
      expect(await a).toBe(true)
      expect(await b).toBe(true)
      expect(probeMock).toHaveBeenCalledTimes(1)
    })

    it("skips the probe entirely after markLosslessSiblingPresent", async () => {
      markLosslessSiblingPresent(args.audioId)
      expect(await losslessSiblingPresent(args)).toBe(true)
      expect(probeMock).not.toHaveBeenCalled()
    })
  })

  describe("uploadLosslessSiblingBestEffort", () => {
    it("uploads under the same id with ext wav and pre-seeds the memo", async () => {
      uploadMock.mockResolvedValue({ audioId: args.audioId, ext: "wav", url: "u" })
      const ok = await uploadLosslessSiblingBestEffort({ ...args, wavBlob: new Blob(["x"]) })
      expect(ok).toBe(true)
      expect(uploadMock).toHaveBeenCalledWith(
        expect.objectContaining({ audioId: args.audioId, ext: "wav" }),
      )
      expect(await losslessSiblingPresent(args)).toBe(true)
      expect(probeMock).not.toHaveBeenCalled()
    })

    it("never throws — a failed sibling upload only warns", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
      uploadMock.mockRejectedValue(new Error("413 too large"))
      const ok = await uploadLosslessSiblingBestEffort({ ...args, wavBlob: new Blob(["x"]) })
      expect(ok).toBe(false)
      expect(warn).toHaveBeenCalled()
      warn.mockRestore()
    })
  })

  describe("preferredPlaybackExt", () => {
    const prefArgs = { ...args, attachmentExt: "webm", eligible: true }

    it("returns the attachment ext under the default (compressed) pref without probing", async () => {
      expect(await preferredPlaybackExt(prefArgs)).toBe("webm")
      expect(probeMock).not.toHaveBeenCalled()
    })

    it("returns wav when opted in and the sibling exists", async () => {
      setAudioQualityPref("original")
      probeMock.mockResolvedValue("present")
      expect(await preferredPlaybackExt(prefArgs)).toBe("wav")
    })

    it("falls back to the attachment ext when the sibling is missing", async () => {
      setAudioQualityPref("original")
      probeMock.mockResolvedValue("missing")
      expect(await preferredPlaybackExt(prefArgs)).toBe("webm")
    })

    it("never probes for ineligible attachments (mic takes, source clips)", async () => {
      setAudioQualityPref("original")
      expect(await preferredPlaybackExt({ ...prefArgs, eligible: false })).toBe("webm")
      expect(probeMock).not.toHaveBeenCalled()
    })

    it("short-circuits non-compressed primaries (server-side WAV voices)", async () => {
      setAudioQualityPref("original")
      expect(await preferredPlaybackExt({ ...prefArgs, attachmentExt: "wav" })).toBe("wav")
      expect(probeMock).not.toHaveBeenCalled()
    })
  })
})
