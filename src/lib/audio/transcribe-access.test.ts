import { describe, expect, it } from "vitest"
import { ROLE } from "@/lib/frontier/roles"
import { transcribeBlock } from "./transcribe-access"

const credits = (daily: number, weekly: number, enforce = true) => ({
  config: { enforce, markup: 4, agentMarkup: 4, dailyCap: 100, weeklyCap: 500, agentDailyCap: 0, agentWeeklyCap: 0, showToOrg: true },
  remaining: { daily, weekly, agentDaily: 0, agentWeekly: 0 },
})

describe("transcribeBlock (AQU-2426: both rules, whichever is stricter, and the org can pay)", () => {
  it("lets a project lead with credits left transcribe", () => {
    expect(transcribeBlock({ level: ROLE.PROJECT_LEAD, onDevice: false, credits: credits(10, 50) })).toBeNull()
  })

  it("a Contributor clears the hosted floor but not the import rule", () => {
    expect(transcribeBlock({ level: ROLE.CONTRIBUTOR, onDevice: false })).toEqual({ kind: "import", floor: ROLE.PROJECT_LEAD })
  })

  it("names the org's raised import floor", () => {
    expect(transcribeBlock({ level: ROLE.PROJECT_LEAD, importMinRole: ROLE.MAINTAINER, onDevice: false }))
      .toEqual({ kind: "import", floor: ROLE.MAINTAINER })
  })

  it("stops at today's or this week's enforced limit, but not on this device", () => {
    expect(transcribeBlock({ level: ROLE.OWNER, onDevice: false, credits: credits(0, 50) })).toEqual({ kind: "creditsToday" })
    expect(transcribeBlock({ level: ROLE.OWNER, onDevice: false, credits: credits(5, 0) })).toEqual({ kind: "creditsWeek" })
    expect(transcribeBlock({ level: ROLE.OWNER, onDevice: true, credits: credits(0, 0) })).toBeNull()
    expect(transcribeBlock({ level: ROLE.OWNER, onDevice: false, credits: credits(0, 0, false) })).toBeNull()
  })

  it("fails open when the role is unknown (a local project)", () => {
    expect(transcribeBlock({ level: null, onDevice: false })).toBeNull()
    expect(transcribeBlock({ level: null, onDevice: false, timingLocked: true })).toBeNull()
  })

  // AQU-2426 (review, Nov 9): transcribing a recording ends in a split, and a
  // split retimes the line, which a locked project keeps for Maintainers.
  it("a Project lead can't transcribe while timing is locked; a Maintainer can", () => {
    expect(transcribeBlock({ level: ROLE.PROJECT_LEAD, onDevice: false, timingLocked: true }))
      .toEqual({ kind: "timingLocked", floor: ROLE.MAINTAINER })
    expect(transcribeBlock({ level: ROLE.PROJECT_LEAD, onDevice: true, timingLocked: true }))
      .toEqual({ kind: "timingLocked", floor: ROLE.MAINTAINER })
    expect(transcribeBlock({ level: ROLE.MAINTAINER, onDevice: false, timingLocked: true })).toBeNull()
    expect(transcribeBlock({ level: ROLE.PROJECT_LEAD, onDevice: false, timingLocked: false })).toBeNull()
  })

  it("names the import rule first when both stop someone", () => {
    expect(transcribeBlock({ level: ROLE.CONTRIBUTOR, onDevice: false, timingLocked: true }))
      .toEqual({ kind: "import", floor: ROLE.PROJECT_LEAD })
  })
})
