import { describe, it, expect } from "vitest"
import { sign } from "hono/jwt"
import { handleExportBundleRequest, type ExportBundleEnv } from "../events/export-bundle-route"

const SECRET = "bundle-tests-secret"

/** SQL-matching DB stub: blob-list, file-name, and cells queries each get the right shape. */
function makeStubDb(
  blobs: { file_id: string; raw_source: string | null; r2_key?: string | null }[],
  names: Record<string, string> = {},
  cellBinds?: unknown[][],
) {
  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          if (sql.includes("FROM cells t")) cellBinds?.push(args)
          return {
            async all() {
              if (sql.includes("file_source_blobs")) return { results: blobs }
              return { results: [] } // cells overrides
            },
            async first() {
              if (sql.includes("FROM files")) {
                const fileId = args[0] as string
                return { name: names[fileId] ?? `${fileId}.sfm` }
              }
              return null
            },
          }
        },
      }
    },
  } as unknown as ExportBundleEnv["AQUILLA_PG"]
}

function makeStubBucket(): R2Bucket {
  return { get: async () => null } as unknown as R2Bucket
}

async function makeToken(role: number): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const claims = { userId: 1, projectId: "p1", role, aud: "sync", iat: now, exp: now + 900 }
  return sign(claims as unknown as Record<string, unknown>, SECRET, "HS256")
}

function bundleReq(token: string): Request {
  return new Request("https://w/api/v1/projects/p1/export/bundle", {
    headers: { Authorization: `Bearer ${token}` },
  })
}

describe("GET /export/bundle", () => {
  it("403s a non-maintainer", async () => {
    const env: ExportBundleEnv = { SYNC_SECRET_KEY: SECRET, AQUILLA_PG: makeStubDb([]), SNAPSHOTS: makeStubBucket() }
    const res = await handleExportBundleRequest(bundleReq(await makeToken(400)), env)
    expect(res?.status).toBe(403)
  })

  it("404s a maintainer when there are no exportable files", async () => {
    const env: ExportBundleEnv = { SYNC_SECRET_KEY: SECRET, AQUILLA_PG: makeStubDb([]), SNAPSHOTS: makeStubBucket() }
    const res = await handleExportBundleRequest(bundleReq(await makeToken(600)), env)
    expect(res?.status).toBe(404)
  })

  it("zips the USFM files for a maintainer", async () => {
    const env: ExportBundleEnv = {
      SYNC_SECRET_KEY: SECRET,
      AQUILLA_PG: makeStubDb(
        [
          { file_id: "f1", raw_source: "\\id GEN\n\\c 1\n\\v 1 In the beginning\n" },
          { file_id: "f2", raw_source: "\\id EXO\n\\c 1\n\\v 1 These are the names\n" },
        ],
        { f1: "GEN.SFM", f2: "EXO.SFM" },
      ),
      SNAPSHOTS: makeStubBucket(),
    }
    const res = await handleExportBundleRequest(bundleReq(await makeToken(600)), env)
    expect(res?.status).toBe(200)
    expect(res?.headers.get("Content-Type")).toBe("application/zip")
    const buf = new Uint8Array(await res!.arrayBuffer())
    // valid zip (PK\x03\x04) containing both book file names
    expect(Array.from(buf.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04])
    const txt = new TextDecoder().decode(buf)
    expect(txt).toContain("GEN.SFM")
    expect(txt).toContain("EXO.SFM")
  })

  it("uses the requested target lane for every file", async () => {
    const cellBinds: unknown[][] = []
    const env: ExportBundleEnv = {
      SYNC_SECRET_KEY: SECRET,
      AQUILLA_PG: makeStubDb(
        [{ file_id: "f1", raw_source: "\\id GEN\n\\c 1\n\\v 1 In the beginning\n" }],
        { f1: "GEN.SFM" },
        cellBinds,
      ),
      SNAPSHOTS: makeStubBucket(),
    }
    const token = await makeToken(600)
    const req = new Request("https://w/api/v1/projects/p1/export/bundle?lane=fr-CA", {
      headers: { Authorization: `Bearer ${token}` },
    })
    const res = await handleExportBundleRequest(req, env)

    expect(res?.status).toBe(200)
    expect(cellBinds).toEqual([["p1", "f1", "fr-CA"]])
  })
})
