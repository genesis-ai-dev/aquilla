import { describe, expect, it } from "vitest"
import { deriveTracksForFile, type PersistedTrackOverrides } from "./tracks"

describe("deriveTracksForFile — contentFileId", () => {
  it("preserves distinct contentFileId values for two added source-subtitles tracks through JSON round-trip", () => {
    // Two user-added tracks of the same kind must keep their own contentFileId
    // after the overrides map has been through JSON (as it is when it arrives
    // from Postgres jsonb). The merge must not collapse them into one.
    const overrides = {
      "trk-a": { kind: "source-subtitles", contentFileId: "file-1" },
      "trk-b": { kind: "source-subtitles", contentFileId: "file-2" },
    }
    const persisted = JSON.parse(JSON.stringify(overrides))
    const tracks = deriveTracksForFile({ trackOverrides: persisted })
    const added = tracks.filter((t) => t.id === "trk-a" || t.id === "trk-b")
    expect(added).toHaveLength(2)
    expect(added[0].contentFileId).toBe("file-1")
    expect(added[1].contentFileId).toBe("file-2")
    expect(added[0].contentFileId).not.toBe(added[1].contentFileId)
  })

  it("pins contentFileId on an explicit source-subtitles default override and leaves others unchanged", () => {
    // A default track's contentFileId is set only when the override names it.
    // The other derived rows must not inherit or invent one.
    const overrides = {
      "source-subtitles": { contentFileId: "pinned-file" },
    }
    const tracks = deriveTracksForFile({ trackOverrides: overrides })
    const sourceSubtitles = tracks.find((t) => t.id === "source-subtitles")
    expect(sourceSubtitles?.contentFileId).toBe("pinned-file")
    for (const track of tracks) {
      if (track.id !== "source-subtitles") {
        expect(track.contentFileId).toBeUndefined()
      }
    }
  })

  it("omits null, non-string, empty, and slash-containing contentFileId values", () => {
    // The field is optional and only meaningful as a non-empty string without
    // slashes (a file identity). Anything else must be dropped so the
    // renderer never sees a malformed value.
    const overrides = {
      "trk-null": { kind: "source-subtitles", contentFileId: null },
      "trk-number": { kind: "source-subtitles", contentFileId: 42 },
      "trk-empty": { kind: "source-subtitles", contentFileId: "" },
      "trk-slash": { kind: "source-subtitles", contentFileId: "a/b" },
    }
    const tracks = deriveTracksForFile({ trackOverrides: overrides as unknown as PersistedTrackOverrides })
    for (const track of tracks) {
      if (track.id.startsWith("trk-")) {
        expect(track.contentFileId).toBeUndefined()
      }
    }
  })
})
