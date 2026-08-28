import { describe, expect, it } from "vitest"

import { nextTrackName } from "./track-names"

const named = (...names: string[]) => names.map((name) => ({ name }))

describe("nextTrackName — file-save numbering", () => {
  it("calls the first added track just Track", () => {
    expect(nextTrackName([])).toBe("Track")
    // The derived rows are on every file and are not part of the sequence.
    expect(nextTrackName(named("Source text", "Target text", "Target audio"))).toBe("Track")
  })

  it("counts up while the names are taken", () => {
    expect(nextTrackName(named("Track"))).toBe("Track 1")
    expect(nextTrackName(named("Track", "Track 1"))).toBe("Track 2")
    expect(nextTrackName(named("Track", "Track 1", "Track 2"))).toBe("Track 3")
  })

  // THE FILE-SAVE RULE, and the reason this is not `nextTakeLabel`'s max + 1:
  // deleting a track gives its name back, the way removing a file frees its
  // filename (Sam, 2026-08-27).
  it("reuses a number the moment nothing is holding it", () => {
    expect(nextTrackName(named("Track", "Track 2"))).toBe("Track 1")
    expect(nextTrackName(named("Track 1", "Track 2"))).toBe("Track")
    expect(nextTrackName(named("Track", "Track 1", "Track 3"))).toBe("Track 2")
  })

  it("frees a number when the track holding it is renamed away", () => {
    expect(nextTrackName(named("Track", "Spanish VO"))).toBe("Track 1")
  })

  it("ignores names that are not part of the sequence", () => {
    // Near-misses, all of which are somebody's real name for a row and none of
    // which may silently claim a slot.
    expect(nextTrackName(named("Trackpad", "Track A", "track", "Track-1", "Track 1x"))).toBe("Track")
    // A non-canonical spelling does not reserve the slot it looks like, because
    // this function would never produce that name in the first place.
    expect(nextTrackName(named("Track", "Track 01"))).toBe("Track 1")
  })

  it("tolerates the padding a rename field leaves behind", () => {
    expect(nextTrackName(named("  Track  "))).toBe("Track 1")
  })

  // A folder called "Track 1" sits in the same gutter as the tracks, so it
  // holds that name for the same reason a track does.
  it("lets any row hold a name, whatever kind it is", () => {
    expect(nextTrackName(named("Track", "Track 1"))).toBe("Track 2")
  })

  it("never returns a name already in use, over a long run", () => {
    const rows: { name: string }[] = []
    for (let i = 0; i < 25; i += 1) {
      const next = nextTrackName(rows)
      expect(rows.some((r) => r.name === next), next).toBe(false)
      rows.push({ name: next })
    }
    expect(rows.at(-1)!.name).toBe("Track 24")
  })
})
