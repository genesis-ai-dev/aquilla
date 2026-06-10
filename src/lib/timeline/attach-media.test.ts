import { describe, it, expect } from "vitest"
import { attachMediaUrlToTimeline, mediaNameFromUrl, type AttachMediaContext } from "./attach-media"

// WHY: a URL attach writes a timed media segment + attachment into the event
// log. A malformed or non-http(s) URL must be rejected up front — before any
// event is emitted — or the file ends up with a half-attached, unplayable
// segment that the user can't easily remove.

const ctx: AttachMediaContext = {
  projectId: "p1",
  fileId: "f1",
  author: "tester",
  getToken: async () => {
    throw new Error("getToken must not be called for invalid URLs")
  },
}

describe("attachMediaUrlToTimeline input validation", () => {
  it("rejects malformed URLs before emitting any event", async () => {
    await expect(attachMediaUrlToTimeline("not a url", ctx)).rejects.toThrow(/valid URL/)
  })

  it("rejects non-http(s) schemes before emitting any event", async () => {
    await expect(attachMediaUrlToTimeline("ftp://host/clip.mp4", ctx)).rejects.toThrow(/http/)
  })
})

describe("mediaNameFromUrl", () => {
  // WHY: the segment's `value` is what the user sees in the media layer — it
  // should read as a clip name, not a full URL with query noise.
  it("uses the decoded path basename", () => {
    expect(mediaNameFromUrl("https://cdn.example.com/shows/Episode%201.mp4?sig=abc")).toBe("Episode 1.mp4")
  })

  it("falls back to the hostname when the path is empty", () => {
    expect(mediaNameFromUrl("https://cdn.example.com/")).toBe("cdn.example.com")
  })
})
