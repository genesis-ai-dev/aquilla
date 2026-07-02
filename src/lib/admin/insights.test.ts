import { describe, it, expect } from "vitest"
import {
  validatedFraction,
  deadlineState,
  isStalled,
  attentionReasons,
  projectsNeedingAttention,
  mostActiveOrgs,
  recentSignupCount,
  newestUsers,
} from "./insights"
import type { AdminProject, AdminOrg, AdminUser } from "@/lib/frontier/admin"

const NOW = Date.parse("2026-07-01T00:00:00Z")
const DAY = 24 * 60 * 60 * 1000

function project(over: Partial<AdminProject> = {}): AdminProject {
  return {
    id: "p1",
    name: "Project",
    orgId: 1,
    orgName: "Org",
    archived: false,
    createdAt: "2026-01-01",
    deadlineAt: null,
    creatorUsername: "alice",
    totalCells: 100,
    validatedCells: 50,
    wordCount: 1000,
    lastEditAt: NOW,
    ...over,
  }
}

describe("validatedFraction", () => {
  it("is 0 for an empty project and a ratio otherwise", () => {
    expect(validatedFraction({ totalCells: 0, validatedCells: 0 })).toBe(0)
    expect(validatedFraction({ totalCells: 200, validatedCells: 50 })).toBe(0.25)
  })
})

describe("deadlineState", () => {
  it("returns null without a deadline", () => {
    expect(deadlineState({ deadlineAt: null }, NOW)).toBeNull()
    expect(deadlineState({ deadlineAt: "not-a-date" }, NOW)).toBeNull()
  })
  it("flags a past deadline overdue (with AoE grace) and today as not-overdue", () => {
    expect(deadlineState({ deadlineAt: "2026-06-01" }, NOW)).toBe("overdue")
    // Due today: within the 36h AoE grace, so not yet overdue.
    expect(deadlineState({ deadlineAt: "2026-07-01" }, NOW)).not.toBe("overdue")
  })
  it("flags a near deadline soon and a distant one ok", () => {
    expect(deadlineState({ deadlineAt: "2026-07-05" }, NOW)).toBe("soon")
    expect(deadlineState({ deadlineAt: "2026-09-01" }, NOW)).toBe("ok")
  })
})

describe("isStalled", () => {
  it("is false for an unstarted (no-cell) project", () => {
    expect(isStalled({ totalCells: 0, lastEditAt: null }, NOW)).toBe(false)
  })
  it("is true when content exists but was never or long-ago edited", () => {
    expect(isStalled({ totalCells: 10, lastEditAt: null }, NOW)).toBe(true)
    expect(isStalled({ totalCells: 10, lastEditAt: NOW - 20 * DAY }, NOW)).toBe(true)
    expect(isStalled({ totalCells: 10, lastEditAt: NOW - 2 * DAY }, NOW)).toBe(false)
  })
})

describe("attentionReasons", () => {
  it("is empty for a healthy, recently-edited project", () => {
    expect(attentionReasons(project(), NOW)).toEqual([])
  })
  it("never flags archived projects", () => {
    expect(attentionReasons(project({ archived: true, deadlineAt: "2026-01-01" }), NOW)).toEqual([])
  })
  it("lists overdue before stalled", () => {
    const reasons = attentionReasons(project({ deadlineAt: "2026-05-01", lastEditAt: NOW - 30 * DAY }), NOW)
    expect(reasons.map((r) => r.kind)).toEqual(["overdue", "stalled"])
  })
})

describe("projectsNeedingAttention", () => {
  it("keeps only at-risk active projects, ranked overdue → stalled, respecting the limit", () => {
    const healthy = project({ id: "ok" })
    const stalled = project({ id: "stalled", lastEditAt: NOW - 30 * DAY })
    const overdue = project({ id: "overdue", deadlineAt: "2026-05-01" })
    const archivedOverdue = project({ id: "arch", archived: true, deadlineAt: "2026-05-01" })
    const ranked = projectsNeedingAttention([healthy, stalled, overdue, archivedOverdue], NOW)
    expect(ranked.map((r) => r.project.id)).toEqual(["overdue", "stalled"])
    expect(projectsNeedingAttention([healthy, stalled, overdue], NOW, 1).map((r) => r.project.id)).toEqual([
      "overdue",
    ])
  })
})

describe("mostActiveOrgs", () => {
  it("ranks by project count, breaking ties on members", () => {
    const orgs: AdminOrg[] = [
      { id: 1, name: "a", createdAt: "2026-01-01", ownerUsername: null, memberCount: 2, projectCount: 1 },
      { id: 2, name: "b", createdAt: "2026-01-01", ownerUsername: null, memberCount: 9, projectCount: 5 },
      { id: 3, name: "c", createdAt: "2026-01-01", ownerUsername: null, memberCount: 3, projectCount: 5 },
    ]
    expect(mostActiveOrgs(orgs, 2).map((o) => o.id)).toEqual([2, 3])
  })
})

describe("recentSignupCount & newestUsers", () => {
  const users: AdminUser[] = [
    { id: 1, username: "old", email: "o@x", displayName: null, createdAt: "2026-01-01", orgCount: 1, lastActiveAt: null },
    { id: 2, username: "new", email: "n@x", displayName: null, createdAt: "2026-06-28", orgCount: 1, lastActiveAt: null },
    { id: 3, username: "newest", email: "z@x", displayName: null, createdAt: "2026-06-30", orgCount: 1, lastActiveAt: null },
  ]
  it("counts signups inside the window", () => {
    expect(recentSignupCount(users, NOW, 7)).toBe(2)
    expect(recentSignupCount(users, NOW, 365)).toBe(3)
  })
  it("orders newest first", () => {
    expect(newestUsers(users, 2).map((u) => u.id)).toEqual([3, 2])
  })
})
