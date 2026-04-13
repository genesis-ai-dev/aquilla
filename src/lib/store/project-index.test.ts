import { describe, it, expect, beforeEach } from "vitest"
import {
  listProjects,
  getProject,
  createProject,
  updateProject,
  deleteProject,
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
