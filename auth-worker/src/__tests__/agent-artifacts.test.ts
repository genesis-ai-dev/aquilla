// Agent artifact upload (AQU-AGENT Wave-2, integrator W2-INT). WHY: this is the
// session-JWT attach-file path the SPA composer uses. The gate that matters is
// that it lands bytes + a metadata row EXACTLY where the harness's load_artifact
// tool looks (artifacts.r2_key in the shared DB, bytes in the SNAPSHOTS bucket
// under `artifacts/{projectId}/{id}`) — otherwise an attached file silently
// can't be loaded into the sandbox. Each test pins one way that contract fails.

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"
import { ROLE } from "../types"

const PROJECT = "proj-artifact"

/** Minimal in-memory R2 bucket — the PGlite test env has no R2 binding, so we
 *  inject one per request. Implements only what the route touches. */
class FakeBucket {
  store = new Map<string, Uint8Array>()
  async put(key: string, value: Uint8Array): Promise<void> {
    this.store.set(key, value)
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key)
  }
  async get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null> {
    const v = this.store.get(key)
    if (!v) return null
    return { arrayBuffer: async () => v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) }
  }
}

async function seedProject(projectId: string, createdBy: number): Promise<void> {
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by) VALUES (?, ?, ?)")
    .bind(projectId, "Artifact Project", createdBy)
    .run()
}

async function grant(projectId: string, userId: number, role: number): Promise<void> {
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES (?, ?, ?, ?)",
  )
    .bind(projectId, userId, role, userId)
    .run()
}

function upload(
  projectId: string,
  jwt: string,
  body: BodyInit | undefined,
  headers: Record<string, string>,
  bucket?: FakeBucket,
): Promise<Response> {
  const testEnv = bucket ? { ...env, SNAPSHOTS: bucket } : env
  return app.request(
    `/api/v2/projects/${projectId}/agent-artifacts`,
    { method: "POST", headers: { ...authHeader(jwt), ...headers }, body },
    testEnv,
  )
}

describe("agent artifact upload", () => {
  it("contributor uploads bytes → row + R2 object land where load_artifact reads them", async () => {
    await seedUser(1, "owner")
    await seedUser(2, "contrib")
    await seedProject(PROJECT, 1)
    await grant(PROJECT, 2, ROLE.CONTRIBUTOR)
    const jwt = await jwtFor("contrib")
    const bucket = new FakeBucket()

    const bytes = new TextEncoder().encode("id,source,target\n1,hello,hola\n")
    const res = await upload(
      PROJECT,
      jwt,
      bytes,
      { "x-artifact-name": "glossary.csv", "content-type": "text/csv" },
      bucket,
    )
    expect(res.status).toBe(201)
    const out = (await res.json()) as { artifactId: string; fileName: string; sizeBytes: number }
    expect(out.fileName).toBe("glossary.csv")
    expect(out.sizeBytes).toBe(bytes.byteLength)

    // The row load_artifact resolves — same query the harness runs.
    const row = await env.AQUILLA_PG.prepare(
      "SELECT r2_key, name, size_bytes, kind, credential_id FROM artifacts WHERE id::text = ? AND project_id = ?",
    )
      .bind(out.artifactId, PROJECT)
      .first<{ r2_key: string; name: string; size_bytes: number; kind: string; credential_id: string }>()
    expect(row).not.toBeNull()
    expect(row!.r2_key).toBe(`artifacts/${PROJECT}/${out.artifactId}`)
    expect(row!.kind).toBe("source")
    expect(row!.credential_id).toBe("session")
    // The bytes are in the bucket under that exact key.
    expect(bucket.store.has(row!.r2_key)).toBe(true)
  })

  it("rejects a viewer (below CONTRIBUTOR) with 403", async () => {
    await seedUser(1, "owner")
    await seedUser(3, "viewer")
    await seedProject(PROJECT, 1)
    await grant(PROJECT, 3, ROLE.VIEWER)
    const jwt = await jwtFor("viewer")

    const res = await upload(
      PROJECT,
      jwt,
      new TextEncoder().encode("x"),
      { "x-artifact-name": "f.txt" },
      new FakeBucket(),
    )
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("permission_denied")
  })

  it("requires the x-artifact-name header", async () => {
    await seedUser(1, "owner")
    await seedUser(2, "contrib")
    await seedProject(PROJECT, 1)
    await grant(PROJECT, 2, ROLE.CONTRIBUTOR)
    const jwt = await jwtFor("contrib")

    const res = await upload(PROJECT, jwt, new TextEncoder().encode("x"), {}, new FakeBucket())
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("validation_failed")
  })

  it("rejects an empty body", async () => {
    await seedUser(1, "owner")
    await seedUser(2, "contrib")
    await seedProject(PROJECT, 1)
    await grant(PROJECT, 2, ROLE.CONTRIBUTOR)
    const jwt = await jwtFor("contrib")

    const res = await upload(PROJECT, jwt, undefined, { "x-artifact-name": "empty.txt" }, new FakeBucket())
    expect(res.status).toBe(400)
  })

  it("returns 503 when the SNAPSHOTS bucket is not configured", async () => {
    await seedUser(1, "owner")
    await seedUser(2, "contrib")
    await seedProject(PROJECT, 1)
    await grant(PROJECT, 2, ROLE.CONTRIBUTOR)
    const jwt = await jwtFor("contrib")

    // No bucket override → env.SNAPSHOTS is undefined in the PGlite test env.
    const res = await upload(PROJECT, jwt, new TextEncoder().encode("x"), { "x-artifact-name": "f.txt" })
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("storage_unavailable")
  })
})
