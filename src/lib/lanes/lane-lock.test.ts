import { describe, expect, it } from "vitest"
import {
  acknowledgeLaneArchive,
  laneArchiveToAnnounce,
  laneArchiveWatchInit,
  laneLockFor,
  laneWriteLocked,
  observeLaneArchive,
  type LaneArchiveWatch,
} from "./lane-lock"
import { archiveCheckApplies, archivedLaneReason } from "./archived-lane"

describe("laneLockFor", () => {
  it("locks the active lane when it is archived", () => {
    expect(
      laneLockFor({ activeLane: "es", archivedLanes: ["es"], label: "Spanish" }),
    ).toEqual({ tag: "es", label: "Spanish" })
  })

  it("leaves an active lane alone", () => {
    expect(
      laneLockFor({ activeLane: "es", archivedLanes: ["fr"], label: "Spanish" }),
    ).toBeNull()
  })

  it("does not lock on an absent or empty archived list", () => {
    expect(laneLockFor({ activeLane: "es", archivedLanes: undefined, label: "Spanish" })).toBeNull()
    expect(laneLockFor({ activeLane: "es", archivedLanes: [], label: "Spanish" })).toBeNull()
  })

  it("matches the archived tag case-insensitively, like the server", () => {
    expect(
      laneLockFor({ activeLane: "es", archivedLanes: ["ES"], label: "Spanish" }),
    ).toEqual({ tag: "es", label: "Spanish" })
  })

  it("locks the former default lane, which AQU-1600 makes archivable", () => {
    expect(
      laneLockFor({ activeLane: "", archivedLanes: [""], label: "French" }),
    ).toEqual({ tag: "", label: "French" })
  })

  it("does not lock the default lane off a list that only names other tags", () => {
    // The legacy `settings.archivedLanes` blob is a list of non-empty tags and
    // can never name the '' lane — the same rule archived-lane.ts follows.
    expect(laneLockFor({ activeLane: "", archivedLanes: ["es"], label: "French" })).toBeNull()
  })
})

describe("laneWriteLocked mirrors the server's archived-lane kind table", () => {
  const lock = { tag: "es", label: "Spanish" }

  it("locks the kinds that always address one target lane", () => {
    for (const kind of [
      "target.cell.create",
      "target.cell.commit",
      "target.cell.delete",
      "target.cell.reorder",
      "target.cell.repin",
      "cell.validate",
      "cell.unvalidate",
    ]) {
      expect(laneWriteLocked(kind, lock), kind).toBe(true)
    }
  })

  it("locks the kinds that name a lane when the locked lane is a named one", () => {
    for (const kind of [
      "cell.waive",
      "cell.unwaive",
      "cell.audio.attach",
      "cell.audio.select",
      "cell.audio.remove",
      "cell.audio.trim",
      "cell.audio.place",
      "cell.audio.validate",
      "cell.lane.retime",
      "cell.backtranslation.set",
    ]) {
      expect(laneWriteLocked(kind, lock), kind).toBe(true)
    }
  })

  it("leaves comments and other shared writes available", () => {
    // Comments are shared across lanes (AQU-1463), so a frozen lane keeps them.
    for (const kind of ["comment.create", "comment.resolve", "file.create", "source.cell.commit"]) {
      expect(laneWriteLocked(kind, lock), kind).toBe(false)
    }
  })

  it("treats a named-lane kind on the default lane as the shared write the server does", () => {
    // archived-lane.ts freezes these only when the event carries a NON-EMPTY
    // targetLang; on the '' lane the write is shared and still applies.
    const defaultLock = { tag: "", label: "French" }
    expect(laneWriteLocked("cell.waive", defaultLock)).toBe(false)
    expect(laneWriteLocked("cell.audio.attach", defaultLock)).toBe(false)
    // A kind that ALWAYS addresses a lane is still frozen on the '' lane.
    expect(laneWriteLocked("target.cell.commit", defaultLock)).toBe(true)
  })

  it("offers everything when no lane is locked", () => {
    expect(laneWriteLocked("target.cell.commit", null)).toBe(false)
  })

  it("covers every kind the server runs the archived check for", () => {
    // Producer/consumer composition: anything archiveCheckApplies() says the
    // authorizer checks must be a kind this client refuses to offer for a
    // NAMED locked lane. A kind added to archived-lane.ts and forgotten here
    // would otherwise leave a live button the server rejects.
    const kinds = [
      "target.cell.create", "target.cell.commit", "target.cell.delete",
      "target.cell.reorder", "target.cell.repin", "cell.validate", "cell.unvalidate",
      "cell.waive", "cell.unwaive", "cell.audio.attach", "cell.audio.select",
      "cell.audio.remove", "cell.audio.rename", "cell.audio.trim", "cell.audio.place",
      "cell.audio.measure", "cell.audio.validate", "cell.audio.unvalidate",
      "cell.lane.retime", "cell.backtranslation.set",
    ]
    for (const kind of kinds) {
      expect(archiveCheckApplies(kind), kind).toBe(true)
      expect(laneWriteLocked(kind, lock), kind).toBe(true)
    }
  })

  it("locks exactly when the server would refuse the same lane", () => {
    // Run the real refusal path over the lane row the client's list is derived
    // from, so the two halves of AQU-1462/AQU-1463 agree about one lane.
    const lanes = [{ id: "lane-es", name: "Spanish", legacyTag: "es", archivedAt: "2026-09-29T00:00:00Z" }]
    expect(archivedLaneReason({ tag: "es", lanes, archivedTags: [] })).toBe("lane 'Spanish' is archived")
    expect(laneWriteLocked("target.cell.commit", laneLockFor({
      activeLane: "es",
      archivedLanes: lanes.filter((l) => l.archivedAt).map((l) => l.legacyTag ?? ""),
      label: "Spanish",
    }))).toBe(true)
  })
})

describe("LaneArchiveWatch — who gets the must-dismiss modal", () => {
  const esLock = { tag: "es", label: "Spanish" }

  function watching(lane: string): LaneArchiveWatch {
    return observeLaneArchive(laneArchiveWatchInit(), { activeLane: lane, locked: false })
  }

  it("announces an archive of the lane the member was working in", () => {
    const watch = watching("es")
    expect(laneArchiveToAnnounce(watch, esLock)).toEqual(esLock)
  })

  it("says nothing on a cold open of an already-archived lane", () => {
    // Reload, deep link, or "show archived": the lane was never seen active.
    const watch = observeLaneArchive(laneArchiveWatchInit(), { activeLane: "es", locked: true })
    expect(laneArchiveToAnnounce(watch, esLock)).toBeNull()
  })

  it("says nothing once the member has acknowledged it", () => {
    const watch = acknowledgeLaneArchive(watching("es"), "es")
    expect(laneArchiveToAnnounce(watch, esLock)).toBeNull()
  })

  it("stays quiet when the member switches away and back", () => {
    let watch = acknowledgeLaneArchive(watching("es"), "es")
    // Away to an active lane, then back to the frozen one.
    watch = observeLaneArchive(watch, { activeLane: "", locked: false })
    watch = observeLaneArchive(watch, { activeLane: "es", locked: true })
    expect(laneArchiveToAnnounce(watch, esLock)).toBeNull()
  })

  it("says nothing about a lane the member is not looking at", () => {
    // Working in the default lane when Spanish is archived.
    const watch = watching("")
    expect(laneArchiveToAnnounce(watch, null)).toBeNull()
  })

  it("announces a second archive after a restore", () => {
    let watch = acknowledgeLaneArchive(watching("es"), "es")
    // The PM restores the lane: the member sees it active again, which rearms.
    watch = observeLaneArchive(watch, { activeLane: "es", locked: false })
    expect(laneArchiveToAnnounce(watch, esLock)).toEqual(esLock)
  })

  it("tracks the default lane under its own empty tag", () => {
    const watch = watching("")
    expect(laneArchiveToAnnounce(watch, { tag: "", label: "French" })).toEqual({
      tag: "",
      label: "French",
    })
  })

  it("is identity-stable so a settings frame does not re-render the workspace", () => {
    const watch = watching("es")
    expect(observeLaneArchive(watch, { activeLane: "es", locked: false })).toBe(watch)
    expect(observeLaneArchive(watch, { activeLane: "es", locked: true })).toBe(watch)
    const acknowledged = acknowledgeLaneArchive(watch, "es")
    expect(acknowledgeLaneArchive(acknowledged, "es")).toBe(acknowledged)
  })
})
