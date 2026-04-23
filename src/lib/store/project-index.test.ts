import { describe, it, expect, beforeEach, vi, afterEach } from "vitest"
import {
  listProjects,
  listTrashedProjects,
  getProject,
  createProject,
  updateProject,
  deleteProject,
  tombstoneProject,
  restoreProject,
  storeOriginalFile,
  getOriginalFile,
  _resetDbForTesting,
} from "./project-index"
import type { ProjectRecord } from "../parsers/types"

function makeProject(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: "test-" + Math.random().toString(36).slice(2),
    name: "Test Project",
    sourceLanguage: "en",
    targetLanguage: "fr",
    createdAt: new Date().toISOString(),
    files: [],
    members: [],
    ...overrides,
  }
}

beforeEach(async () => {
  await _resetDbForTesting()
  const dbs = await indexedDB.databases()
  for (const db of dbs) {
    if (db.name) indexedDB.deleteDatabase(db.name)
  }
})

describe("project-index", () => {
  it("creates and retrieves a project", async () => {
    const project = makeProject({ id: "p1", name: "My Project" })
    await createProject(project)
    const fetched = await getProject("p1")
    expect(fetched).toBeDefined()
    expect(fetched!.name).toBe("My Project")
  })

  it("lists all projects", async () => {
    await createProject(makeProject({ id: "p1" }))
    await createProject(makeProject({ id: "p2" }))
    const all = await listProjects()
    expect(all).toHaveLength(2)
  })

  it("updates a project", async () => {
    const project = makeProject({ id: "p1", name: "Original" })
    await createProject(project)
    await updateProject({ ...project, name: "Updated" })
    const fetched = await getProject("p1")
    expect(fetched!.name).toBe("Updated")
  })

  it("deletes a project", async () => {
    const project = makeProject({ id: "p1" })
    await createProject(project)
    await deleteProject("p1")
    const fetched = await getProject("p1")
    expect(fetched).toBeUndefined()
  })

  it("returns undefined for missing project", async () => {
    const fetched = await getProject("nonexistent")
    expect(fetched).toBeUndefined()
  })

  it("stores and retrieves original file buffer", async () => {
    const buffer = new ArrayBuffer(8)
    new Uint8Array(buffer).set([1, 2, 3, 4, 5, 6, 7, 8])
    await storeOriginalFile("file1", buffer)
    const retrieved = await getOriginalFile("file1")
    expect(retrieved).toBeDefined()
    expect(new Uint8Array(retrieved!)).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))
  })
})

describe("project-index trash", () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.useRealTimers()
  })

  it("listProjects filters trashed by default", async () => {
    await createProject(makeProject({ id: "a", name: "Active" }))
    await createProject(
      makeProject({ id: "t", name: "Trashed", deletedAt: "2026-04-23T12:00:00Z" })
    )
    const active = await listProjects()
    expect(active.map((p) => p.id).sort()).toEqual(["a"])
    const all = await listProjects({ includeTrashed: true })
    expect(all.map((p) => p.id).sort()).toEqual(["a", "t"])
  })

  it("listTrashedProjects returns only trashed", async () => {
    await createProject(makeProject({ id: "a" }))
    await createProject(
      makeProject({ id: "t", deletedAt: "2026-04-23T12:00:00Z", deletedBy: "alice" })
    )
    const trashed = await listTrashedProjects()
    expect(trashed).toHaveLength(1)
    expect(trashed[0].id).toBe("t")
    expect(trashed[0].deletedBy).toBe("alice")
  })

  it("tombstoneProject without session sets deletedAt locally", async () => {
    const project = makeProject({ id: "p1", name: "Local" })
    await createProject(project)
    const result = await tombstoneProject(project, { jwt: null, fallbackUsername: "ryder" })
    expect(result.remote.kind).toBe("skipped-no-session")
    const fetched = await getProject("p1")
    expect(fetched?.deletedAt).toBeDefined()
    expect(fetched?.deletedBy).toBe("ryder")
  })

  it("tombstoneProject with session calls server and applies returned metadata", async () => {
    const project = makeProject({ id: "p2", name: "Synced" })
    await createProject(project)
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            archivedAt: "2026-04-23T15:30:00Z",
            archivedBy: { id: 1, username: "alice" },
          }),
          { status: 200 }
        )
    ) as typeof fetch
    const result = await tombstoneProject(project, { jwt: "fake-jwt" })
    expect(result.remote.kind).toBe("archived")
    const fetched = await getProject("p2")
    expect(fetched?.deletedAt).toBe("2026-04-23T15:30:00Z")
    expect(fetched?.deletedBy).toBe("alice")
  })

  it("tombstoneProject falls through to local when server returns 404", async () => {
    const project = makeProject({ id: "p3" })
    await createProject(project)
    globalThis.fetch = vi.fn(
      async () => new Response("not found", { status: 404 })
    ) as typeof fetch
    const result = await tombstoneProject(project, {
      jwt: "fake-jwt",
      fallbackUsername: "ryder",
    })
    expect(result.remote.kind).toBe("local-only")
    const fetched = await getProject("p3")
    expect(fetched?.deletedAt).toBeDefined()
  })

  it("tombstoneProject leaves local state unchanged on 403", async () => {
    const project = makeProject({ id: "p4" })
    await createProject(project)
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "only owners" }), { status: 403 })
    ) as typeof fetch
    const result = await tombstoneProject(project, { jwt: "fake-jwt" })
    expect(result.remote.kind).toBe("forbidden")
    const fetched = await getProject("p4")
    expect(fetched?.deletedAt).toBeUndefined()
  })

  it("restoreProject clears local deletedAt and deletedBy", async () => {
    const project = makeProject({
      id: "p5",
      deletedAt: "2026-04-23T12:00:00Z",
      deletedBy: "alice",
    })
    await createProject(project)
    const result = await restoreProject(project, { jwt: null })
    expect(result.remote.kind).toBe("skipped-no-session")
    const fetched = await getProject("p5")
    expect(fetched?.deletedAt).toBeUndefined()
    expect(fetched?.deletedBy).toBeUndefined()
  })

  it("restoreProject keeps tombstone if server returns 403", async () => {
    const project = makeProject({
      id: "p6",
      deletedAt: "2026-04-23T12:00:00Z",
      deletedBy: "alice",
    })
    await createProject(project)
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "only owners" }), { status: 403 })
    ) as typeof fetch
    const result = await restoreProject(project, { jwt: "fake-jwt" })
    expect(result.remote.kind).toBe("forbidden")
    const fetched = await getProject("p6")
    expect(fetched?.deletedAt).toBe("2026-04-23T12:00:00Z")
  })
})
