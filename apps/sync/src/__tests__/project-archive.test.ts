import { describe, it, expect } from "vitest"
import {
  handleProjectArchiveRequest,
  type ArchiveMarker,
} from "../project-archive"

function makeEnv(secret = "shared-secret") {
  return {
    SYNC_SECRET_KEY: secret,
    ProjectSync: {} as DurableObjectNamespace,
  } as any
}

describe("POST /admin/projects/:projectId/archive", () => {
  it("requires a matching Authorization header", async () => {
    const env = makeEnv("k")
    const res = await handleProjectArchiveRequest(
      new Request("https://worker/admin/projects/p1/archive", {
        method: "POST",
        headers: { Authorization: "Bearer wrong" },
        body: JSON.stringify({ archivedAt: "2026-04-23T12:00:00Z", deletedBy: "alice" }),
      }),
      env,
      async () => {}
    ) as Response
    expect(res.status).toBe(401)
  })

  it("rejects non-POST methods", async () => {
    const env = makeEnv("k")
    const res = await handleProjectArchiveRequest(
      new Request("https://worker/admin/projects/p1/archive", {
        method: "GET",
        headers: { Authorization: "Bearer k" },
      }),
      env,
      async () => {}
    ) as Response
    expect(res.status).toBe(405)
  })

  it("returns null for non-matching paths so the caller can fall through", async () => {
    const env = makeEnv("k")
    const res = await handleProjectArchiveRequest(
      new Request("https://worker/admin/files/p/f", {
        method: "POST",
        headers: { Authorization: "Bearer k" },
      }),
      env,
      async () => {}
    )
    expect(res).toBeNull()
  })

  it("broadcasts the archive marker once to ProjectSync", async () => {
    const env = makeEnv("k")
    const broadcasts: Array<{ projectId: string; marker: ArchiveMarker }> = []

    const res = await handleProjectArchiveRequest(
      new Request("https://worker/admin/projects/proj-1/archive", {
        method: "POST",
        headers: { Authorization: "Bearer k" },
        body: JSON.stringify({ archivedAt: "2026-04-23T12:00:00Z", deletedBy: "alice" }),
      }),
      env,
      async (_env, projectId, marker) => {
        broadcasts.push({ projectId, marker })
      }
    ) as Response

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true })
    expect(broadcasts).toEqual([
      {
        projectId: "proj-1",
        marker: { archivedAt: "2026-04-23T12:00:00Z", deletedBy: "alice" },
      },
    ])
  })

  it("broadcasts unarchive with a null archivedAt", async () => {
    const env = makeEnv("k")
    const broadcasts: ArchiveMarker[] = []

    const res = await handleProjectArchiveRequest(
      new Request("https://worker/admin/projects/proj-1/archive", {
        method: "POST",
        headers: { Authorization: "Bearer k" },
        body: JSON.stringify({ archivedAt: null, deletedBy: null }),
      }),
      env,
      async (_env, _projectId, marker) => {
        broadcasts.push(marker)
      }
    ) as Response

    expect(res.status).toBe(200)
    expect(broadcasts).toEqual([{ archivedAt: null, deletedBy: null }])
  })

  it("decodes URL-encoded projectId", async () => {
    const env = makeEnv("k")
    const broadcasts: string[] = []

    const res = await handleProjectArchiveRequest(
      new Request("https://worker/admin/projects/proj%201/archive", {
        method: "POST",
        headers: { Authorization: "Bearer k" },
        body: JSON.stringify({ archivedAt: "2026-04-23T12:00:00Z", deletedBy: "a" }),
      }),
      env,
      async (_env, projectId) => {
        broadcasts.push(projectId)
      }
    ) as Response
    expect(res.status).toBe(200)
    expect(broadcasts).toEqual(["proj 1"])
  })
})
