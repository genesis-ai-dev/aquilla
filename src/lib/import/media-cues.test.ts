import { afterEach, describe, expect, it, vi } from "vitest"
import { emitMediaFile } from "../import"
import { extractSrtStrings, extractVttStrings } from "../parsers/subtitle"
import { extractSbvStrings } from "../parsers/sbv"
import { consumeMediaImportSeed } from "../audio/auto-transcribe"

const cases = [
  { format: "srt", parse: extractSrtStrings,
    text: "1\n00:00:00,200 --> 00:00:00,700\nFirst phrase\n\n2\n00:00:01,000 --> 00:00:01,800\nSecond phrase" },
  { format: "vtt", parse: extractVttStrings,
    text: "WEBVTT\n\n00:00:00.200 --> 00:00:00.700\nFirst phrase\n\n00:00:01.000 --> 00:00:01.800\nSecond phrase" },
  { format: "sbv", parse: extractSbvStrings,
    text: "0:00:00.200,0:00:00.700\nFirst phrase\n\n0:00:01.000,0:00:01.800\nSecond phrase" },
] as const

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("media with supplied subtitle cues", () => {
  it.each(cases)("commits $format wording, timed source audio and both originals", async ({ format, parse, text }) => {
    const requests: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal("fetch", vi.fn(async (url, init: RequestInit) => {
      requests.push({ url: String(url), init })
      return Response.json({ accepted: 1 })
    }))
    const createElement = document.createElement.bind(document)
    vi.spyOn(document, "createElement").mockImplementation((tag, options) => {
      const element = createElement(tag, options)
      if (tag === "audio" || tag === "video") {
        Object.defineProperty(element, "duration", { value: 2 })
        Object.defineProperty(element, "src", { set() {
          queueMicrotask(() => element.dispatchEvent(new Event("loadedmetadata")))
        } })
      }
      return element
    })
    const original = new TextEncoder().encode(text).buffer
    const media = new File(["audio bytes"], "clip.mp3", { type: "audio/mpeg" })
    const ref = await emitMediaFile(media, "audio", {
      projectId: "p1", author: "dev", getToken: async () => "token",
      mediaTextSource: {
        cues: parse(text),
        artifact: { name: `clip.${format}`, bytes: original, format },
      },
    })
    const posts = requests.filter(request => request.init.method === "POST")
      .map(request => JSON.parse(String(request.init.body)))
    expect(posts[0].cells).toEqual([
      expect.objectContaining({ medium: "media", startMs: 200, endMs: 700, sequenceIndex: 0 }),
      expect.objectContaining({ medium: "media", startMs: 1000, endMs: 1800, sequenceIndex: 1 }),
    ])
    expect(posts.at(-1).attachments).toEqual([
      expect.objectContaining({ transcription: "First phrase", trimStartMs: 200, trimEndMs: 700 }),
      expect.objectContaining({ transcription: "Second phrase", trimStartMs: 1000, trimEndMs: 1800 }),
    ])
    const puts = requests.filter(request => request.init.method === "PUT")
    expect(puts).toHaveLength(2)
    expect(puts.find(request => request.url.endsWith("/source"))?.init.body).toEqual(original)
    expect(puts.find(request => !request.url.endsWith("/source"))?.init.body).toBe(media)
    expect(ref.cellCount).toBe(2)
    expect(consumeMediaImportSeed(ref.id)).toBeUndefined()
  })
})
