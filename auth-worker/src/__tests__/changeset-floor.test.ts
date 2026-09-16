// Approval floor arithmetic (AQU-CMDREG-P1 §2.1) — lib/changeset-floor.ts.
//
// The route tests cover the gate end-to-end; this covers the floor itself,
// including the two command kinds whose floors are computed from their
// CONTENTS (EmitEvents per inner event kind, PatchSettings per settings key)
// and the fail-closed path for a plan that cannot be read.
//
// This is also the producer→consumer guard for the cross-package import: the
// numbers come from sync-worker's requiredRoleForCommand, so if role-policy
// moves a floor, these expectations move with it rather than drifting.
import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import {
  planCreatesTenant,
  requiredRoleForChangeset,
  UNREADABLE_PLAN_FLOOR,
} from "../lib/changeset-floor"
import type { Env } from "../types"

const testEnv = env as unknown as Env

async function seedProject(orgId: number | null): Promise<string> {
  await env.AQUILLA_PG.prepare(
    "INSERT INTO users (id, username, email, password_hash, preferences) VALUES (1, 'alice', 'alice@example.com', 'x', '{}')",
  ).run()
  if (orgId !== null) {
    await env.AQUILLA_PG.prepare(
      "INSERT INTO organizations (id, name, owner_user_id) VALUES (?, 'TestOrg', 1)",
    )
      .bind(orgId)
      .run()
  }
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES ('proj-1', 'Blackfoot', ?, 1)",
  )
    .bind(orgId)
    .run()
  return "proj-1"
}

async function setOrgSettings(orgId: number, settings: Record<string, unknown>): Promise<void> {
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_settings (org_id, settings, version, updated_by) VALUES (?, ?, 0, 1)",
  )
    .bind(orgId, JSON.stringify(settings))
    .run()
}

const floor = (projectId: string, commands: unknown) =>
  requiredRoleForChangeset(testEnv, projectId, commands)

describe("requiredRoleForChangeset", () => {
  it("reads the CONTRIBUTOR floor of a translation plan", async () => {
    const p = await seedProject(null)
    expect(
      await floor(p, [{ kind: "SetTranslation", fileId: "f1", cellId: "c1", value: "x" }]),
    ).toBe(400)
  })

  it("takes the max across a mixed plan", async () => {
    const p = await seedProject(null)
    expect(
      await floor(p, [
        { kind: "SetTranslation", fileId: "f1", cellId: "c1", value: "x" },
        { kind: "PlanImport", fileName: "g.usfm", fileType: "usfm", cells: [] },
      ]),
    ).toBe(500)
  })

  it("accepts the JSONB as a JSON string as well as a value", async () => {
    const p = await seedProject(null)
    const plan = [{ kind: "PlanImport", fileName: "g.usfm", fileType: "usfm", cells: [] }]
    expect(await floor(p, JSON.stringify(plan))).toBe(500)
  })

  it("derives an EmitEvents floor from its inner event kinds", async () => {
    const p = await seedProject(null)
    // comment.create 200 < cell.validate 300 < assignment.create 500.
    expect(await floor(p, [{ kind: "EmitEvents", events: [{ kind: "comment.create" }] }])).toBe(200)
    expect(
      await floor(p, [
        { kind: "EmitEvents", events: [{ kind: "comment.create" }, { kind: "cell.validate" }] },
      ]),
    ).toBe(300)
    expect(
      await floor(p, [
        { kind: "EmitEvents", events: [{ kind: "comment.create" }, { kind: "assignment.create" }] },
      ]),
    ).toBe(500)
  })

  it("uses the org assignment floor for assignment EmitEvents", async () => {
    const p = await seedProject(7)
    await setOrgSettings(7, { assignmentMinRole: 300 })
    expect(
      await floor(p, [
        { kind: "EmitEvents", events: [{ kind: "assignment.create" }] },
      ]),
    ).toBe(300)
  })

  it("keeps higher non-assignment floors in a mixed EmitEvents plan", async () => {
    const p = await seedProject(7)
    await setOrgSettings(7, { assignmentMinRole: 300 })
    expect(
      await floor(p, [
        {
          kind: "EmitEvents",
          events: [{ kind: "assignment.create" }, { kind: "file.delete" }],
        },
      ]),
    ).toBe(500)
  })

  it("uses MAINTAINER for a non-terminology settings patch", async () => {
    const p = await seedProject(null)
    expect(
      await floor(p, [
        { kind: "PatchSettings", projectId: "proj-1", ifMatchVersion: 1, ops: [{ key: "targetLanes", value: [] }] },
      ]),
    ).toBe(600)
  })

  it("uses the PROJECT_LEAD default for a terminology-only patch", async () => {
    const p = await seedProject(null) // no org ⇒ default termbase floor 500
    expect(
      await floor(p, [
        { kind: "PatchSettings", projectId: "proj-1", ifMatchVersion: 1, ops: [{ key: "terminology", value: {} }] },
      ]),
    ).toBe(500)
  })

  it("raises the terminology floor to the org's termbaseEditMinRole", async () => {
    const p = await seedProject(7)
    await setOrgSettings(7, { termbaseEditMinRole: 700 })
    expect(
      await floor(p, [
        { kind: "PatchSettings", projectId: "proj-1", ifMatchVersion: 1, ops: [{ key: "terminology", value: {} }] },
      ]),
    ).toBe(700)
  })

  it("flags a tenant-creation plan, which keeps the creator rule", () => {
    expect(planCreatesTenant([{ kind: "CreateProject", name: "Fresh" }])).toBe(true)
    expect(planCreatesTenant(JSON.stringify([{ kind: "CreateProject", name: "Fresh" }]))).toBe(true)
    // AQU-1221: CreateOrg gets the same carve-out — it is filed under a project
    // id that never resolves, so a role floor would deny everyone.
    expect(planCreatesTenant([{ kind: "CreateOrg", name: "Partner Co" }])).toBe(true)
    expect(planCreatesTenant(JSON.stringify([{ kind: "CreateOrg", name: "Partner Co" }]))).toBe(true)
    expect(planCreatesTenant([{ kind: "SetTranslation", fileId: "f", cellId: "c", value: "x" }])).toBe(
      false,
    )
    expect(planCreatesTenant(null)).toBe(false)
    expect(planCreatesTenant("not json")).toBe(false)
  })

  it("fails closed on a plan it cannot read", async () => {
    const p = await seedProject(null)
    expect(UNREADABLE_PLAN_FLOOR).toBe(700)
    expect(await floor(p, [])).toBe(UNREADABLE_PLAN_FLOOR)
    expect(await floor(p, null)).toBe(UNREADABLE_PLAN_FLOOR)
    expect(await floor(p, "not json")).toBe(UNREADABLE_PLAN_FLOOR)
    expect(await floor(p, [{ kind: "NotACommandKind" }])).toBe(UNREADABLE_PLAN_FLOOR)
    expect(await floor(p, ["nope"])).toBe(UNREADABLE_PLAN_FLOOR)
    // Known kind, unusable body: the floor function reads these fields.
    expect(await floor(p, [{ kind: "EmitEvents" }])).toBe(UNREADABLE_PLAN_FLOOR)
    expect(await floor(p, [{ kind: "PatchSettings", ops: [{ value: 1 }] }])).toBe(
      UNREADABLE_PLAN_FLOOR,
    )
    // One unreadable command poisons an otherwise readable plan.
    expect(
      await floor(p, [
        { kind: "SetTranslation", fileId: "f1", cellId: "c1", value: "x" },
        { kind: "Nonsense" },
      ]),
    ).toBe(UNREADABLE_PLAN_FLOOR)
  })
})
