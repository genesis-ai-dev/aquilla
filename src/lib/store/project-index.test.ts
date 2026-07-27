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
  mergeServerProjectWithLocalCache,
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

  it("tombstoneProject leaves local state unchanged on 403 when project has an origin", async () => {
    // A cloud-synced project (has origin) getting 403 means the caller lacks
    // permission — don't apply the local tombstone.
    const project = makeProject({
      id: "p4",
      origin: {
        kind: "git",
        cloneUrl: "https://gitlab.example.com/org/repo.git",
        gitlabProjectId: 42,
        branch: "main",
        headSha: "abc123",
        importedAt: new Date().toISOString(),
      },
    })
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

  it("tombstoneProject reclassifies 403 as local-only for orphan IDB rows", async () => {
    // A local-only-shaped project (no origin, no syncRole) that gets a 403
    // means the server has no row for this id — reclassify and tombstone locally.
    const project = makeProject({ id: "p4b" })
    await createProject(project)
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "not found or no role" }), { status: 403 })
    ) as typeof fetch
    const result = await tombstoneProject(project, { jwt: "fake-jwt" })
    expect(result.remote.kind).toBe("local-only")
    const fetched = await getProject("p4b")
    expect(fetched?.deletedAt).toBeDefined()
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

describe("mergeServerProjectWithLocalCache — client-local overlays", () => {
  // AQU-695: the server never persists the setup-checklist dismissal; it lives
  // only in the local IDB record. The merge must carry it through so a project
  // dismissed on a prior visit still reads dismissed after a reload/navigation.
  it("carries setupChecklistDismissed from the local cache onto the server record", () => {
    const server = makeProject({ id: "p1", setupChecklistDismissed: undefined })
    const local = makeProject({ id: "p1", setupChecklistDismissed: true })
    const merged = mergeServerProjectWithLocalCache(server, local)
    expect(merged.setupChecklistDismissed).toBe(true)
  })

  it("does not fabricate a dismissal when the local cache has none (negative case)", () => {
    const server = makeProject({ id: "p1" })
    const local = makeProject({ id: "p1" })
    const merged = mergeServerProjectWithLocalCache(server, local)
    expect(merged.setupChecklistDismissed).toBeUndefined()
  })

  it("leaves the server record untouched when there is no local cache", () => {
    const server = makeProject({ id: "p1" })
    const merged = mergeServerProjectWithLocalCache(server, undefined)
    expect(merged.setupChecklistDismissed).toBeUndefined()
  })

  it("carries the local dismissal alongside the existing suggestionsDismissedAt overlay", () => {
    const server = makeProject({ id: "p1" })
    const local = makeProject({
      id: "p1",
      setupChecklistDismissed: true,
      suggestionsDismissedAt: "2026-07-24T00:00:00Z",
    })
    const merged = mergeServerProjectWithLocalCache(server, local)
    expect(merged.setupChecklistDismissed).toBe(true)
    expect(merged.suggestionsDismissedAt).toBe("2026-07-24T00:00:00Z")
  })

  it("AQU-701: carries the local aiSetupSkipped flag onto the server record", () => {
    const server = makeProject({ id: "s1" })
    const local = { ...server, aiSetupSkipped: true }
    expect(mergeServerProjectWithLocalCache(server, local).aiSetupSkipped).toBe(true)
  })

  it("AQU-701: carries an explicit false (Set up anyway) so the step re-arms", () => {
    const server = makeProject({ id: "s2" })
    const local = { ...server, aiSetupSkipped: false }
    expect(mergeServerProjectWithLocalCache(server, local).aiSetupSkipped).toBe(false)
  })

  it("leaves aiSetupSkipped unset when the local cache has no opinion", () => {
    const server = makeProject({ id: "s3" })
    expect(mergeServerProjectWithLocalCache(server, { ...server }).aiSetupSkipped).toBeUndefined()
    expect(mergeServerProjectWithLocalCache(server, undefined).aiSetupSkipped).toBeUndefined()
  })

  it("AQU-701: keeps device-local ttsSettings (provider + gemini key) across refetches", () => {
    const server = makeProject({ id: "s4" })
    const local = {
      ...server,
      ttsSettings: { provider: "gemini" as const, apiKey: "AIzaLocalKey1234567890123" },
    }
    const merged = mergeServerProjectWithLocalCache(server, local)
    expect(merged.ttsSettings?.provider).toBe("gemini")
    expect(merged.ttsSettings?.apiKey).toBe("AIzaLocalKey1234567890123")
  })

  it("AQU-701: server-synced ttsSettings keys win, device-only apiKey still survives", () => {
    const server = makeProject({ id: "s5", ttsSettings: { provider: "kokoro" as const } })
    const local = {
      ...server,
      ttsSettings: { provider: "gemini" as const, apiKey: "AIzaLocalKey1234567890123" },
    }
    const merged = mergeServerProjectWithLocalCache(server, local)
    expect(merged.ttsSettings?.provider).toBe("kokoro")
    expect(merged.ttsSettings?.apiKey).toBe("AIzaLocalKey1234567890123")
  })
})
