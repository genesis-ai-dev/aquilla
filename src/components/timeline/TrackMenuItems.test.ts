import { describe, expect, it } from "vitest"
import { deriveTracksForFile, type TimelineTrack } from "@/lib/timeline/tracks"
import { trackMenuIsEmpty, trackMenuScopes } from "./TrackMenuItems"

// AQU-1566: which track "Use as this file's rows" may act on. The server copies
// exactly ONE source caption file into the rows, so the menu offers it on
// exactly that and on nothing it would refuse.
describe("trackMenuScopes — promotable (AQU-1566)", () => {
  const tracks = deriveTracksForFile({ trackOverrides: {
    "ep-captions": { kind: "source-subtitles", name: "Episode captions", contentFileId: "c1" },
    "other": { kind: "source-subtitles", name: "Other captions", contentFileId: "c2" },
    "fr": { kind: "target-subtitles", name: "French", contentFileId: "c3" },
  } })
  const byId = (id: string) => tracks.find(track => track.id === id)!
  const scopes = (targets: TimelineTrack[], canPromote = true) =>
    trackMenuScopes({ targets, canRename: false, canColour: false, canEdit: false, canPromote })

  it("is the one source caption track that has its own content", () => {
    expect(scopes([byId("ep-captions")]).promotable?.id).toBe("ep-captions")
  })

  it("is the derived Source text row once it points at caption content", () => {
    const pointed = deriveTracksForFile({ trackOverrides: {
      "source-subtitles": { contentFileId: "c0" },
    } }).find(track => track.id === "source-subtitles")!
    expect(scopes([pointed]).promotable?.id).toBe("source-subtitles")
  })

  it("is nothing for the derived Source text row with no content, a target track, or a selection", () => {
    expect(scopes([byId("source-subtitles")]).promotable).toBeNull()
    expect(scopes([byId("fr")]).promotable).toBeNull()
    expect(scopes([byId("ep-captions"), byId("other")]).promotable).toBeNull()
  })

  it("is nothing without the clearance", () => {
    expect(scopes([byId("ep-captions")], false).promotable).toBeNull()
  })

  it("keeps a menu that offers only this from being treated as empty", () => {
    expect(trackMenuIsEmpty(scopes([byId("ep-captions")]))).toBe(false)
    expect(trackMenuIsEmpty(scopes([byId("fr")]))).toBe(true)
  })
})
