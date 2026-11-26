import { describe, expect, it } from "vitest"
import { laneGrantLevelsFromSyncToken } from "./lane-grant-levels"

function token(payload: unknown): string {
  const body = btoa(JSON.stringify(payload)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
  return `header.${body}.sig`
}

describe("laneGrantLevelsFromSyncToken", () => {
  it("reads grant levels and treats a missing or broken claim as none", () => {
    expect(laneGrantLevelsFromSyncToken(token({ laneGrants: [{ lane: "es", level: 500 }, { lane: "fr", level: 400 }] }))).toEqual([500, 400])
    expect(laneGrantLevelsFromSyncToken(token({ role: 100 }))).toEqual([])
    expect(laneGrantLevelsFromSyncToken("not-a-token")).toEqual([])
    expect(laneGrantLevelsFromSyncToken(token({ laneGrants: [{ lane: "es" }, null, { level: "500" }] }))).toEqual([])
  })
})
