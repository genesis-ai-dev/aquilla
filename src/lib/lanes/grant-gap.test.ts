/**
 * AQU-1783 — the inspector's verdict comes from the GRANTS, with the wall's
 * own rule, so it can never claim access the read wall denies.
 */
import { describe, it, expect } from "vitest"
import { memberLaneAccess, type MemberLaneGrant } from "./grant-gap"

const FRENCH = { id: "lane-fr", name: "French" }
const SPANISH = { id: "lane-es", name: "Spanish" }
const grant = (laneId: string, name: string, level = 400): MemberLaneGrant => ({ laneId, name, level })

describe("AQU-1783 memberLaneAccess — all lanes granted", () => {
  it("reports no gap when the grants cover every current lane", () => {
    const verdict = memberLaneAccess({
      memberRoleLevel: 400,
      grants: [grant("lane-fr", "French"), grant("lane-es", "Spanish")],
      targetLanes: [FRENCH, SPANISH],
      laneScopeCount: 0,
      readWallEnabled: true,
    })
    expect(verdict).toMatchObject({ kind: "restricted", gap: false, warn: false, coversAll: true })
    if (verdict.kind !== "restricted") throw new Error("expected restricted")
    expect(verdict.lanes.map((l) => [l.name, l.granted])).toEqual([
      ["French", true],
      ["Spanish", true],
    ])
    expect(verdict.missing).toEqual([])
  })
})

describe("AQU-1783 memberLaneAccess — the gap this issue is about", () => {
  it("flags the lane an unscoped member cannot read, and warns", () => {
    const verdict = memberLaneAccess({
      memberRoleLevel: 400,
      grants: [grant("lane-fr", "French")],
      targetLanes: [FRENCH, SPANISH],
      laneScopeCount: 0,
      readWallEnabled: true,
    })
    if (verdict.kind !== "restricted") throw new Error("expected restricted")
    expect(verdict.gap).toBe(true)
    expect(verdict.warn).toBe(true)
    expect(verdict.unscoped).toBe(true)
    expect(verdict.coversAll).toBe(false)
    expect(verdict.missing.map((l) => l.name)).toEqual(["Spanish"])
  })

  it("does not warn when the member is deliberately scoped to fewer lanes", () => {
    const verdict = memberLaneAccess({
      memberRoleLevel: 400,
      grants: [grant("lane-fr", "French")],
      targetLanes: [FRENCH, SPANISH],
      laneScopeCount: 1,
      readWallEnabled: true,
    })
    if (verdict.kind !== "restricted") throw new Error("expected restricted")
    // Still a gap — Spanish is marked "no access" — but a deliberate one.
    expect(verdict.gap).toBe(true)
    expect(verdict.warn).toBe(false)
    expect(verdict.unscoped).toBe(false)
  })

  it("reports every lane missing when no grant was ever written", () => {
    const verdict = memberLaneAccess({
      memberRoleLevel: 400,
      grants: [],
      targetLanes: [FRENCH, SPANISH],
      laneScopeCount: 0,
      readWallEnabled: true,
    })
    if (verdict.kind !== "restricted") throw new Error("expected restricted")
    expect(verdict.warn).toBe(true)
    expect(verdict.missing.map((l) => l.name)).toEqual(["French", "Spanish"])
  })
})

describe("AQU-1783 memberLaneAccess — it mirrors the wall's own rule", () => {
  it("ignores a grant below Viewer, exactly as visibleLaneTags does", () => {
    const verdict = memberLaneAccess({
      memberRoleLevel: 400,
      grants: [grant("lane-fr", "French", 50)],
      targetLanes: [FRENCH],
      laneScopeCount: 0,
      readWallEnabled: true,
    })
    if (verdict.kind !== "restricted") throw new Error("expected restricted")
    expect(verdict.lanes[0]!.granted).toBe(false)
    expect(verdict.warn).toBe(true)
  })

  it("says Maintainer and above read every lane by role, with no grant list", () => {
    expect(
      memberLaneAccess({
        memberRoleLevel: 600,
        grants: [],
        targetLanes: [FRENCH, SPANISH],
        laneScopeCount: 0,
        readWallEnabled: true,
      }),
    ).toEqual({ kind: "unrestricted", reason: "role" })
  })

  it("claims nothing where the wall is off — grants gate nothing there", () => {
    expect(
      memberLaneAccess({
        memberRoleLevel: 400,
        grants: [],
        targetLanes: [FRENCH, SPANISH],
        laneScopeCount: 0,
        readWallEnabled: false,
      }),
    ).toEqual({ kind: "unrestricted", reason: "wall-off" })
  })
})
