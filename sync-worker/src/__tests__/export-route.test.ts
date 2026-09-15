// The export route gates at the org's exportMinRole (default MAINTAINER 600
// per spec Q32). Org owners can raise or lower the floor via org settings
// (AQU-253). A viewer who can read a project should NOT be able to pull a full
// deliverable export unless the org has explicitly lowered the floor.
//
// AQU-276: the route also counts verses whose original span contained
// intra-verse markers that plain-text substitution drops, and surfaces that
// count as the X-Usfm-Lossy-Verse-Count response header.
import { describe, it, expect } from "vitest"
import { sign } from "hono/jwt"
import { handleExportSourceRequest, type ExportRouteEnv } from "../events/export-route"

function makeStubBucket(): R2Bucket {
  const store = new Map<string, ArrayBuffer>()
  return {
    async put(key: string, value: ArrayBuffer | Uint8Array | string) {
      const body =
        typeof value === "string"
          ? new TextEncoder().encode(value).buffer
          : value instanceof Uint8Array
            ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
            : value
      store.set(key, body as ArrayBuffer)
    },
    async get(key: string) {
      const obj = store.get(key)
      if (!obj) return null
      return { arrayBuffer: async () => obj }
    },
    async delete(keys: string | string[]) {
      const list = Array.isArray(keys) ? keys : [keys]
      for (const k of list) store.delete(k)
    },
    async list({ prefix }: { prefix?: string } = {}) {
      const keys = Array.from(store.keys()).filter((k) => !prefix || k.startsWith(prefix))
      return { objects: keys.map((k) => ({ key: k })), truncated: false }
    },
  } as unknown as R2Bucket
}

const SECRET = "export-tests-secret"

/**
 * Minimal DB stub: every `first` call resolves to `blob` (or null).
 * Accepts an optional `orgSettings` JSON string to simulate the org_settings row.
 * Query routing: the first call to `first` returns `projectRow`, subsequent
 * calls return `orgSettingsRow`, then `blobRow`.
 *
 * The `cells` option seeds the translated target-cell rows returned by the
 * cells JOIN query (5th prepare call).
 */
function makeStubDb(
  options: {
    /** org_settings.settings JSON; undefined = no row. */
    orgSettings?: string
    /** file_source_blobs row; null = 404. */
    blob?: { format: string; raw_source: string | null; r2_key?: string | null } | null
    /** Translated cell rows: [{canonical_ref, value}]. Empty by default. */
    cells?: { canonical_ref: string; value: string }[]
    /** Captures the cells JOIN bind arguments for lane-selection assertions. */
    cellBinds?: unknown[][]
  } = {},
): ExportRouteEnv["AQUILLA_PG"] {
  const { orgSettings, blob = null, cells = [], cellBinds } = options

  // ROUTES ON SQL TEXT, NOT ON CALL ORDER.
  //
  // This stub used to hand back `responses[idx++]`, with a comment naming the
  // translations JOIN as "the 5th prepare call". That made every test in this
  // file depend on the exact number of queries the route runs, so AQU-1068's
  // additions-and-removals lookups broke all of them at once while changing
  // nothing they were testing. Matching on the SQL is both more honest about
  // what each response IS and immune to a new query being added.
  return {
    prepare: (sql: string) => {
      const row =
        sql.includes("FROM projects") ? { org_id: 1 }
        : sql.includes("FROM org_settings") ? (orgSettings != null ? { settings: orgSettings } : null)
        : sql.includes("FROM file_source_blobs") ? blob
        : sql.includes("FROM files") ? { name: "test.sfm" }
        : null
      // The translations JOIN is the only query whose ROWS these tests seed.
      // Everything else AQU-1068 added — added cells, their anchors, the
      // removed-cell lookups — correctly finds nothing here, which is the
      // shape of a file nobody restructured.
      const isTranslationsJoin = sql.includes("FROM cells t")
      return {
        bind: (...args: unknown[]) => {
          if (isTranslationsJoin) cellBinds?.push(args)
          return {
            first: async () => row,
            all: async () => ({ results: isTranslationsJoin ? cells : [] }),
          }
        },
      }
    },
  } as unknown as ExportRouteEnv["AQUILLA_PG"]
}

async function makeToken(role: number): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const claims = { userId: 1, projectId: "p1", fileId: "f1", role, aud: "sync", iat: now, exp: now + 900 }
  return sign(claims as unknown as Record<string, unknown>, SECRET, "HS256")
}

function exportReq(token: string, lane?: string): Request {
  const query = lane ? `?lane=${encodeURIComponent(lane)}` : ""
  return new Request(`https://w/api/v1/projects/p1/files/f1/source${query}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
}

describe("export role gate (Q32 — maintainer 600 default)", () => {
  it("403s a viewer (100) with default org floor", async () => {
    const env: ExportRouteEnv = { SYNC_SECRET_KEY: SECRET, AQUILLA_PG: makeStubDb(), SNAPSHOTS: makeStubBucket() }
    const viewer = await handleExportSourceRequest(exportReq(await makeToken(100)), env)
    expect(viewer?.status).toBe(403)
  })

  it("403s a contributor (400) with default org floor", async () => {
    const env: ExportRouteEnv = { SYNC_SECRET_KEY: SECRET, AQUILLA_PG: makeStubDb(), SNAPSHOTS: makeStubBucket() }
    const contributor = await handleExportSourceRequest(exportReq(await makeToken(400)), env)
    expect(contributor?.status).toBe(403)
  })

  it("lets a maintainer (600) past the default gate (404 = no blob seeded, gate passed)", async () => {
    const env: ExportRouteEnv = { SYNC_SECRET_KEY: SECRET, AQUILLA_PG: makeStubDb(), SNAPSHOTS: makeStubBucket() }
    const res = await handleExportSourceRequest(exportReq(await makeToken(600)), env)
    // 404 because no blob seeded, but gate was passed
    expect(res?.status).toBe(404)
  })
})

describe("export role gate with org exportMinRole (AQU-253)", () => {
  it("allows a contributor (400) when org sets exportMinRole=400", async () => {
    const settings = JSON.stringify({ exportMinRole: 400 })
    const env: ExportRouteEnv = {
      SYNC_SECRET_KEY: SECRET,
      AQUILLA_PG: makeStubDb({ orgSettings: settings }),
      SNAPSHOTS: makeStubBucket(),
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
      SNAPSHOTS: makeStubBucket(),
    }
    const res = await handleExportSourceRequest(exportReq(await makeToken(100)), env)
    expect(res?.status).toBe(403)
  })

  it("403s a maintainer (600) when org raises floor to owner (700)", async () => {
    const settings = JSON.stringify({ exportMinRole: 700 })
    const env: ExportRouteEnv = {
      SYNC_SECRET_KEY: SECRET,
      AQUILLA_PG: makeStubDb({ orgSettings: settings }),
      SNAPSHOTS: makeStubBucket(),
    }
    const res = await handleExportSourceRequest(exportReq(await makeToken(600)), env)
    expect(res?.status).toBe(403)
  })

  it("ignores invalid exportMinRole (out of range) and falls back to default", async () => {
    const settings = JSON.stringify({ exportMinRole: 999 })
    const env: ExportRouteEnv = {
      SYNC_SECRET_KEY: SECRET,
      AQUILLA_PG: makeStubDb({ orgSettings: settings }),
      SNAPSHOTS: makeStubBucket(),
    }
    // Maintainer should still pass (fallback to 600 default)
    const res = await handleExportSourceRequest(exportReq(await makeToken(600)), env)
    expect(res?.status).toBe(404) // gate passed
  })
})

// ---------------------------------------------------------------------------
// AQU-276: X-Usfm-Lossy-Verse-Count response header
// ---------------------------------------------------------------------------

const FOOTNOTED_USFM = `\\id MAT
\\c 1
\\v 4 ...\\f + \\fr 1:4 \\ft (Ruth 4:19,20)\\f*
\\v 5 plain text verse`

const PLAIN_USFM = `\\id GEN
\\c 1
\\v 1 In the beginning.
\\v 2 The earth was without form.`

describe("X-Usfm-Lossy-Verse-Count header (AQU-276)", () => {
  it("selects translations only from the requested target lane", async () => {
    const cellBinds: unknown[][] = []
    const env: ExportRouteEnv = {
      SYNC_SECRET_KEY: SECRET,
      AQUILLA_PG: makeStubDb({
        blob: { format: "usfm", raw_source: PLAIN_USFM },
        cells: [{ canonical_ref: "GEN 1:1", value: "Au commencement." }],
        cellBinds,
      }),
      SNAPSHOTS: makeStubBucket(),
    }
    const res = await handleExportSourceRequest(exportReq(await makeToken(600), "fr-CA"), env)

    expect(res?.status).toBe(200)
    expect(cellBinds).toEqual([["p1", "f1", "fr-CA"]])
  })

  it("emits header=0 when export has no translated verses (all fall back to source)", async () => {
    const env: ExportRouteEnv = {
      SYNC_SECRET_KEY: SECRET,
      AQUILLA_PG: makeStubDb({
        blob: { format: "usfm", raw_source: FOOTNOTED_USFM },
        cells: [], // no translated cells
      }),
      SNAPSHOTS: makeStubBucket(),
    }
    const res = await handleExportSourceRequest(exportReq(await makeToken(600)), env)
    expect(res?.status).toBe(200)
    expect(res?.headers.get("X-Usfm-Lossy-Verse-Count")).toBe("0")
  })

  it("emits header=0 when the translated verse has no intra-verse markers", async () => {
    const env: ExportRouteEnv = {
      SYNC_SECRET_KEY: SECRET,
      AQUILLA_PG: makeStubDb({
        blob: { format: "usfm", raw_source: PLAIN_USFM },
        cells: [
          { canonical_ref: "GEN 1:1", value: "Au commencement." },
          { canonical_ref: "GEN 1:2", value: "La terre était informe." },
        ],
      }),
      SNAPSHOTS: makeStubBucket(),
    }
    const res = await handleExportSourceRequest(exportReq(await makeToken(600)), env)
    expect(res?.status).toBe(200)
    expect(res?.headers.get("X-Usfm-Lossy-Verse-Count")).toBe("0")
  })

  it("emits header=1 when one translated verse had a footnote in the original span", async () => {
    const env: ExportRouteEnv = {
      SYNC_SECRET_KEY: SECRET,
      AQUILLA_PG: makeStubDb({
        blob: { format: "usfm", raw_source: FOOTNOTED_USFM },
        cells: [
          // MAT 1:4 has a footnote in its original span — lossy
          { canonical_ref: "MAT 1:4", value: "translated footnoted verse" },
        ],
      }),
      SNAPSHOTS: makeStubBucket(),
    }
    const res = await handleExportSourceRequest(exportReq(await makeToken(600)), env)
    expect(res?.status).toBe(200)
    expect(res?.headers.get("X-Usfm-Lossy-Verse-Count")).toBe("1")
  })

  it("does NOT count a verse override as lossy when the original had no markers", async () => {
    const env: ExportRouteEnv = {
      SYNC_SECRET_KEY: SECRET,
      AQUILLA_PG: makeStubDb({
        blob: { format: "usfm", raw_source: FOOTNOTED_USFM },
        cells: [
          // MAT 1:5 is plain — translation is NOT lossy
          { canonical_ref: "MAT 1:5", value: "translated plain verse" },
        ],
      }),
      SNAPSHOTS: makeStubBucket(),
    }
    const res = await handleExportSourceRequest(exportReq(await makeToken(600)), env)
    expect(res?.status).toBe(200)
    expect(res?.headers.get("X-Usfm-Lossy-Verse-Count")).toBe("0")
  })
})

describe("?mode=raw — byte-exact original USFM upload", () => {
  const rawReq = (token: string): Request =>
    new Request("https://w/api/v1/projects/p1/files/f1/source?mode=raw", {
      headers: { Authorization: `Bearer ${token}` },
    })

  it("returns raw_source verbatim with X-Export-Mode: raw-original — translations are NOT injected", async () => {
    const env: ExportRouteEnv = {
      SYNC_SECRET_KEY: SECRET,
      AQUILLA_PG: makeStubDb({
        blob: { format: "usfm", raw_source: PLAIN_USFM },
        // Translated cells exist — raw mode must ignore them entirely.
        cells: [{ canonical_ref: "GEN 1:1", value: "Au commencement." }],
      }),
      SNAPSHOTS: makeStubBucket(),
    }
    const res = await handleExportSourceRequest(rawReq(await makeToken(600)), env)
    expect(res?.status).toBe(200)
    expect(await res?.text()).toBe(PLAIN_USFM)
    expect(res?.headers.get("X-Export-Mode")).toBe("raw-original")
    // Raw mode never runs the serializer, so the lossy count doesn't apply.
    expect(res?.headers.get("X-Usfm-Lossy-Verse-Count")).toBeNull()
  })

  it("resolves R2-stored originals byte-exactly when raw_source moved to R2", async () => {
    const bucket = makeStubBucket()
    await bucket.put("sources/p1/f1", new TextEncoder().encode(PLAIN_USFM))
    const env: ExportRouteEnv = {
      SYNC_SECRET_KEY: SECRET,
      AQUILLA_PG: makeStubDb({
        blob: { format: "usfm", raw_source: null, r2_key: "sources/p1/f1" },
      }),
      SNAPSHOTS: bucket,
    }
    const res = await handleExportSourceRequest(rawReq(await makeToken(600)), env)
    expect(res?.status).toBe(200)
    expect(await res?.text()).toBe(PLAIN_USFM)
    expect(res?.headers.get("X-Export-Mode")).toBe("raw-original")
  })

  it("keeps the export role floor: a viewer (100) is still 403'd in raw mode", async () => {
    const env: ExportRouteEnv = {
      SYNC_SECRET_KEY: SECRET,
      AQUILLA_PG: makeStubDb({ blob: { format: "usfm", raw_source: PLAIN_USFM } }),
      SNAPSHOTS: makeStubBucket(),
    }
    const res = await handleExportSourceRequest(rawReq(await makeToken(100)), env)
    expect(res?.status).toBe(403)
  })
})

describe("custom source preservation (AQU-635)", () => {
  it("returns the exact original text without pretending target injection is lossless", async () => {
    const raw = "kind|source|target\nheading|Opening|Ouverture\n"
    const env: ExportRouteEnv = {
      SYNC_SECRET_KEY: SECRET,
      AQUILLA_PG: makeStubDb({
        blob: { format: "custom-original", raw_source: raw },
      }),
      SNAPSHOTS: makeStubBucket(),
    }

    const res = await handleExportSourceRequest(exportReq(await makeToken(600)), env)
    expect(res?.status).toBe(200)
    expect(await res?.text()).toBe(raw)
    expect(res?.headers.get("X-Export-Mode")).toBe("raw-original")
  })
})
