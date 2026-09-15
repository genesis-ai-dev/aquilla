// Perf (2026-09): per-request memo for the `projects` row + resolveProjectRole.
// A route that consults the role several times (or mints a sync token, which
// used to read the projects row twice) must hit Postgres once per request —
// and the memo must NOT leak across requests, or a membership change would
// be invisible to the next call.
import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import { createRequestMemo, memoize } from "../lib/request-memo"
import {
  forgetProjectRole,
  loadProjectRow,
  resolveProjectRole,
} from "../services/project-permissions"
import { mintSyncTokenForUser } from "../services/sync-token-mint"
import type { AuthUser, Env } from "../types"
import { seedUser } from "./helpers/db"

const user: AuthUser = {
  id: 1,
  username: "memo-user",
  email: "memo-user@example.com",
  password_hash: "",
  preferences: {},
  created_at: "",
  updated_at: "",
  password_changed_at: null,
}

function countingEnv(withMemo: boolean): { reqEnv: Env; sql: string[] } {
  const sql: string[] = []
  const real = env.AQUILLA_PG
  const db = {
    prepare: (text: string) => {
      sql.push(text)
      return real.prepare(text)
    },
  } as unknown as typeof env.AQUILLA_PG
  const reqEnv = { ...env, AQUILLA_PG: db, requestMemo: withMemo ? createRequestMemo() : undefined }
  return { reqEnv: reqEnv as unknown as Env, sql }
}

async function seedProject(): Promise<void> {
  await seedUser(1, "memo-user")
  await seedUser(2, "memo-owner")
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by) VALUES ('p1', 'P', 2)").run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_members (project_id, user_id, role_level) VALUES ('p1', 1, 400)",
  ).run()
}

const projectReads = (sql: string[]): number => sql.filter((s) => s.includes("FROM projects")).length
const memberReads = (sql: string[]): number => sql.filter((s) => s.includes("FROM project_members")).length

describe("memoize", () => {
  it("runs the loader once per key and does not retain rejections", async () => {
    const memo = createRequestMemo()
    let calls = 0
    const ok = () => memoize(memo, "k", async () => ++calls)
    expect(await ok()).toBe(1)
    expect(await ok()).toBe(1)

    let fails = 0
    const bad = () =>
      memoize(memo, "bad", async () => {
        fails++
        throw new Error("boom")
      })
    await expect(bad()).rejects.toThrow("boom")
    await expect(bad()).rejects.toThrow("boom")
    expect(fails).toBe(2)
  })

  it("is a pass-through when no memo is attached", async () => {
    let calls = 0
    await memoize(undefined, "k", async () => ++calls)
    await memoize(undefined, "k", async () => ++calls)
    expect(calls).toBe(2)
  })
})

describe("resolveProjectRole per-request memo", () => {
  it("resolves the role once per (project, user) within a request", async () => {
    await seedProject()
    const { reqEnv, sql } = countingEnv(true)
    const a = await resolveProjectRole(reqEnv, user, "p1")
    const b = await resolveProjectRole(reqEnv, user, "p1")
    expect(a).toEqual({ level: 400, name: "contributor", source: "override" })
    expect(b).toBe(a)
    expect(projectReads(sql)).toBe(1)
    expect(memberReads(sql)).toBe(1)
  })

  it("a fresh request sees a membership change made after the previous one", async () => {
    await seedProject()
    const first = countingEnv(true)
    expect((await resolveProjectRole(first.reqEnv, user, "p1"))?.level).toBe(400)
    await env.AQUILLA_PG.prepare(
      "UPDATE project_members SET role_level = 100 WHERE project_id = 'p1' AND user_id = 1",
    ).run()
    // Same request: memoised (stale by design — one request, one answer).
    expect((await resolveProjectRole(first.reqEnv, user, "p1"))?.level).toBe(400)
    const second = countingEnv(true)
    expect((await resolveProjectRole(second.reqEnv, user, "p1"))?.level).toBe(100)
  })

  it("forgetProjectRole lets the same request see a grant it just removed", async () => {
    await seedProject()
    const { reqEnv, sql } = countingEnv(true)
    expect((await resolveProjectRole(reqEnv, user, "p1"))?.level).toBe(400)
    await env.AQUILLA_PG.prepare("DELETE FROM project_members WHERE project_id = 'p1' AND user_id = 1").run()
    forgetProjectRole(reqEnv, "p1", user.id)
    expect(await resolveProjectRole(reqEnv, user, "p1")).toBeNull()
    expect(memberReads(sql)).toBe(2)
  })

  it("mintSyncTokenForUser reads the projects row once and shares it with role resolution", async () => {
    await seedProject()
    const { reqEnv, sql } = countingEnv(true)
    const result = await mintSyncTokenForUser(reqEnv, user, "p1", "f1")
    expect(result.ok).toBe(true)
    expect(projectReads(sql)).toBe(1)
    expect(await loadProjectRow(reqEnv, "p1")).toMatchObject({ id: "p1", is_active: true })
    expect(projectReads(sql)).toBe(1)
  })
})
