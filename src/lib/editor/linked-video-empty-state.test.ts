import { describe, it, expect } from "vitest"
import { captionsBecomeRows, deriveLinkedVideoEmptyState, mediaEmptyGates } from "./linked-video-empty-state"

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

// AQU-1565 / AQU-1566: the gates themselves, not the props a component test
// chooses to pass. Each must sit at the server's floor for the write it leads
// to: a Project Lead offered captions as rows would stage a hidden file that
// the maintainer-only promotion then refuses.
describe("mediaEmptyGates", () => {
  const CONTRIBUTOR = 400
  const PROJECT_LEAD = 500
  const MAINTAINER = 600
  const gates = (roleLevel: number | null, captionRowsMode: boolean, canEditTracks = false) =>
    mediaEmptyGates({ roleLevel, captionRowsMode, canEditTracks, coversEveryLanguage: true })

  it("offers captions as rows to maintainers only, with track editing off", () => {
    expect(gates(MAINTAINER, true)).toEqual({
      offerCaptionRows: true, canImportCaptions: true, canUploadSourceMedia: true, offerVideoSoundRows: false,
      sourceMediaNote: null,
    })
    expect(gates(PROJECT_LEAD, true)).toEqual({
      offerCaptionRows: false, canImportCaptions: false, canUploadSourceMedia: true, offerVideoSoundRows: false,
      sourceMediaNote: null,
    })
    expect(gates(CONTRIBUTOR, true)).toEqual({
      offerCaptionRows: false, canImportCaptions: false, canUploadSourceMedia: false, offerVideoSoundRows: false,
      sourceMediaNote: null,
    })
  })

  // AQU-2682: the recording is the file's source audio, which the server
  // takes only from someone whose access covers every language. The app asks
  // the server (useSourceAudioAccess) and offers the upload only on its yes.
  describe("access to every language", () => {
    const FILM = "https://cdn.thechosen.media/videos/ep101/master.m3u8"
    const withAccess = (roleLevel: number | null, coversEveryLanguage: boolean | null) =>
      mediaEmptyGates({ roleLevel, captionRowsMode: true, canEditTracks: false, linkedVideoUrl: FILM, coversEveryLanguage })

    it("withholds the upload from a Project Lead missing a language, and says why", () => {
      expect(withAccess(PROJECT_LEAD, false)).toMatchObject({
        canUploadSourceMedia: false, sourceMediaNote: "needsEveryLanguage",
      })
    })

    it("still offers it to a Project Lead with every language, and to Maintainers and up", () => {
      expect(withAccess(PROJECT_LEAD, true)).toMatchObject({ canUploadSourceMedia: true, sourceMediaNote: null })
      expect(withAccess(MAINTAINER, true)).toMatchObject({
        canUploadSourceMedia: true, offerVideoSoundRows: true, sourceMediaNote: null,
      })
      expect(withAccess(700, true)).toMatchObject({ canUploadSourceMedia: true, sourceMediaNote: null })
    })

    it("offers nothing that stores source audio before the answer arrives (slow or no network)", () => {
      for (const role of [PROJECT_LEAD, MAINTAINER, null]) {
        expect(withAccess(role, null)).toMatchObject({
          canUploadSourceMedia: false, offerVideoSoundRows: false, sourceMediaNote: "checking",
        })
      }
    })

    it("keeps the film's sound from a Maintainer the server says is limited", () => {
      expect(withAccess(MAINTAINER, false)).toMatchObject({
        offerVideoSoundRows: false, canUploadSourceMedia: false, sourceMediaNote: "needsEveryLanguage",
      })
    })

    it("adds no note below Project Lead, where the waiting line already says who can", () => {
      expect(withAccess(CONTRIBUTOR, false).sourceMediaNote).toBeNull()
      expect(withAccess(CONTRIBUTOR, null).sourceMediaNote).toBeNull()
    })

    it("leaves the caption actions alone", () => {
      expect(withAccess(MAINTAINER, false)).toMatchObject({ offerCaptionRows: true, canImportCaptions: true })
    })
  })

  it("keeps the timeline's Attach captions behind track editing once the file has rows", () => {
    expect(gates(MAINTAINER, false, false).canImportCaptions).toBe(false)
    expect(gates(MAINTAINER, false, true).canImportCaptions).toBe(true)
    expect(gates(MAINTAINER, false, true).offerCaptionRows).toBe(false)
  })

  it("offers the recording upload from Project Lead up, on every empty media file", () => {
    for (const rows of [true, false]) {
      expect(gates(CONTRIBUTOR, rows).canUploadSourceMedia).toBe(false)
      expect(gates(PROJECT_LEAD, rows).canUploadSourceMedia).toBe(true)
    }
  })

  it("does not offer maintainer actions before the role is known", () => {
    expect(gates(null, true).offerCaptionRows).toBe(false)
  })

  // AQU-1681: rows from the linked video's own sound. Maintainer work, on the
  // same empty file as caption rows, and never for YouTube, whose sound the
  // page cannot read (and whose terms forbid downloading it).
  describe("rows from the video's own sound", () => {
    const sound = (roleLevel: number | null, captionRowsMode: boolean, linkedVideoUrl: string | null) =>
      mediaEmptyGates({ roleLevel, captionRowsMode, canEditTracks: false, linkedVideoUrl, coversEveryLanguage: true }).offerVideoSoundRows
    const FILM = "https://cdn.thechosen.media/videos/ep101/master.m3u8"

    it("offers a streamed film or a direct file link to a maintainer on an empty file", () => {
      expect(sound(MAINTAINER, true, FILM)).toBe(true)
      expect(sound(MAINTAINER, true, "https://files.example.test/ep101.mp4")).toBe(true)
    })

    it("never offers it for a YouTube video", () => {
      expect(sound(MAINTAINER, true, "https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(false)
      expect(sound(MAINTAINER, true, "https://youtu.be/dQw4w9WgXcQ")).toBe(false)
    })

    it("needs a maintainer, a file whose rows loaded empty, and a fetchable link", () => {
      expect(sound(PROJECT_LEAD, true, FILM)).toBe(false)
      expect(sound(null, true, FILM)).toBe(false)
      expect(sound(MAINTAINER, false, FILM)).toBe(false)
      expect(sound(MAINTAINER, true, "frontier-audio://clip.mp4")).toBe(false)
      expect(sound(MAINTAINER, true, null)).toBe(false)
    })
  })
})
