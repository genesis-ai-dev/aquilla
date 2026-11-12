import { describe, expect, it } from "vitest"
import { captionTrackDestinations } from "./caption-destinations"

describe("captionTrackDestinations (AQU-1566)", () => {
  type Track = { id: string; name: string; contentFileId?: string }
  const derived: Track = { id: "source-subtitles", name: "Source text" }
  const derivedTarget: Track = { id: "target-subtitles", name: "Target text" }
  const added: Track = { id: "t1", name: "Episode captions", contentFileId: "c1" }
  const pointed: Track = { id: "source-subtitles", name: "Source text", contentFileId: "c2" }

  it("stops offering the file's own text rows once the file has rows", () => {
    expect(captionTrackDestinations([derived, derivedTarget, added], true)).toEqual([added])
  })

  it("keeps a derived row that already points at caption content", () => {
    expect(captionTrackDestinations([pointed, derivedTarget], true)).toEqual([pointed])
  })

  it("leaves the list alone on a file with no rows", () => {
    expect(captionTrackDestinations([derived, added], false)).toEqual([derived, added])
  })
})
