// AQU-646: the project-wide timing lock. Mirrors assignment-authority.test.ts's
// makeDb stub pattern — with the DEFAULT FLIPPED, which is the point of most of
// these: that one defaults to "no carve-out" so a missing setting preserves the
// old behaviour, this one defaults to LOCKED because a guard against accidents
// that has to be switched on protects nothing until somebody switches it on.
import { describe, it, expect } from "vitest"
import { isLockedTimingEvent, isUserInsertedCell, resolveTimingLocked } from "../events/timing-authority"

function makeDb(options: {
  settings?: string | null
  metadata?: unknown
}): AquillaDb {
  const { settings = null, metadata = null } = options
  return {
    prepare(sql: string) {
      return {
        bind(..._args: unknown[]) {
          return {
            async first() {
              if (sql.includes("FROM project_settings")) {
                return settings != null ? { settings } : null
              }
              if (sql.includes("FROM cells")) {
                return metadata != null ? { metadata } : null
              }
              return null
            },
            async all() { return { results: [] } },
          }
        },
      }
    },
  } as unknown as AquillaDb
}

describe("resolveTimingLocked", () => {
  it("locks a project that has never had settings", async () => {
    expect(await resolveTimingLocked(makeDb({ settings: null }), "p1")).toBe(true)
  })

  it("locks when the key is absent — every project that exists today", async () => {
    const db = makeDb({ settings: JSON.stringify({ audioTimingMode: "dubbing" }) })
    expect(await resolveTimingLocked(db, "p1")).toBe(true)
  })

  it("unlocks ONLY on an explicit false", async () => {
    const db = makeDb({ settings: JSON.stringify({ timingLocked: false }) })
    expect(await resolveTimingLocked(db, "p1")).toBe(false)
  })

  it("locks on a truthy-but-not-false value, including the string 'false'", async () => {
    // A stale client or a hand-edited blob must not be able to unlock by
    // accident — only the boolean counts.
    for (const value of [true, "false", 0, null]) {
      const db = makeDb({ settings: JSON.stringify({ timingLocked: value }) })
      expect(await resolveTimingLocked(db, "p1")).toBe(true)
    }
  })

  it("locks when the blob will not parse", async () => {
    expect(await resolveTimingLocked(makeDb({ settings: "{not json" }), "p1")).toBe(true)
  })
})

describe("isUserInsertedCell", () => {
  it("recognises a line someone added here", async () => {
    const db = makeDb({ metadata: { aquillaOrigin: { version: 1, kind: "user-insert" } } })
    expect(await isUserInsertedCell(db, "p1", "f1", "c1")).toBe(true)
  })

  it("reads the marker whether the driver hands back jsonb or text", async () => {
    const db = makeDb({ metadata: JSON.stringify({ aquillaOrigin: { kind: "user-insert" } }) })
    expect(await isUserInsertedCell(db, "p1", "f1", "c1")).toBe(true)
  })

  it("does NOT exempt an imported row that merely has other metadata", async () => {
    // The whole reason the marker is explicit: inferring "a person made it"
    // from an absent import envelope would exempt every legacy file.
    const db = makeDb({ metadata: { cast_name: "JESUS", line_number: "310" } })
    expect(await isUserInsertedCell(db, "p1", "f1", "c1")).toBe(false)
  })

  it("does not exempt a cell it cannot find or parse", async () => {
    expect(await isUserInsertedCell(makeDb({ metadata: null }), "p1", "f1", "c1")).toBe(false)
    expect(await isUserInsertedCell(makeDb({ metadata: "{not json" }), "p1", "f1", "c1")).toBe(false)
  })
})

describe("isLockedTimingEvent", () => {
  it("always covers a line's own span", () => {
    expect(isLockedTimingEvent("cell.retime", { startMs: 1, endMs: 2 })).toBe(true)
  })

  it("covers a lane retime that moves a SUBTITLE", () => {
    expect(isLockedTimingEvent("cell.lane.retime", { subtitleStartMs: 1, subtitleEndMs: 2 })).toBe(true)
    expect(isLockedTimingEvent("cell.lane.retime", { subtitleStartMs: null })).toBe(true)
  })

  it("does NOT cover a lane retime that only moves a dub take", () => {
    // The catch that shaped this function: `cell.lane.retime` carries two
    // unrelated things, and where a recordist puts their own take is ordinary
    // contributor work. Locking it would stop people placing their recordings
    // — the opposite of protecting the client's file.
    expect(isLockedTimingEvent("cell.lane.retime", { targetOffsetMs: 250 })).toBe(false)
    expect(isLockedTimingEvent("cell.lane.retime", { targetStartMs: 900 })).toBe(false)
  })

  it("covers an event that touches a subtitle key even alongside a target key", () => {
    expect(isLockedTimingEvent("cell.lane.retime", { subtitleStartMs: 1, targetOffsetMs: 2 })).toBe(true)
  })

  it("leaves the pairings alone — Sam scoped the lock to chip timings", () => {
    expect(isLockedTimingEvent("cell.link.set", {})).toBe(false)
    expect(isLockedTimingEvent("cell.audio.trim", {})).toBe(false)
  })
})
