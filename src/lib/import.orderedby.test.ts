import { describe, it, expect, vi, afterEach } from "vitest"
import { orderedByForFileType, buildBulkCellsWithSpeakers, emitMediaFile } from "./import"
import { detectFileType } from "./parsers/types"
import type { TranslatableString } from "./parsers/types"

describe("media import picture publication", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it.each(["video", "audio"] as const)(
    "publishes %s with its source artifact and appropriate picture",
    async (fileType) => {
      const bodies: Array<Record<string, unknown>> = []
      const uploads: RequestInit[] = []
      vi.stubGlobal("fetch", vi.fn(async (_url, init: RequestInit) => {
        if (init.method === "PUT") uploads.push(init)
        else bodies.push(JSON.parse(String(init.body)))
        return Response.json({ accepted: 1 })
      }))
      const createElement = document.createElement.bind(document)
      vi.spyOn(document, "createElement").mockImplementation((tag, options) => {
        if (tag !== "video" && tag !== "audio") {
          return createElement(tag, options)
        }
        const media = createElement(tag)
        Object.defineProperty(media, "duration", { value: 2 })
        Object.defineProperty(media, "src", { set() {
          queueMicrotask(() => media.dispatchEvent(new Event("loadedmetadata")))
        } })
        return media
      })
      const file = new File(["clip"], fileType === "video" ? "clip.mp4" : "clip.mp3", {
        type: fileType === "video" ? "video/mp4" : "audio/mpeg",
      })
      const ref = await emitMediaFile(file, fileType, {
        projectId: "p1", author: "dev", getToken: async () => "token",
      })
      expect(ref.orderedBy).toBe("time")
      expect(uploads).toHaveLength(1)
      expect(uploads[0].body).toBe(file)
      expect(uploads[0].headers).toHaveProperty("X-Artifact-Id")
      const publication = bodies.at(-1)!
      const attachments = publication.attachments as Array<{ url: string }>
      expect(attachments).toHaveLength(1)
      if (fileType === "video") {
        expect(publication.video).toEqual({
          id: expect.any(String), coreMediaUrl: attachments[0].url,
        })
      } else {
        expect(publication).not.toHaveProperty("video")
      }
    },
  )
})

// WHY: subtitle imports must become TIME-ordered (their cues are the timeline
// spine) while every text/document format stays SEQUENCE-ordered. And every
// imported cell must carry an intrinsic sequenceIndex so the order lens has a
// stable key / home for untimed rows. Regressions here silently break the
// editor's layer switch (it's gated on orderedBy==='time').

describe("orderedByForFileType", () => {
  it("marks subtitle formats as time-ordered", () => {
    expect(orderedByForFileType("vtt")).toBe("time")
    expect(orderedByForFileType("srt")).toBe("time")
  })
  it("marks audio/video media as time-ordered", () => {
    expect(orderedByForFileType("audio")).toBe("time")
    expect(orderedByForFileType("video")).toBe("time")
  })
  it("leaves text/document formats sequence-ordered", () => {
    for (const t of ["usfm", "ebible", "docx", "txt", "csv"] as const) {
      expect(orderedByForFileType(t)).toBe("sequence")
    }
  })
})

describe("detectFileType — media extensions", () => {
  it("maps common audio/video extensions", () => {
    expect(detectFileType("scene.mp3")).toBe("audio")
    expect(detectFileType("scene.wav")).toBe("audio")
    expect(detectFileType("episode.mp4")).toBe("video")
    expect(detectFileType("episode.mov")).toBe("video")
  })
  it("still maps subtitle/text extensions", () => {
    expect(detectFileType("a.vtt")).toBe("vtt")
    expect(detectFileType("b.usfm")).toBe("usfm")
  })
})

describe("buildBulkCellsWithSpeakers — sequenceIndex", () => {
  it("assigns a 0-based intrinsic order to every cell, in input order", () => {
    const strings: TranslatableString[] = [
      { id: "", original: "one", translated: "", context: "", group: "", type: "cue", start: 1, end: 2 },
      { id: "", original: "two", translated: "", context: "", group: "", type: "cue", start: 3, end: 4 },
      { id: "", original: "three", translated: "", context: "", group: "", type: "cue" },
    ]
    const { cells } = buildBulkCellsWithSpeakers(strings)
    expect(cells.map((c) => c.sequenceIndex)).toEqual([0, 1, 2])
    // Untimed third cell still gets an order key (no fake timecodes).
    expect(cells[2].startMs).toBeUndefined()
    expect(cells[2].sequenceIndex).toBe(2)
  })
})
