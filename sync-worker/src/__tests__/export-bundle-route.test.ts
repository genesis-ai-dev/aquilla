import { describe, it, expect } from "vitest"
import { sign } from "hono/jwt"
import { handleExportBundleRequest, type ExportBundleEnv } from "../events/export-bundle-route"

const SECRET = "bundle-tests-secret"

interface BlobRow {
  file_id: string
  raw_source: string | null
  r2_key?: string | null
}

/** A projection cell row, as plaintext-export reads it. */
interface StubCell {
  cell_id: string
  anchor_cell_id?: string | null
  event_id?: string
  value?: string | null
  canonical_ref?: string | null
  medium?: string | null
  transcription?: string | null
  validated?: number | null
  hidden_at?: number | string | null
}

interface StubDbOptions {
  /** USFM side-car rows (format = 'usfm'). */
  blobs?: BlobRow[]
  /** file_id -> files.name. */
  names?: Record<string, string>
  /** Collector for the binds of the usfm export-plan cells query. */
  cellBinds?: unknown[][]
  /**
   * AQU-991: the project's counted files, as the plain-text fallback
   * enumerates them. Defaults to one row per USFM blob, which is the
   * pre-AQU-991 shape (every file has an original).
   */
  files?: { file_id: string; name: string | null }[]
  /** file_ids that have a side-car of a NON-usfm format (docx/idml/…). */
  otherFormatBlobs?: string[]
  /** file_id -> { source, target } projection cells for the .txt fallback. */
  cells?: Record<string, { source?: StubCell[]; target?: StubCell[] }>
}

/** SQL-matching DB stub: each query shape in the route gets the right rows. */
function makeStubDb(options: StubDbOptions = {}) {
  const blobs = options.blobs ?? []
  const names = options.names ?? {}
  const files = options.files ?? blobs.map((b) => ({ file_id: b.file_id, name: names[b.file_id] ?? null }))
  const allBlobIds = [
    ...blobs.map((b) => b.file_id),
    ...(options.otherFormatBlobs ?? []),
  ].map((file_id) => ({ file_id }))
  const fill = (rows: StubCell[] | undefined) =>
    (rows ?? []).map((c, i) => ({
      anchor_cell_id: null,
      event_id: `e${String(i).padStart(4, "0")}`,
      value: null,
      canonical_ref: null,
      medium: "text",
      transcription: null,
      validated: 0,
      hidden_at: null,
      ...c,
    }))

  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          if (sql.includes("FROM cells t")) options.cellBinds?.push(args)
          return {
            async all() {
              // Order matters: the id-only all-formats query and the
              // format = 'usfm' query both name file_source_blobs.
              if (sql.includes("file_source_blobs") && sql.includes("format = 'usfm'")) {
                return { results: blobs }
              }
              if (sql.includes("FROM file_source_blobs")) return { results: allBlobIds }
              if (sql.includes("FROM files f")) return { results: files }
              if (sql.includes("FROM cells") && sql.includes("side = 'source'")) {
                return { results: fill(options.cells?.[args[1] as string]?.source) }
              }
              if (sql.includes("FROM cells") && sql.includes("side = 'target'")) {
                return { results: fill(options.cells?.[args[1] as string]?.target) }
              }
              return { results: [] } // usfm overrides / edits
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

function bundleReq(token: string, query = ""): Request {
  return new Request(`https://w/api/v1/projects/p1/export/bundle${query}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
}

async function zipText(res: Response): Promise<string> {
  const buf = new Uint8Array(await res.arrayBuffer())
  expect(Array.from(buf.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04])
  return new TextDecoder().decode(buf)
}

describe("GET /export/bundle", () => {
  it("403s a non-maintainer", async () => {
    const env: ExportBundleEnv = { SYNC_SECRET_KEY: SECRET, AQUILLA_PG: makeStubDb(), SNAPSHOTS: makeStubBucket() }
    const res = await handleExportBundleRequest(bundleReq(await makeToken(400)), env)
    expect(res?.status).toBe(403)
  })

  it("404s a maintainer when there are no exportable files", async () => {
    const env: ExportBundleEnv = { SYNC_SECRET_KEY: SECRET, AQUILLA_PG: makeStubDb(), SNAPSHOTS: makeStubBucket() }
    const res = await handleExportBundleRequest(bundleReq(await makeToken(600)), env)
    expect(res?.status).toBe(404)
  })

  it("zips the USFM files for a maintainer", async () => {
    const env: ExportBundleEnv = {
      SYNC_SECRET_KEY: SECRET,
      AQUILLA_PG: makeStubDb({
        blobs: [
          { file_id: "f1", raw_source: "\\id GEN\n\\c 1\n\\v 1 In the beginning\n" },
          { file_id: "f2", raw_source: "\\id EXO\n\\c 1\n\\v 1 These are the names\n" },
        ],
        names: { f1: "GEN.SFM", f2: "EXO.SFM" },
      }),
      SNAPSHOTS: makeStubBucket(),
    }
    const res = await handleExportBundleRequest(bundleReq(await makeToken(600)), env)
    expect(res?.status).toBe(200)
    expect(res?.headers.get("Content-Type")).toBe("application/zip")
    const txt = await zipText(res!)
    expect(txt).toContain("GEN.SFM")
    expect(txt).toContain("EXO.SFM")
  })

  it("uses the requested target lane for every file", async () => {
    const cellBinds: unknown[][] = []
    const env: ExportBundleEnv = {
      SYNC_SECRET_KEY: SECRET,
      AQUILLA_PG: makeStubDb({
        blobs: [{ file_id: "f1", raw_source: "\\id GEN\n\\c 1\n\\v 1 In the beginning\n" }],
        names: { f1: "GEN.SFM" },
        cellBinds,
      }),
      SNAPSHOTS: makeStubBucket(),
    }
    const res = await handleExportBundleRequest(bundleReq(await makeToken(600), "?lane=fr-CA"), env)

    expect(res?.status).toBe(200)
    // AQU-1420: the lane is matched on lane_id alone (project, tag); the
    // target_lang fallback and its second tag bind are gone.
    expect(cellBinds).toEqual([["p1", "f1", "p1", "fr-CA"]])
  })

  // AQU-991: a Codex-migrated project has cells but no file_source_blobs row,
  // so the deliverable used to 404 as "no exportable source files".
  describe("files with no source document (AQU-991)", () => {
    const migrated = {
      files: [{ file_id: "c1", name: "Genesis" }],
      cells: {
        c1: {
          source: [{ cell_id: "GEN 1:1", value: "In the beginning", canonical_ref: "GEN 1:1" }],
          target: [{ cell_id: "GEN 1:1", value: "Au commencement", canonical_ref: "GEN 1:1", validated: 1 }],
        },
      },
    }

    it("exports them as translated plain text instead of 404ing", async () => {
      const env: ExportBundleEnv = {
        SYNC_SECRET_KEY: SECRET,
        AQUILLA_PG: makeStubDb(migrated),
        SNAPSHOTS: makeStubBucket(),
      }
      const res = await handleExportBundleRequest(bundleReq(await makeToken(600)), env)
      expect(res?.status).toBe(200)
      const txt = await zipText(res!)
      expect(txt).toContain("Genesis.txt")
      expect(txt).toContain("Au commencement")
    })

    it("alongside the USFM files of a mixed project", async () => {
      const env: ExportBundleEnv = {
        SYNC_SECRET_KEY: SECRET,
        AQUILLA_PG: makeStubDb({
          blobs: [{ file_id: "f1", raw_source: "\\id EXO\n\\c 1\n\\v 1 These are the names\n" }],
          names: { f1: "EXO.SFM" },
          files: [{ file_id: "f1", name: "EXO.SFM" }, ...migrated.files],
          cells: migrated.cells,
        }),
        SNAPSHOTS: makeStubBucket(),
      }
      const res = await handleExportBundleRequest(bundleReq(await makeToken(600)), env)
      expect(res?.status).toBe(200)
      const txt = await zipText(res!)
      expect(txt).toContain("EXO.SFM")
      expect(txt).toContain("Genesis.txt")
    })

    it("honours ?validated=1 and 404s when nothing is validated", async () => {
      const env: ExportBundleEnv = {
        SYNC_SECRET_KEY: SECRET,
        AQUILLA_PG: makeStubDb({
          files: migrated.files,
          cells: {
            c1: {
              source: [{ cell_id: "GEN 1:1", value: "In the beginning", canonical_ref: "GEN 1:1" }],
              target: [{ cell_id: "GEN 1:1", value: "Au commencement", canonical_ref: "GEN 1:1", validated: 0 }],
            },
          },
        }),
        SNAPSHOTS: makeStubBucket(),
      }
      const res = await handleExportBundleRequest(bundleReq(await makeToken(600), "?validated=1"), env)
      expect(res?.status).toBe(404)
      expect(await res!.text()).toContain("none has text to export")
    })

    it("leaves a file whose original is a non-USFM package out of the zip", async () => {
      const env: ExportBundleEnv = {
        SYNC_SECRET_KEY: SECRET,
        AQUILLA_PG: makeStubDb({
          files: [{ file_id: "d1", name: "Brochure.docx" }],
          otherFormatBlobs: ["d1"],
          cells: {
            d1: {
              source: [{ cell_id: "p1", value: "Hello", canonical_ref: "1" }],
              target: [{ cell_id: "p1", value: "Bonjour", canonical_ref: "1" }],
            },
          },
        }),
        SNAPSHOTS: makeStubBucket(),
      }
      const res = await handleExportBundleRequest(bundleReq(await makeToken(600)), env)
      // Its deliverable is a patched copy of the package, built client-side;
      // the bundle must not substitute a .txt for it.
      expect(res?.status).toBe(404)
    })
  })
})
