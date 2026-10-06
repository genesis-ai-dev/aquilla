// AQU-1699 — the gate and the lane count the Bible data checks read.
//
// WHY: check pack B runs on the project's decisions and terminology, not only
// on its Language profile, so a project whose profile is empty but whose
// decisions name people must still get its name checks. And the termbase does
// not say which lane a rendering is for, so the checks must count lanes the way
// the lane switcher does: the primary language in the registry is the default
// lane, not a second one (AQU-1473).

import { describe, expect, it } from "vitest"
import { bibleChecksGate, bibleChecksGateFor, isMultiLaneProject, type BibleChecksProject } from "./check-context"
import { NO_READINESS } from "../../../db/shared/bible-checks/participant-types"

const scripture = [{ type: "usfm" as const }]
const ON: BibleChecksProject = { bibleResourcesEnabled: true, files: scripture }
const renderPeter = { id: "f1", key: "render.person.Peter", value: "Peter", scope: {}, author: "dev", at: "2026-10-06T00:00:00.000Z" }

describe("the gate", () => {
  it("opens for a decided name even while the Language profile is empty", () => {
    expect(bibleChecksGateFor(true, {}, NO_READINESS).state).toBe("dormant")
    expect(bibleChecksGateFor(true, {}, { ...NO_READINESS, agreedNames: true }).state).toBe("on")
    expect(bibleChecksGate(ON).state).toBe("dormant")
    expect(bibleChecksGate({ ...ON, projectFacts: [renderPeter] }).state).toBe("on")
  })

  it("stays shut while the checks enrichment is off, whatever is decided", () => {
    expect(bibleChecksGate({ ...ON, bibleEnrichments: { checks: false }, projectFacts: [renderPeter] })).toEqual({ state: "off" })
  })
})

describe("isMultiLaneProject", () => {
  it("reads the lane rows when the settings have them", () => {
    const row = (id: string, archivedAt: string | null = null) => ({
      id,
      role: "target" as const,
      name: id,
      langCode: id,
      legacyTag: id,
      position: 0,
      archivedAt,
    })
    expect(isMultiLaneProject({ ...ON, lanes: [row("en")] })).toBe(false)
    expect(isMultiLaneProject({ ...ON, lanes: [row("en"), row("fr")] })).toBe(true)
    expect(isMultiLaneProject({ ...ON, lanes: [row("en"), row("fr", "2026-10-01")] })).toBe(false)
  })

  it("does not count the primary language the registry lists, nor an archived lane", () => {
    expect(isMultiLaneProject({ ...ON, targetLanguage: "French", targetLanes: ["fra"] })).toBe(false)
    expect(isMultiLaneProject({ ...ON, targetLanguage: "fr", targetLanes: ["fr", "fr-CA"] })).toBe(true)
    expect(isMultiLaneProject({ ...ON, targetLanguage: "fr", targetLanes: ["fr", "es"], archivedLanes: ["es"] })).toBe(false)
  })
})
