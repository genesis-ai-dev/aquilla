// The export route gates at the org's exportMinRole (default MAINTAINER 600
// per spec Q32). Org owners can raise or lower the floor via org settings
// (FRO-253). A viewer who can read a project should NOT be able to pull a full
// deliverable export unless the org has explicitly lowered the floor.
import { describe, it, expect } from "vitest"
import { sign } from "hono/jwt"
import { handleExportSourceRequest, type ExportRouteEnv } from "../events/export-route"

const SECRET = "export-tests-secret"

/**
 * Minimal DB stub: every `first` call resolves to `blob` (or null).
 * Accepts an optional `orgSettings` JSON string to simulate the org_settings row.
 * Query routing: the first call to `first` returns `projectRow`, subsequent
 * calls return `orgSettingsRow`, then `blobRow`.
 */
function makeStubDb(
  options: {
    /** org_settings.settings JSON; undefined = no row. */
    orgSettings?: string
    /** file_source_blobs row; null = 404. */
    blob?: { format: string; raw_source: string } | null
  } = {},
): ExportRouteEnv["AQUILLA_PG"] {
  const { orgSettings, blob = null } = options
  // Call counter per `prepare` invocation to route to the right row.
  const calls: unknown[] = []
  const respond = (val: unknown) => ({
    bind: (..._args: unknown[]) => ({
      first: async () => val,
      all: async () => ({ results: [] }),
    }),
  })

  // Query sequence in handleExportSourceRequest:
  //   1. resolveExportFloor → projects (org_id)
  //   2. resolveExportFloor → org_settings (settings)
  //   3. file_source_blobs (blob)
  //   4. files (name) — only if blob found
  //   5. cells (all)
  const responses = [
    { org_id: 1 },                                                // 1. project row
    orgSettings != null ? { settings: orgSettings } : null,       // 2. org_settings row
    blob,                                                          // 3. blob row
    { name: "test.sfm" },                                         // 4. file meta
  ]
  let idx = 0

  return {
    prepare: () => {
      const row = responses[idx++] ?? null
      calls.push(row)
      return respond(row)
    },
  } as unknown as ExportRouteEnv["AQUILLA_PG"]
}

async function makeToken(role: number): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const claims = { userId: 1, projectId: "p1", fileId: "f1", role, aud: "sync", iat: now, exp: now + 900 }
  return sign(claims as unknown as Record<string, unknown>, SECRET, "HS256")
}

function exportReq(token: string): Request {
  return new Request("https://w/api/v1/projects/p1/files/f1/source", {
    headers: { Authorization: `Bearer ${token}` },
  })
}

describe("export role gate (Q32 — maintainer 600 default)", () => {
  it("403s a viewer (100) with default org floor", async () => {
    const env: ExportRouteEnv = { SYNC_SECRET_KEY: SECRET, AQUILLA_PG: makeStubDb() }
    const viewer = await handleExportSourceRequest(exportReq(await makeToken(100)), env)
    expect(viewer?.status).toBe(403)
  })

  it("403s a contributor (400) with default org floor", async () => {
    const env: ExportRouteEnv = { SYNC_SECRET_KEY: SECRET, AQUILLA_PG: makeStubDb() }
    const contributor = await handleExportSourceRequest(exportReq(await makeToken(400)), env)
    expect(contributor?.status).toBe(403)
  })

  it("lets a maintainer (600) past the default gate (404 = no blob seeded, gate passed)", async () => {
    const env: ExportRouteEnv = { SYNC_SECRET_KEY: SECRET, AQUILLA_PG: makeStubDb() }
    const res = await handleExportSourceRequest(exportReq(await makeToken(600)), env)
    // 404 because no blob seeded, but gate was passed
    expect(res?.status).toBe(404)
  })
})

describe("export role gate with org exportMinRole (FRO-253)", () => {
  it("allows a contributor (400) when org sets exportMinRole=400", async () => {
    const settings = JSON.stringify({ exportMinRole: 400 })
    const env: ExportRouteEnv = {
      SYNC_SECRET_KEY: SECRET,
      AQUILLA_PG: makeStubDb({ orgSettings: settings }),
    }
    const res = await handleExportSourceRequest(exportReq(await makeToken(400)), env)
    // 404 = no blob seeded but gate was passed
    expect(res?.status).toBe(404)
  })

  it("403s a viewer (100) even when org lowers floor to contributor (400)", async () => {
    const settings = JSON.stringify({ exportMinRole: 400 })
    const env: ExportRouteEnv = {
      SYNC_SECRET_KEY: SECRET,
      AQUILLA_PG: makeStubDb({ orgSettings: settings }),
    }
    const res = await handleExportSourceRequest(exportReq(await makeToken(100)), env)
    expect(res?.status).toBe(403)
  })

  it("403s a maintainer (600) when org raises floor to owner (700)", async () => {
    const settings = JSON.stringify({ exportMinRole: 700 })
    const env: ExportRouteEnv = {
      SYNC_SECRET_KEY: SECRET,
      AQUILLA_PG: makeStubDb({ orgSettings: settings }),
    }
    const res = await handleExportSourceRequest(exportReq(await makeToken(600)), env)
    expect(res?.status).toBe(403)
  })

  it("ignores invalid exportMinRole (out of range) and falls back to default", async () => {
    const settings = JSON.stringify({ exportMinRole: 999 })
    const env: ExportRouteEnv = {
      SYNC_SECRET_KEY: SECRET,
      AQUILLA_PG: makeStubDb({ orgSettings: settings }),
    }
    // Maintainer should still pass (fallback to 600 default)
    const res = await handleExportSourceRequest(exportReq(await makeToken(600)), env)
    expect(res?.status).toBe(404) // gate passed
  })
})
