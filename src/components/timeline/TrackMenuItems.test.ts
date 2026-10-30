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

// AQU-1684: anyone may hide tracks on their own screen — never a folder, and
// not while one of them is recording or being dragged.
describe("trackMenuScopes — hide (AQU-1684)", () => {
  const tracks = deriveTracksForFile(null)
  const byId = (id: string) => tracks.find((track) => track.id === id)!
  const folder = { id: "f", kind: "folder", name: "Folder", order: 9, groupId: null } as TimelineTrack
  const scopes = (targets: TimelineTrack[], busy?: string[]) =>
    trackMenuScopes({ targets, canRename: false, canColour: false, canEdit: false, canHide: true, busyIds: new Set(busy) })

  it("hides every selected track but a folder, and is enough to open the menu", () => {
    const s = scopes([byId("source-audio"), byId("target-audio"), folder])
    expect(s.hideable.map((t) => t.id)).toEqual(["source-audio", "target-audio"])
    expect(trackMenuIsEmpty(scopes([byId("source-audio")]))).toBe(false)
    expect(trackMenuIsEmpty(scopes([folder]))).toBe(true)
  })

  it("is held back while one of them is busy", () => {
    expect(scopes([byId("target-audio")], ["target-audio"]).hideBusy).toBe(true)
    expect(scopes([byId("source-audio")], ["target-audio"]).hideBusy).toBe(false)
  })

  it("is nothing without the callback", () => {
    expect(trackMenuScopes({ targets: [byId("source-audio")], canRename: false, canColour: false, canEdit: false }).hideable).toEqual([])
  })
})

// AQU-2252 (Sam, Oct 29): "Sets line lengths", checkable, on an added audio
// track's ⋯ menu — for the people who may restructure tracks, while the file
// follows its recordings (following the source nothing sets a line's length).
describe("trackMenuScopes — sets line lengths (AQU-2252)", () => {
  const tracks = deriveTracksForFile({ trackOverrides: {
    boaz: { kind: "audio", name: "Boaz" },
    music: { kind: "audio", name: "Music", setsLineLengths: false },
    grp: { kind: "folder", name: "Voices" },
  } })
  const byId = (id: string) => tracks.find(track => track.id === id)!
  const scopes = (targets: TimelineTrack[], canSetLengths = true) =>
    trackMenuScopes({ targets, canRename: false, canColour: false, canEdit: true, canSetLengths })

  it("is offered on added audio tracks, ticked while they set their lines' lengths", () => {
    expect(scopes([byId("boaz")]).lengths).toEqual({ tracks: [byId("boaz")], checked: true })
    expect(scopes([byId("music")]).lengths).toEqual({ tracks: [byId("music")], checked: false })
  })

  it("is all or nothing over a selection, ticked only when every one sets them", () => {
    expect(scopes([byId("boaz"), byId("music")]).lengths).toEqual({ tracks: [byId("boaz"), byId("music")], checked: false })
    expect(scopes([byId("boaz"), byId("target-audio")]).lengths).toBeNull()
  })

  it("is never offered on the main track, a folder or a text track", () => {
    expect(scopes([byId("target-audio")]).lengths).toBeNull()
    expect(scopes([byId("grp")]).lengths).toBeNull()
    expect(scopes([byId("source-subtitles")]).lengths).toBeNull()
  })

  it("is not offered without the clearance, or following the source", () => {
    expect(scopes([byId("boaz")], false).lengths).toBeNull()
  })

  it("keeps a menu that offers only this from being treated as empty", () => {
    expect(trackMenuIsEmpty(scopes([byId("boaz")]))).toBe(false)
  })
})
