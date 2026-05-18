// AD-12 max-wins permission resolver tests. Covers each grant path on its
// own plus combinations / ties. The resolver lives at
// `apps/identity/src/services/project-permissions.ts`; the schema for the
// group tables lands in `apps/identity/migrations/0007_ad12_groups.sql`.

import { describe, it, expect } from "vitest"
import { resolveProjectRole } from "../services/project-permissions"
import { makeFakeD1, type UserRow } from "./helpers/d1-fake"
import type { AuthUser, Env } from "../types"

const ALICE: UserRow = {
  id: 42,
  username: "alice",
  email: "alice@example.com",
  password_hash: "x",
  preferences: "{}",
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
}

function asAuthUser(u: UserRow): AuthUser {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    password_hash: u.password_hash,
    preferences: {},
    created_at: u.created_at,
    updated_at: u.updated_at,
  }
}

function makeEnv(db: ReturnType<typeof makeFakeD1>): Env {
  return {
    AQUILLA_DB: db,
    SECRET_KEY: "x",
    ALGORITHM: "HS256",
    ACCESS_TOKEN_EXPIRE_MINUTES: "60",
  }
}

const NOW = new Date().toISOString()

describe("resolveProjectRole — max-wins across paths (AD-12)", () => {
  it("returns null when the user has no path to the project", async () => {
    const db = makeFakeD1({
      users: [ALICE],
      projects: [
        { id: "p1", name: "P", org_id: null, created_by: 99, archived_at: null },
      ],
    })
    const role = await resolveProjectRole(makeEnv(db), asAuthUser(ALICE), "p1")
    expect(role).toBeNull()
  })

  it("returns null for archived projects on the default path", async () => {
    const db = makeFakeD1({
      users: [ALICE],
      projects: [
        { id: "p1", name: "P", org_id: null, created_by: 42, archived_at: NOW },
      ],
    })
    const role = await resolveProjectRole(makeEnv(db), asAuthUser(ALICE), "p1")
    expect(role).toBeNull()
  })

  it("creator-only path resolves to owner (700)", async () => {
    const db = makeFakeD1({
      users: [ALICE],
      projects: [
        { id: "p1", name: "P", org_id: null, created_by: 42, archived_at: null },
      ],
    })
    const role = await resolveProjectRole(makeEnv(db), asAuthUser(ALICE), "p1")
    expect(role).toEqual({ level: 700, name: "owner", source: "creator" })
  })

  it("direct override at a HIGHER level than the creator implicit doesn't exist (creator already 700)", async () => {
    // Sanity: direct + creator combine fine; creator wins on ties via priority.
    const db = makeFakeD1({
      users: [ALICE],
      projects: [
        { id: "p1", name: "P", org_id: null, created_by: 42, archived_at: null },
      ],
      project_members: [
        { project_id: "p1", user_id: 42, role_level: 400, granted_by: null, granted_at: NOW },
      ],
    })
    const role = await resolveProjectRole(makeEnv(db), asAuthUser(ALICE), "p1")
    // Creator (700) beats direct (400) — max-wins.
    expect(role?.level).toBe(700)
    expect(role?.source).toBe("creator")
  })

  it("direct-only path", async () => {
    const db = makeFakeD1({
      users: [ALICE],
      projects: [
        { id: "p1", name: "P", org_id: null, created_by: 99, archived_at: null },
      ],
      project_members: [
        { project_id: "p1", user_id: 42, role_level: 400, granted_by: 99, granted_at: NOW },
      ],
    })
    const role = await resolveProjectRole(makeEnv(db), asAuthUser(ALICE), "p1")
    expect(role).toEqual({ level: 400, name: "contributor", source: "override" })
  })

  it("group-only path", async () => {
    const db = makeFakeD1({
      users: [ALICE],
      organizations: [{ id: 1, name: "Acme", owner_user_id: 99 }],
      projects: [
        { id: "p1", name: "P", org_id: 1, created_by: 99, archived_at: null },
      ],
      groups: [
        {
          id: 10,
          org_id: 1,
          name: "Translators",
          description: null,
          created_by: 99,
          created_at: NOW,
          updated_at: NOW,
        },
      ],
      group_members: [
        { group_id: 10, user_id: 42, added_by: 99, added_at: NOW },
      ],
      group_project_grants: [
        { group_id: 10, project_id: "p1", role_level: 400, granted_by: 99, granted_at: NOW },
      ],
    })
    const role = await resolveProjectRole(makeEnv(db), asAuthUser(ALICE), "p1")
    expect(role).toEqual({ level: 400, name: "contributor", source: "group" })
  })

  it("org-only path", async () => {
    const db = makeFakeD1({
      users: [ALICE],
      organizations: [{ id: 1, name: "Acme", owner_user_id: 99 }],
      projects: [
        { id: "p1", name: "P", org_id: 1, created_by: 99, archived_at: null },
      ],
      org_members: [
        {
          org_id: 1,
          user_id: 42,
          role_level: 300,
          granted_by: 99,
          granted_at: NOW,
          last_active_at: null,
        },
      ],
    })
    const role = await resolveProjectRole(makeEnv(db), asAuthUser(ALICE), "p1")
    expect(role).toEqual({ level: 300, name: "reviewer", source: "org" })
  })

  it("max-wins: group grant beats lower-level direct override", async () => {
    // Per AD-12: an explicit project_members row at a LOWER level does NOT
    // demote the user — the higher group grant wins.
    const db = makeFakeD1({
      users: [ALICE],
      organizations: [{ id: 1, name: "Acme", owner_user_id: 99 }],
      projects: [
        { id: "p1", name: "P", org_id: 1, created_by: 99, archived_at: null },
      ],
      project_members: [
        { project_id: "p1", user_id: 42, role_level: 100, granted_by: 99, granted_at: NOW },
      ],
      groups: [
        {
          id: 10,
          org_id: 1,
          name: "Translators",
          description: null,
          created_by: 99,
          created_at: NOW,
          updated_at: NOW,
        },
      ],
      group_members: [
        { group_id: 10, user_id: 42, added_by: 99, added_at: NOW },
      ],
      group_project_grants: [
        { group_id: 10, project_id: "p1", role_level: 400, granted_by: 99, granted_at: NOW },
      ],
    })
    const role = await resolveProjectRole(makeEnv(db), asAuthUser(ALICE), "p1")
    expect(role?.level).toBe(400)
    expect(role?.source).toBe("group")
  })

  it("max-wins: takes the MAX across multiple group memberships", async () => {
    const db = makeFakeD1({
      users: [ALICE],
      organizations: [{ id: 1, name: "Acme", owner_user_id: 99 }],
      projects: [
        { id: "p1", name: "P", org_id: 1, created_by: 99, archived_at: null },
      ],
      groups: [
        { id: 10, org_id: 1, name: "Viewers", description: null, created_by: 99, created_at: NOW, updated_at: NOW },
        { id: 11, org_id: 1, name: "Translators", description: null, created_by: 99, created_at: NOW, updated_at: NOW },
      ],
      group_members: [
        { group_id: 10, user_id: 42, added_by: 99, added_at: NOW },
        { group_id: 11, user_id: 42, added_by: 99, added_at: NOW },
      ],
      group_project_grants: [
        { group_id: 10, project_id: "p1", role_level: 100, granted_by: 99, granted_at: NOW },
        { group_id: 11, project_id: "p1", role_level: 500, granted_by: 99, granted_at: NOW },
      ],
    })
    const role = await resolveProjectRole(makeEnv(db), asAuthUser(ALICE), "p1")
    expect(role?.level).toBe(500)
    expect(role?.source).toBe("group")
  })

  it("on a tie, override is credited over group/org/creator", async () => {
    const db = makeFakeD1({
      users: [ALICE],
      organizations: [{ id: 1, name: "Acme", owner_user_id: 99 }],
      projects: [
        { id: "p1", name: "P", org_id: 1, created_by: 99, archived_at: null },
      ],
      project_members: [
        { project_id: "p1", user_id: 42, role_level: 400, granted_by: 99, granted_at: NOW },
      ],
      org_members: [
        { org_id: 1, user_id: 42, role_level: 400, granted_by: 99, granted_at: NOW, last_active_at: null },
      ],
    })
    const role = await resolveProjectRole(makeEnv(db), asAuthUser(ALICE), "p1")
    expect(role?.level).toBe(400)
    expect(role?.source).toBe("override")
  })

  it("personal project (org_id null) ignores org members entirely", async () => {
    const db = makeFakeD1({
      users: [ALICE],
      organizations: [{ id: 1, name: "Acme", owner_user_id: 99 }],
      projects: [
        // org_id null — personal project
        { id: "p1", name: "P", org_id: null, created_by: 99, archived_at: null },
      ],
      org_members: [
        // Even though Alice is an org member, the project has no org →
        // org path doesn't contribute. No other path: should be null.
        { org_id: 1, user_id: 42, role_level: 700, granted_by: 99, granted_at: NOW, last_active_at: null },
      ],
    })
    const role = await resolveProjectRole(makeEnv(db), asAuthUser(ALICE), "p1")
    expect(role).toBeNull()
  })
})
