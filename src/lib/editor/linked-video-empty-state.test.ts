import { describe, it, expect } from "vitest"
import { deriveLinkedVideoEmptyState } from "./linked-video-empty-state"

const base = {
  orderedBy: "time" as const,
  cellCount: 0,
  coreMediaUrl: "https://www.youtube.com/watch?v=M7lc1UVf-VE",
  captionTrackNames: [] as readonly string[],
}

describe("deriveLinkedVideoEmptyState (AQU-1565)", () => {
  it("claims a time-ordered file with no rows but a linked YouTube video", () => {
    expect(deriveLinkedVideoEmptyState(base)).toEqual({
      isYouTube: true,
      captionTrackNames: [],
    })
  })

  it("leaves a file with no linked video to the ordinary attach-media prompt", () => {
    expect(deriveLinkedVideoEmptyState({ ...base, coreMediaUrl: null })).toBeNull()
    expect(deriveLinkedVideoEmptyState({ ...base, coreMediaUrl: "   " })).toBeNull()
    expect(deriveLinkedVideoEmptyState({ ...base, coreMediaUrl: undefined })).toBeNull()
  })

  it("leaves a file that HAS rows alone — there is no empty state to show", () => {
    expect(deriveLinkedVideoEmptyState({ ...base, cellCount: 1 })).toBeNull()
  })

  it("never fires on a sequence-ordered file", () => {
    expect(deriveLinkedVideoEmptyState({ ...base, orderedBy: "sequence" })).toBeNull()
    expect(deriveLinkedVideoEmptyState({ ...base, orderedBy: undefined })).toBeNull()
  })

  // A non-YouTube picture (an authenticated streaming link, AQU-1478) is still
  // a linked video — it just must not be CALLED a YouTube one.
  it("marks a non-YouTube linked picture as a plain video", () => {
    expect(deriveLinkedVideoEmptyState({
      ...base,
      coreMediaUrl: "https://media.example.com/stream/abc.m3u8",
    })).toEqual({ isYouTube: false, captionTrackNames: [] })
  })

  it("carries the attached caption tracks through", () => {
    expect(deriveLinkedVideoEmptyState({
      ...base,
      captionTrackNames: ["English captions", "Burmese captions"],
    })).toEqual({
      isYouTube: true,
      captionTrackNames: ["English captions", "Burmese captions"],
    })
  })
})
