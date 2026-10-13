import { describe, expect, it } from "vitest"
import type { ProjectLane } from "../e2e/helpers/frontier-api"
import { resolveEventLane } from "../src/lib/lanes/event-lane"
import { primaryTargetLane } from "./target-lane"

const lane = (overrides: Partial<ProjectLane>): ProjectLane => ({
  id: "lane-1", role: "target", name: "", language: "Swahili", langCode: "sw",
  legacyTag: "Swahili", archivedAt: null, ...overrides,
})

describe("primaryTargetLane", () => {
  it("names the target lane by both its tag and its id", () => {
    const lanes = [lane({ id: "src", role: "source", legacyTag: null }), lane({ id: "tgt" })]
    expect(primaryTargetLane(lanes)).toEqual({ targetLang: "Swahili", laneId: "tgt" })
  })

  it("skips archived target lanes", () => {
    const lanes = [lane({ id: "old", archivedAt: "2026-10-01T00:00:00Z" }), lane({ id: "live", legacyTag: "Kiswahili" })]
    expect(primaryTargetLane(lanes)).toEqual({ targetLang: "Kiswahili", laneId: "live" })
  })

  it("refuses a project with no target lane instead of seeding a lane-less write", () => {
    expect(() => primaryTargetLane([lane({ role: "source" })])).toThrow(/no live target lane/)
  })

  // The sync-worker resolves a payload's lane with this same resolver
  // (sync-worker/src/events/authorize.ts). The seeded fields must resolve to
  // the lane they were read from, not be refused as naming two lanes.
  it("produces a payload the server's lane resolver accepts", () => {
    const lanes = [lane({ id: "tgt" })]
    const payload = { value: "Tafsiri ya mstari wa 1.", ...primaryTargetLane(lanes) }
    expect(resolveEventLane(payload, lanes)).toEqual({ ok: true, tag: "Swahili", laneId: "tgt" })
  })
})
