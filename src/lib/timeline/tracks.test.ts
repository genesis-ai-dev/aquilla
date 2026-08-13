// WHY these tests exist: this merge IS the seam between what a client persists
// and what every client draws, and it is the one place where an OLD build meets
// a NEWER build's data. Two promises are pinned hardest here — that an
// unrecognised track is merely invisible and never touched (the input map is
// compared byte-for-byte afterwards), and that the output has a TOTAL order, so
// the reorder UI stages 2–3 will bring cannot make equal `order` values jitter
// between renders. The malformed-input cases exist because these values arrive
// from remote JSON via jsonb: the function has to be total, not merely correct.
//
// Stage 2 adds the derivation matrix, and it carries one promise of its own: a
// media file's rows and labels are exactly what they were before the kinds were
// renamed. Every dubbing project in existence is on the other side of that.

import { describe, expect, it } from "vitest"
import {
  DEFAULT_TRACK_IDS,
  TRACK_KIND_LABELS,
  deriveDefaultTracks,
  deriveTracksForFile,
  mergeTrackOverrides,
  type PersistedTrackOverrides,
  type TrackDerivationContext,
} from "./tracks"

/** Frozen inputs turn an accidental in-place patch into a thrown TypeError
 *  (modules are strict mode) rather than a test that quietly still passes. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) deepFreeze(v)
    Object.freeze(value)
  }
  return value
}

const merge = (overrides: PersistedTrackOverrides | null | undefined) =>
  mergeTrackOverrides(deepFreeze(deriveDefaultTracks()), deepFreeze(overrides))

const shape = (tracks: ReturnType<typeof mergeTrackOverrides>) =>
  tracks.map((t) => [t.id, t.kind, t.name, t.order, t.groupId ?? null])

/** The rows a media file (and a caller with no context at all) derives: the
 *  three the editor has drawn since it shipped, ids renamed in stage 2 but
 *  every visible LABEL identical — "Subtitles" and not "Source subtitles",
 *  because a name is per-track data and that row has always read that way. */
const DEFAULT_SHAPE = [
  ["source-subtitles", "source-subtitles", "Subtitles", 0, null],
  ["source-audio", "source-audio", "Source audio", 1, null],
  ["target-audio", "target-audio", "Target audio", 3, null],
]

const MEDIA: TrackDerivationContext = {
  isSubtitleImport: false,
  hasMediaCells: true,
  hasAudioCues: false,
}

const SUBTITLE_IMPORT: TrackDerivationContext = {
  isSubtitleImport: true,
  hasMediaCells: false,
  hasAudioCues: false,
}

describe("deriveDefaultTracks", () => {
  it("is the three rows the editor has always drawn, in order", () => {
    expect(shape(deriveDefaultTracks())).toEqual(DEFAULT_SHAPE)
  })

  it("hands back a fresh array every call — TimelineEditor holds one as a constant", () => {
    const a = deriveDefaultTracks()
    const b = deriveDefaultTracks()
    expect(a).not.toBe(b)
    expect(a[0]).not.toBe(b[0])
  })

  it("DEFAULT_TRACK_IDS reserves all four kinds, not just the derived rows", () => {
    // Reserved, not derived: no shape below draws all four at once, and that
    // is exactly why the set has to list them — see the resurrection case.
    expect([...DEFAULT_TRACK_IDS].sort()).toEqual([
      "source-audio",
      "source-subtitles",
      "target-audio",
      "target-subtitles",
    ])
  })
})

describe("deriveDefaultTracks — the derivation context", () => {
  it("gives a media file the stage-1 shape, labels included", () => {
    // The whole point of the context: every dubbing project that exists must
    // see nothing at all change after stage 2.
    expect(shape(deriveDefaultTracks(MEDIA))).toEqual(DEFAULT_SHAPE)
    expect(shape(deriveDefaultTracks(MEDIA))).toEqual(shape(deriveDefaultTracks()))
  })

  it("leaves a media file's rows alone even when an audio-cue sibling exists", () => {
    expect(shape(deriveDefaultTracks({ ...MEDIA, hasAudioCues: true }))).toEqual(DEFAULT_SHAPE)
  })

  it("gives a subtitle import no Source-audio row until an audio VTT is imported", () => {
    expect(shape(deriveDefaultTracks(SUBTITLE_IMPORT))).toEqual([
      ["source-subtitles", "source-subtitles", "Source subtitles", 0, null],
      ["target-subtitles", "target-subtitles", "Target subtitles", 2, null],
      ["target-audio", "target-audio", "Target audio", 3, null],
    ])
  })

  it("draws it once there are cues for it to hold", () => {
    expect(shape(deriveDefaultTracks({ ...SUBTITLE_IMPORT, hasAudioCues: true }))).toEqual([
      ["source-subtitles", "source-subtitles", "Source subtitles", 0, null],
      ["source-audio", "source-audio", "Source audio", 1, null],
      ["target-subtitles", "target-subtitles", "Target subtitles", 2, null],
      ["target-audio", "target-audio", "Target audio", 3, null],
    ])
  })

  it("keeps every other row's order identical across that row appearing", () => {
    // Orders are per-KIND and never the array index, so a persisted reorder
    // survives an audio-VTT import: `order: 2.5` has to go on meaning "between
    // Target subtitles and Target audio" whether or not Source audio is drawn.
    const before = deriveDefaultTracks(SUBTITLE_IMPORT)
    const after = new Map(
      deriveDefaultTracks({ ...SUBTITLE_IMPORT, hasAudioCues: true }).map((t) => [t.id, t.order]),
    )
    for (const track of before) expect(after.get(track.id)).toBe(track.order)
  })

  it("lets media cells win over the subtitle-import flag", () => {
    // A file cannot honestly be both; if both arrive true the caller is mid-
    // transition or holding a stale memo, and the legacy shape hides no row.
    expect(shape(deriveDefaultTracks({ isSubtitleImport: true, hasMediaCells: true, hasAudioCues: true })))
      .toEqual(DEFAULT_SHAPE)
  })

  it("does not resurrect target-subtitles on a media file that never derives it", () => {
    // The reserved-id rule from the outside: a delta naming a kind this file's
    // shape leaves out — written by a subtitle file, a newer build, or a hand-
    // edited meta — must not come back as a fake user-added row.
    const tracks = deriveTracksForFile(
      { trackOverrides: { "target-subtitles": { kind: "target-subtitles", name: "Impostor", order: 2 } } },
      MEDIA,
    )
    expect(shape(tracks)).toEqual(DEFAULT_SHAPE)
  })
})

describe("mergeTrackOverrides — no overrides", () => {
  it("returns the defaults verbatim for null, undefined and an empty map", () => {
    expect(shape(merge(null))).toEqual(DEFAULT_SHAPE)
    expect(shape(merge(undefined))).toEqual(DEFAULT_SHAPE)
    expect(shape(merge({}))).toEqual(DEFAULT_SHAPE)
  })

  it("an empty patch object is a no-op", () => {
    expect(shape(merge({ "source-subtitles": {}, "target-audio": {} }))).toEqual(DEFAULT_SHAPE)
  })
})

describe("mergeTrackOverrides — patching a default", () => {
  it("renames it", () => {
    const tracks = merge({ "source-subtitles": { name: "Dialogue text" } })
    expect(tracks[0].name).toBe("Dialogue text")
    expect(tracks[0].kind).toBe("source-subtitles") // identity untouched by a rename
    expect(shape(tracks).map((t) => t[0])).toEqual(["source-subtitles", "source-audio", "target-audio"])
  })

  it("reorders it, and the output is re-sorted", () => {
    const tracks = merge({ "source-subtitles": { order: 9 } })
    expect(shape(tracks).map((t) => t[0])).toEqual(["source-audio", "target-audio", "source-subtitles"])
    expect(tracks[2].order).toBe(9)
  })

  it("groups it", () => {
    const tracks = merge({ "target-audio": { groupId: "spanish" } })
    expect(tracks[2].groupId).toBe("spanish")
    expect(tracks[0].groupId).toBeNull()
  })

  it("ignores a kind written against a default id — the row's identity is derived", () => {
    const tracks = merge({ "source-subtitles": { kind: "target-audio", name: "Still subtitles" } })
    expect(tracks[0].kind).toBe("source-subtitles")
    expect(tracks[0].name).toBe("Still subtitles")
    expect(tracks).toHaveLength(3)
  })

  it("ignores a blank or whitespace-only name rather than drawing an empty label", () => {
    expect(merge({ "source-subtitles": { name: "" } })[0].name).toBe("Subtitles")
    expect(merge({ "source-subtitles": { name: "   " } })[0].name).toBe("Subtitles")
    expect(merge({ "source-subtitles": { name: "\n\t" } })[0].name).toBe("Subtitles")
  })

  it("applies a name verbatim — what is shown has to be what is stored", () => {
    expect(merge({ "source-subtitles": { name: " Dialogue " } })[0].name).toBe(" Dialogue ")
  })

  it("ignores a non-finite or non-numeric order", () => {
    expect(merge({ "source-subtitles": { order: Number.NaN } })[0].order).toBe(0)
    expect(merge({ "source-subtitles": { order: Number.POSITIVE_INFINITY } })[0].order).toBe(0)
    expect(merge({ "source-subtitles": { order: "3" } } as any)[0].order).toBe(0)
  })

  it("ignores a blank groupId", () => {
    expect(merge({ "source-subtitles": { groupId: "" } })[0].groupId).toBeNull()
    expect(merge({ "source-subtitles": { groupId: "  " } })[0].groupId).toBeNull()
  })

  it("accepts negative and fractional orders and sorts by them", () => {
    const tracks = merge({ "target-audio": { order: -1 }, "source-audio": { order: 0.5 } })
    expect(shape(tracks).map((t) => [t[0], t[3]])).toEqual([
      ["target-audio", -1],
      ["source-subtitles", 0],
      ["source-audio", 0.5],
    ])
  })

  it("cannot delete a default: nothing an override can say removes a row", () => {
    // Deletion is expressed by REMOVING the entry (server-side `patch: null`),
    // which returns the row to its pure default. There is no delete here.
    const tracks = merge({ "source-subtitles": { name: "", order: Number.NaN, groupId: "" } })
    expect(shape(tracks)).toEqual(DEFAULT_SHAPE)
  })
})

describe("mergeTrackOverrides — user-added tracks", () => {
  it("builds one, defaulting its name from the kind and its order below the defaults", () => {
    const tracks = merge({ "trk-a": { kind: "target-audio" } })
    expect(shape(tracks)[3]).toEqual(["trk-a", "target-audio", TRACK_KIND_LABELS["target-audio"], 4, null])
  })

  it("keeps an explicit name, order and groupId", () => {
    const tracks = merge({ "trk-a": { kind: "target-audio", name: "Spanish", order: 1.5, groupId: "es" } })
    expect(shape(tracks)).toEqual([
      ["source-subtitles", "source-subtitles", "Subtitles", 0, null],
      ["source-audio", "source-audio", "Source audio", 1, null],
      ["trk-a", "target-audio", "Spanish", 1.5, "es"],
      ["target-audio", "target-audio", "Target audio", 3, null],
    ])
  })

  it("stacks unordered new tracks after the defaults in id order", () => {
    const tracks = merge({ "trk-b": { kind: "target-audio" }, "trk-a": { kind: "target-audio" } })
    expect(shape(tracks).map((t) => [t[0], t[3]]).slice(3)).toEqual([
      ["trk-a", 4],
      ["trk-b", 5],
    ])
  })

  it("stacks them below a REORDERED default, not below where the defaults started", () => {
    const tracks = merge({ "source-subtitles": { order: 40 }, "trk-a": { kind: "source-subtitles" } })
    expect(tracks[3]).toMatchObject({ id: "trk-a", order: 41 })
  })

  it("assigns the same fallback orders whatever order the keys were written in", () => {
    // The same logical map reaches us from a locally built object and from
    // Postgres jsonb, which stores keys by length-then-bytes. Both must merge
    // identically.
    const a: PersistedTrackOverrides = { "trk-a": { kind: "target-audio" }, "trk-b": { kind: "target-audio" } }
    const b: PersistedTrackOverrides = { "trk-b": { kind: "target-audio" }, "trk-a": { kind: "target-audio" } }
    expect(shape(merge(a))).toEqual(shape(merge(b)))
  })

  it("drops an entry with no kind at all — there is nothing to draw it as", () => {
    const tracks = merge({ "trk-a": { name: "Mystery", order: 9 } })
    expect(shape(tracks)).toEqual(DEFAULT_SHAPE)
  })

  it("never resurrects a reserved default id as a user track", () => {
    // A caller handed a shortened defaults list must not get a fake "source-subtitles"
    // row built out of a delta.
    const tracks = mergeTrackOverrides(
      [{ id: "source-audio", kind: "source-audio", name: "Source audio", order: 0, groupId: null }],
      { "source-subtitles": { kind: "source-subtitles", name: "Impostor" } },
    )
    expect(shape(tracks)).toEqual([["source-audio", "source-audio", "Source audio", 0, null]])
  })
})

describe("mergeTrackOverrides — forward compatibility", () => {
  it("drops a kind this build has never heard of, and leaves the stored map untouched", () => {
    // THE invariant: a newer client's track is invisible here, never destroyed.
    // Emitters only ever write per-track deltas, so nothing this build does can
    // write this map back without the entry.
    const overrides: PersistedTrackOverrides = {
      "trk-chars": { kind: "characters", name: "Characters", order: 5, groupId: "cast" },
      "trk-es": { kind: "target-audio", name: "Spanish" },
    }
    const snapshot = JSON.parse(JSON.stringify(overrides))
    const tracks = mergeTrackOverrides(deriveDefaultTracks(), overrides)
    expect(shape(tracks).map((t) => t[0])).toEqual(["source-subtitles", "source-audio", "target-audio", "trk-es"])
    expect(overrides).toEqual(snapshot)
    expect(Object.keys(overrides)).toEqual(["trk-chars", "trk-es"])
  })

  it("an unknown kind does not consume a fallback order slot", () => {
    const tracks = merge({ "trk-a": { kind: "characters" }, "trk-b": { kind: "target-audio" } })
    expect(tracks[3]).toMatchObject({ id: "trk-b", order: 4 })
  })
})

describe("mergeTrackOverrides — total order", () => {
  it("breaks a tie between defaults by their derived sequence, not by id", () => {
    // "source-audio" < "source-subtitles" by code point, so an id-first tie-break would
    // flip the two rows on screen for no reason the user asked for.
    const tracks = merge({ "source-subtitles": { order: 1 } })
    expect(shape(tracks).map((t) => t[0])).toEqual(["source-subtitles", "source-audio", "target-audio"])
  })

  it("puts a default before a user track on the same order", () => {
    const tracks = merge({ "aaa-track": { kind: "source-subtitles", order: 0 } })
    expect(shape(tracks).map((t) => t[0])).toEqual(["source-subtitles", "aaa-track", "source-audio", "target-audio"])
  })

  it("breaks a tie between user tracks by id ascending", () => {
    const tracks = merge({
      "trk-z": { kind: "target-audio", order: 7 },
      "trk-a": { kind: "target-audio", order: 7 },
    })
    expect(shape(tracks).map((t) => t[0]).slice(3)).toEqual(["trk-a", "trk-z"])
  })

  it("is stable across repeated merges of the same data", () => {
    const overrides: PersistedTrackOverrides = {
      "trk-a": { kind: "target-audio", order: 1 },
      "trk-b": { kind: "target-audio", order: 1 },
      "source-subtitles": { order: 1 },
    }
    const first = shape(merge(overrides))
    expect(shape(merge(overrides))).toEqual(first)
    expect(first.map((t) => t[0])).toEqual(["source-subtitles", "source-audio", "trk-a", "trk-b", "target-audio"])
  })
})

describe("mergeTrackOverrides — totality on malformed input", () => {
  it("survives entries that are not objects", () => {
    const tracks = merge({ a: null, b: "nope", c: 7, d: [], "source-subtitles": { name: "Kept" } } as any)
    expect(shape(tracks).map((t) => t[0])).toEqual(["source-subtitles", "source-audio", "target-audio"])
    expect(tracks[0].name).toBe("Kept")
  })

  it("survives an overrides value that is not a map at all", () => {
    expect(shape(merge([] as any))).toEqual(DEFAULT_SHAPE)
    expect(shape(merge("nope" as any))).toEqual(DEFAULT_SHAPE)
    expect(shape(merge(7 as any))).toEqual(DEFAULT_SHAPE)
  })

  it("does not treat inherited keys as a known kind", () => {
    expect(shape(merge({ "trk-a": { kind: "constructor" } } as any))).toEqual(DEFAULT_SHAPE)
    expect(shape(merge({ "trk-b": { kind: "toString" } } as any))).toEqual(DEFAULT_SHAPE)
  })
})

describe("mergeTrackOverrides — never mutates its inputs", () => {
  it("leaves the defaults array and its members alone", () => {
    const defaults = deriveDefaultTracks()
    const snapshot = JSON.parse(JSON.stringify(defaults))
    const tracks = mergeTrackOverrides(defaults, { "source-subtitles": { name: "Renamed", order: 99 } })
    expect(defaults).toEqual(snapshot)
    expect(tracks[2]).not.toBe(defaults[0])
    tracks.push({ id: "later", kind: "source-subtitles", name: "Later", order: 100, groupId: null })
    expect(defaults).toHaveLength(3)
  })

  it("leaves the overrides map alone", () => {
    const overrides: PersistedTrackOverrides = {
      "source-subtitles": { name: "Renamed" },
      "trk-a": { kind: "target-audio" },
    }
    const snapshot = JSON.parse(JSON.stringify(overrides))
    mergeTrackOverrides(deriveDefaultTracks(), overrides)
    expect(overrides).toEqual(snapshot)
  })
})

describe("deriveTracksForFile", () => {
  it("gives a fileless caller the three defaults", () => {
    expect(shape(deriveTracksForFile(null))).toEqual(DEFAULT_SHAPE)
    expect(shape(deriveTracksForFile(undefined))).toEqual(DEFAULT_SHAPE)
    expect(shape(deriveTracksForFile())).toEqual(DEFAULT_SHAPE)
  })

  it("gives a file with no overrides the three defaults", () => {
    expect(shape(deriveTracksForFile({}))).toEqual(DEFAULT_SHAPE)
    expect(shape(deriveTracksForFile({ trackOverrides: null }))).toEqual(DEFAULT_SHAPE)
    expect(shape(deriveTracksForFile({ trackOverrides: {} }))).toEqual(DEFAULT_SHAPE)
  })

  it("runs the file's own overrides through the merge", () => {
    const tracks = deriveTracksForFile({ trackOverrides: { "source-audio": { name: "Production sound" } } })
    expect(tracks[1].name).toBe("Production sound")
  })

  it("threads the context through, so the overrides land on the file's own rows", () => {
    const tracks = deriveTracksForFile(
      { trackOverrides: { "target-subtitles": { name: "Armenian" } } },
      SUBTITLE_IMPORT,
    )
    expect(shape(tracks)).toEqual([
      ["source-subtitles", "source-subtitles", "Source subtitles", 0, null],
      ["target-subtitles", "target-subtitles", "Armenian", 2, null],
      ["target-audio", "target-audio", "Target audio", 3, null],
    ])
  })
})
