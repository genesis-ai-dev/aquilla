// WHY: every nightly content pass re-POSTed the full org/team plan to
// /migrate/groups — ~3.7K no-op group_members upserts against prod Neon even
// when nothing in GitLab changed. The plan hash lets an unchanged plan skip the
// upsert while a real change (a new member) still lands.

import { describe, it, expect, vi } from "vitest"
import { syncGroupsToNeon, hashGroupPlan } from "./group-sync"
import type { GroupImportPlan } from "./groups"

const state = { members: [{ id: 1, username: "alice", access_level: 50 }] }

vi.mock("./gitlab/api", () => ({
  listTopLevelGroups: async () => [{ id: 10, name: "Top", full_path: "top" }],
  listDescendantGroups: async () => [{ id: 11, name: "Sub", full_path: "top/sub" }],
  listGroupMembers: async () => state.members,
  listAllUsers: async () => [{ id: 1, username: "alice", email: "alice@example.com" }, { id: 2, username: "bob", email: "bob@example.com" }],
}))

const creds = { gitlabToken: "t", gitlabUrl: "https://git.example.com", accessToken: "" }

function harness() {
  const posts: string[] = []
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    if (u.endsWith("/migrate/users")) {
      return new Response(JSON.stringify({ users: [{ id: 101, username: "alice", email: "alice@example.com" }, { id: 102, username: "bob", email: "bob@example.com" }] }))
    }
    if (u.endsWith("/migrate/groups") && init?.method === "POST") {
      posts.push(String(init.body))
      return new Response(JSON.stringify({ orgIdByUuid: { x: 1 }, teamIdByUuid: {} }))
    }
    throw new Error(`unexpected ${u}`)
  }) as unknown as typeof fetch
  return { posts, http: { syncBase: "https://sync.test", headers: {}, fetchFn } }
}

describe("syncGroupsToNeon plan hash", () => {
  it("dry-run reports the hash without posting", async () => {
    const h = harness()
    const r = await syncGroupsToNeon(creds, h.http, { apply: false })
    expect(r.planHash).toMatch(/^[0-9a-f]{64}$/)
    expect(r.skipped).toBe(false)
    expect(h.posts).toHaveLength(0)
  })

  it("apply posts on first run, skips when the hash is unchanged, posts again when members change", async () => {
    const h = harness()
    const first = await syncGroupsToNeon(creds, h.http, { apply: true })
    expect(first.skipped).toBe(false)
    expect(h.posts).toHaveLength(1)
    expect(first.orgIdByUuid.get("x")).toBe(1)

    const second = await syncGroupsToNeon(creds, h.http, { apply: true, lastPlanHash: first.planHash })
    expect(second.skipped).toBe(true)
    expect(second.planHash).toBe(first.planHash)
    expect(h.posts).toHaveLength(1)
    // placement index still available for project placement even when skipped
    expect(second.placeIdx.get("top/sub")?.teamLegacyUuid).toBeTruthy()

    state.members = [...state.members, { id: 2, username: "bob", access_level: 30 }]
    const third = await syncGroupsToNeon(creds, h.http, { apply: true, lastPlanHash: first.planHash })
    expect(third.skipped).toBe(false)
    expect(third.planHash).not.toBe(first.planHash)
    expect(h.posts).toHaveLength(2)
  })

  it("force re-sends even when the hash matches", async () => {
    const h = harness()
    const first = await syncGroupsToNeon(creds, h.http, { apply: true })
    const again = await syncGroupsToNeon(creds, h.http, { apply: true, lastPlanHash: first.planHash, force: true })
    expect(again.skipped).toBe(false)
    expect(h.posts).toHaveLength(2)
  })
})

describe("hashGroupPlan", () => {
  it("is insensitive to object key order but sensitive to content", () => {
    const a = { orgs: [{ legacy_uuid: "u", name: "n", owner_user_id: 1 }], orgMembers: [], teams: [], teamMembers: [], conflicts: [] } as unknown as GroupImportPlan
    const b = { conflicts: [], teamMembers: [], teams: [], orgMembers: [], orgs: [{ owner_user_id: 1, name: "n", legacy_uuid: "u" }] } as unknown as GroupImportPlan
    expect(hashGroupPlan(a)).toBe(hashGroupPlan(b))
    const c = { ...a, orgs: [{ legacy_uuid: "u", name: "renamed", owner_user_id: 1 }] } as unknown as GroupImportPlan
    expect(hashGroupPlan(c)).not.toBe(hashGroupPlan(a))
  })
})
