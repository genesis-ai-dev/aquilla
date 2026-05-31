// The export route must gate at maintainer (600) per spec Q32 — a viewer who
// can read a project should NOT be able to pull a full deliverable export.
import { describe, it, expect } from "vitest"
import { sign } from "hono/jwt"
import { handleExportSourceRequest, type ExportRouteEnv } from "../events/export-route"

const SECRET = "export-tests-secret"

/** Minimal D1 stub: every query resolves to `first → blob`, `all → []`. */
function makeStubDb(blob: unknown = null): ExportRouteEnv["AQUILLA_DB"] {
  return {
    prepare: () => ({
      bind: () => ({
        first: async () => blob,
        all: async () => ({ results: [] }),
      }),
    }),
  } as unknown as ExportRouteEnv["AQUILLA_DB"]
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

describe("export role gate (Q32 — maintainer 600)", () => {
  const env: ExportRouteEnv = { SYNC_SECRET_KEY: SECRET, AQUILLA_DB: makeStubDb() }

  it("403s a viewer (100) and a contributor (400)", async () => {
    const viewer = await handleExportSourceRequest(exportReq(await makeToken(100)), env)
    expect(viewer?.status).toBe(403)
    const contributor = await handleExportSourceRequest(exportReq(await makeToken(400)), env)
    expect(contributor?.status).toBe(403)
  })

  it("lets a maintainer (600) past the gate (404 = no blob seeded, gate passed)", async () => {
    const res = await handleExportSourceRequest(exportReq(await makeToken(600)), env)
    expect(res?.status).toBe(404)
  })
})
