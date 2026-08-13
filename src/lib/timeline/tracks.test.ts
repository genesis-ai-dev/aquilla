// WHY these tests exist: this merge IS the seam between what a client persists
// and what every client draws, and it is the one place where an OLD build meets
// a NEWER build's data. Two promises are pinned hardest here — that an
// unrecognised track is merely invisible and never touched (the input map is
// compared byte-for-byte afterwards), and that the output has a TOTAL order, so
// the reorder UI stages 2–3 will bring cannot make equal `order` values jitter
// between renders. The malformed-input cases exist because these values arrive
// from remote JSON via jsonb: the function has to be total, not merely correct.

import { describe, expect, it } from "vitest"
import {
  DEFAULT_TRACK_IDS,
  TRACK_KIND_LABELS,
  deriveDefaultTracks,
  deriveTracksForFile,
  mergeTrackOverrides,
  type PersistedTrackOverrides,
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

const DEFAULT_SHAPE = [
  ["subtitles", "subtitles", "Subtitles", 0, null],
  ["source-audio", "source-audio", "Source audio", 1, null],
  ["target-audio", "target-audio", "Target audio", 2, null],
]

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

  it("DEFAULT_TRACK_IDS names exactly those three ids", () => {
    expect([...DEFAULT_TRACK_IDS].sort()).toEqual(["source-audio", "subtitles", "target-audio"])
  })
})

describe("mergeTrackOverrides — no overrides", () => {
  it("returns the defaults verbatim for null, undefined and an empty map", () => {
    expect(shape(merge(null))).toEqual(DEFAULT_SHAPE)
    expect(shape(merge(undefined))).toEqual(DEFAULT_SHAPE)
    expect(shape(merge({}))).toEqual(DEFAULT_SHAPE)
  })

  it("an empty patch object is a no-op", () => {
    expect(shape(merge({ subtitles: {}, "target-audio": {} }))).toEqual(DEFAULT_SHAPE)
  })
})

describe("mergeTrackOverrides — patching a default", () => {
  it("renames it", () => {
    const tracks = merge({ subtitles: { name: "Dialogue text" } })
    expect(tracks[0].name).toBe("Dialogue text")
    expect(tracks[0].kind).toBe("subtitles") // identity untouched by a rename
    expect(shape(tracks).map((t) => t[0])).toEqual(["subtitles", "source-audio", "target-audio"])
  })

  it("reorders it, and the output is re-sorted", () => {
    const tracks = merge({ subtitles: { order: 9 } })
    expect(shape(tracks).map((t) => t[0])).toEqual(["source-audio", "target-audio", "subtitles"])
    expect(tracks[2].order).toBe(9)
  })

  it("groups it", () => {
    const tracks = merge({ "target-audio": { groupId: "spanish" } })
    expect(tracks[2].groupId).toBe("spanish")
    expect(tracks[0].groupId).toBeNull()
  })

  it("ignores a kind written against a default id — the row's identity is derived", () => {
    const tracks = merge({ subtitles: { kind: "target-audio", name: "Still subtitles" } })
    expect(tracks[0].kind).toBe("subtitles")
    expect(tracks[0].name).toBe("Still subtitles")
    expect(tracks).toHaveLength(3)
  })

  it("ignores a blank or whitespace-only name rather than drawing an empty label", () => {
    expect(merge({ subtitles: { name: "" } })[0].name).toBe("Subtitles")
    expect(merge({ subtitles: { name: "   " } })[0].name).toBe("Subtitles")
    expect(merge({ subtitles: { name: "\n\t" } })[0].name).toBe("Subtitles")
  })

  it("applies a name verbatim — what is shown has to be what is stored", () => {
    expect(merge({ subtitles: { name: " Dialogue " } })[0].name).toBe(" Dialogue ")
  })

  it("ignores a non-finite or non-numeric order", () => {
    expect(merge({ subtitles: { order: Number.NaN } })[0].order).toBe(0)
    expect(merge({ subtitles: { order: Number.POSITIVE_INFINITY } })[0].order).toBe(0)
    expect(merge({ subtitles: { order: "3" } } as any)[0].order).toBe(0)
  })

  it("ignores a blank groupId", () => {
    expect(merge({ subtitles: { groupId: "" } })[0].groupId).toBeNull()
    expect(merge({ subtitles: { groupId: "  " } })[0].groupId).toBeNull()
  })

  it("accepts negative and fractional orders and sorts by them", () => {
    const tracks = merge({ "target-audio": { order: -1 }, "source-audio": { order: 0.5 } })
    expect(shape(tracks).map((t) => [t[0], t[3]])).toEqual([
      ["target-audio", -1],
      ["subtitles", 0],
      ["source-audio", 0.5],
    ])
  })

  it("cannot delete a default: nothing an override can say removes a row", () => {
    // Deletion is expressed by REMOVING the entry (server-side `patch: null`),
    // which returns the row to its pure default. There is no delete here.
    const tracks = merge({ subtitles: { name: "", order: Number.NaN, groupId: "" } })
    expect(shape(tracks)).toEqual(DEFAULT_SHAPE)
  })
})

describe("mergeTrackOverrides — user-added tracks", () => {
  it("builds one, defaulting its name from the kind and its order below the defaults", () => {
    const tracks = merge({ "trk-a": { kind: "target-audio" } })
    expect(shape(tracks)[3]).toEqual(["trk-a", "target-audio", TRACK_KIND_LABELS["target-audio"], 3, null])
  })

  it("keeps an explicit name, order and groupId", () => {
    const tracks = merge({ "trk-a": { kind: "target-audio", name: "Spanish", order: 1.5, groupId: "es" } })
    expect(shape(tracks)).toEqual([
      ["subtitles", "subtitles", "Subtitles", 0, null],
      ["source-audio", "source-audio", "Source audio", 1, null],
      ["trk-a", "target-audio", "Spanish", 1.5, "es"],
      ["target-audio", "target-audio", "Target audio", 2, null],
    ])
  })

  it("stacks unordered new tracks after the defaults in id order", () => {
    const tracks = merge({ "trk-b": { kind: "target-audio" }, "trk-a": { kind: "target-audio" } })
    expect(shape(tracks).map((t) => [t[0], t[3]]).slice(3)).toEqual([
      ["trk-a", 3],
      ["trk-b", 4],
    ])
  })

  it("stacks them below a REORDERED default, not below where the defaults started", () => {
    const tracks = merge({ subtitles: { order: 40 }, "trk-a": { kind: "subtitles" } })
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
    // A caller handed a shortened defaults list must not get a fake "subtitles"
    // row built out of a delta.
    const tracks = mergeTrackOverrides(
      [{ id: "source-audio", kind: "source-audio", name: "Source audio", order: 0, groupId: null }],
      { subtitles: { kind: "subtitles", name: "Impostor" } },
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
    expect(shape(tracks).map((t) => t[0])).toEqual(["subtitles", "source-audio", "target-audio", "trk-es"])
    expect(overrides).toEqual(snapshot)
    expect(Object.keys(overrides)).toEqual(["trk-chars", "trk-es"])
  })

  it("an unknown kind does not consume a fallback order slot", () => {
    const tracks = merge({ "trk-a": { kind: "characters" }, "trk-b": { kind: "target-audio" } })
    expect(tracks[3]).toMatchObject({ id: "trk-b", order: 3 })
  })
})

describe("mergeTrackOverrides — total order", () => {
  it("breaks a tie between defaults by their derived sequence, not by id", () => {
    // "source-audio" < "subtitles" by code point, so an id-first tie-break would
    // flip the two rows on screen for no reason the user asked for.
    const tracks = merge({ subtitles: { order: 1 } })
    expect(shape(tracks).map((t) => t[0])).toEqual(["subtitles", "source-audio", "target-audio"])
  })

  it("puts a default before a user track on the same order", () => {
    const tracks = merge({ "aaa-track": { kind: "subtitles", order: 0 } })
    expect(shape(tracks).map((t) => t[0])).toEqual(["subtitles", "aaa-track", "source-audio", "target-audio"])
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
      subtitles: { order: 1 },
    }
    const first = shape(merge(overrides))
    expect(shape(merge(overrides))).toEqual(first)
    expect(first.map((t) => t[0])).toEqual(["subtitles", "source-audio", "trk-a", "trk-b", "target-audio"])
  })
})

describe("mergeTrackOverrides — totality on malformed input", () => {
  it("survives entries that are not objects", () => {
    const tracks = merge({ a: null, b: "nope", c: 7, d: [], subtitles: { name: "Kept" } } as any)
    expect(shape(tracks).map((t) => t[0])).toEqual(["subtitles", "source-audio", "target-audio"])
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
    const tracks = mergeTrackOverrides(defaults, { subtitles: { name: "Renamed", order: 99 } })
    expect(defaults).toEqual(snapshot)
    expect(tracks[2]).not.toBe(defaults[0])
    tracks.push({ id: "later", kind: "subtitles", name: "Later", order: 100, groupId: null })
    expect(defaults).toHaveLength(3)
  })

  it("leaves the overrides map alone", () => {
    const overrides: PersistedTrackOverrides = {
      subtitles: { name: "Renamed" },
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
})
