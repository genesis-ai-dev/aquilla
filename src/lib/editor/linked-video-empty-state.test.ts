import { describe, it, expect } from "vitest"
import { captionsBecomeRows, deriveLinkedVideoEmptyState } from "./linked-video-empty-state"

const base = {
  orderedBy: "time" as const,
  cellCount: 0,
  coreMediaUrl: "https://www.youtube.com/watch?v=M7lc1UVf-VE",
  captionTracks: [] as const,
}

describe("deriveLinkedVideoEmptyState (AQU-1565)", () => {
  it("claims a time-ordered file with no rows but a linked YouTube video", () => {
    expect(deriveLinkedVideoEmptyState(base)).toEqual({
      isYouTube: true,
      captionTracks: [],
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
    })).toEqual({ isYouTube: false, captionTracks: [] })
  })

  it("carries the attached caption tracks through, ids and all", () => {
    const captionTracks = [
      { id: "t-en", name: "English captions", canBecomeRows: true },
      { id: "target-subtitles", name: "Burmese captions", canBecomeRows: false },
    ]
    expect(deriveLinkedVideoEmptyState({ ...base, captionTracks })).toEqual({
      isYouTube: true,
      captionTracks,
    })
  })
})

// AQU-1566: the caption dialog's "rows" mode is chosen from this, so a second
// caption file on a file whose rows are still loading never goes to rows.
describe("captionsBecomeRows (AQU-1566)", () => {
  const empty = deriveLinkedVideoEmptyState(base)

  it("is yes for an empty linked video whose rows have loaded", () => {
    expect(captionsBecomeRows(empty, { loading: false, failed: false })).toBe(true)
  })

  it("waits for the rows to load before believing there are none", () => {
    expect(captionsBecomeRows(empty, { loading: true, failed: false })).toBe(false)
  })

  it("does not trust an empty list from a failed read", () => {
    expect(captionsBecomeRows(empty, { loading: false, failed: true })).toBe(false)
  })

  it("is no for a file with rows, or with no linked video", () => {
    expect(captionsBecomeRows(deriveLinkedVideoEmptyState({ ...base, cellCount: 3 }),
      { loading: false, failed: false })).toBe(false)
    expect(captionsBecomeRows(deriveLinkedVideoEmptyState({ ...base, coreMediaUrl: null }),
      { loading: false, failed: false })).toBe(false)
  })
})
