import { describe, it, expect } from "vitest"
import {
  handleProjectArchiveRequest,
  type ArchiveMarker,
  type ProjectArchiveEnv,
} from "../project-archive"

// The sync-worker keeps no R2 archive marker and no per-file archive state
// (durable archive state lives on identity's project rows). This handler just
// authenticates the admin call and fans a single project-scoped notification
// out to the live ProjectSync DO via the injected broadcaster.

function makeEnv(secret = "shared-secret"): ProjectArchiveEnv {
  return {
    SYNC_SECRET_KEY: secret,
    ProjectSync: {} as unknown as DurableObjectNamespace,
  }
}

describe("POST /admin/projects/:projectId/archive", () => {
  it("requires a matching Authorization header", async () => {
    const env = makeEnv("k")
    const res = (await handleProjectArchiveRequest(
      new Request("https://worker/admin/projects/p1/archive", {
        method: "POST",
        headers: { Authorization: "Bearer wrong" },
        body: JSON.stringify({ archivedAt: "2026-04-23T12:00:00Z", deletedBy: "alice" }),
      }),
      env,
      async () => {},
    )) as Response
    expect(res.status).toBe(401)
  })

  it("rejects non-POST methods", async () => {
    const env = makeEnv("k")
    const res = (await handleProjectArchiveRequest(
      new Request("https://worker/admin/projects/p1/archive", {
        method: "GET",
        headers: { Authorization: "Bearer k" },
      }),
      env,
      async () => {},
    )) as Response
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
      async () => {},
    )
    expect(res).toBeNull()
  })

  it("broadcasts the marker once for the project and returns ok", async () => {
    const env = makeEnv("k")
    const broadcasts: Array<{ projectId: string; marker: ArchiveMarker }> = []

    const res = (await handleProjectArchiveRequest(
      new Request("https://worker/admin/projects/proj-1/archive", {
        method: "POST",
        headers: { Authorization: "Bearer k" },
        body: JSON.stringify({ archivedAt: "2026-04-23T12:00:00Z", deletedBy: "alice" }),
      }),
      env,
      async (_env, projectId, marker) => {
        broadcasts.push({ projectId, marker })
      },
    )) as Response

    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean }
    expect(body.ok).toBe(true)
    expect(broadcasts).toHaveLength(1)
    expect(broadcasts[0].projectId).toBe("proj-1")
    expect(broadcasts[0].marker.archivedAt).toBe("2026-04-23T12:00:00Z")
    expect(broadcasts[0].marker.deletedBy).toBe("alice")
  })

  it("broadcasts an unarchive (null marker) and still returns ok", async () => {
    const env = makeEnv("k")
    const markers: ArchiveMarker[] = []

    const res = (await handleProjectArchiveRequest(
      new Request("https://worker/admin/projects/proj-1/archive", {
        method: "POST",
        headers: { Authorization: "Bearer k" },
        body: JSON.stringify({ archivedAt: null, deletedBy: null }),
      }),
      env,
      async (_env, _projectId, marker) => {
        markers.push(marker)
      },
    )) as Response

    expect(res.status).toBe(200)
    expect(markers).toHaveLength(1)
    expect(markers[0].archivedAt).toBeNull()
    expect(markers[0].deletedBy).toBeNull()
  })

  it("a failing broadcast is swallowed — the admin call still succeeds", async () => {
    const env = makeEnv("k")
    const res = (await handleProjectArchiveRequest(
      new Request("https://worker/admin/projects/proj-1/archive", {
        method: "POST",
        headers: { Authorization: "Bearer k" },
        body: JSON.stringify({ archivedAt: "2026-04-23T12:00:00Z", deletedBy: "a" }),
      }),
      env,
      async () => {
        throw new Error("DO unreachable")
      },
    )) as Response
    expect(res.status).toBe(200)
  })

  it("decodes URL-encoded projectId", async () => {
    const env = makeEnv("k")
    const broadcasts: string[] = []

    const res = (await handleProjectArchiveRequest(
      new Request("https://worker/admin/projects/proj%201/archive", {
        method: "POST",
        headers: { Authorization: "Bearer k" },
        body: JSON.stringify({ archivedAt: "2026-04-23T12:00:00Z", deletedBy: "a" }),
      }),
      env,
      async (_env, projectId) => {
        broadcasts.push(projectId)
      },
    )) as Response
    expect(res.status).toBe(200)
    expect(broadcasts).toEqual(["proj 1"])
  })
})
