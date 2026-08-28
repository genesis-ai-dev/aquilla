import { describe, expect, it } from "vitest"

import { nextFolderName, nextTrackName } from "./track-names"

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

// ── Folders are named the same way, and just as untranslatably ─────────────
//
// A folder used to be stored under the MENU LABEL, `t("…trackAddFolder")` — so
// one made by someone working in Thai was stored as "โฟลเดอร์" and every
// collaborator read that word in their gutter, and because the label is a
// constant, every folder on a file was called the same thing. The i18n note
// beside that key already said the rule: an automatic name is DATA, not copy.
describe("nextFolderName — the same rule, its own sequence", () => {
  const named = (...names: string[]) => names.map((name) => ({ name }))

  it("calls the first one just Folder, then counts up", () => {
    expect(nextFolderName([])).toBe("Folder")
    expect(nextFolderName(named("Folder"))).toBe("Folder 1")
    expect(nextFolderName(named("Folder", "Folder 1"))).toBe("Folder 2")
  })

  it("reuses a number the moment nothing holds it, like tracks do", () => {
    expect(nextFolderName(named("Folder", "Folder 2"))).toBe("Folder 1")
    expect(nextFolderName(named("Folder 1", "Folder 2"))).toBe("Folder")
  })

  // THE TWO SEQUENCES ARE SEPARATE. "Track 1" and "Folder 1" are different
  // names and never read as one, so neither may consume the other's slot.
  it("counts only its own stem", () => {
    expect(nextFolderName(named("Track", "Track 1", "Track 2"))).toBe("Folder")
    expect(nextTrackName(named("Folder", "Folder 1"))).toBe("Track")
  })

  // …but it still scans EVERY row, because a track someone renamed to
  // "Folder 1" occupies that name in the gutter whatever kind it is.
  it("respects a row of any kind holding the name", () => {
    expect(nextFolderName(named("Folder", "Folder 1"))).toBe("Folder 2")
  })

  it("ignores near-misses and tolerates rename padding", () => {
    expect(nextFolderName(named("Folders", "Folder A", "folder", "Folder-1"))).toBe("Folder")
    expect(nextFolderName(named("Folder", "Folder 01"))).toBe("Folder 1")
    expect(nextFolderName(named("  Folder  "))).toBe("Folder 1")
  })
})
