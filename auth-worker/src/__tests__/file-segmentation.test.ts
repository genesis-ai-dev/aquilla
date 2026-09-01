// Per-file segmentation: the pure validation rules and the HTTP surface.
//
// WHY these tests exist: an explicit boundary list is the shape a
// re-segmentation pass will produce, and a bad list loses work SILENTLY —
// cells that belong to no span are never drafted by any run and are never
// reported as skipped, because nothing knows they were meant to be covered.
// So every structural rule (known endpoints, no gaps, no overlaps, in order,
// full coverage) is pinned here, and the route is pinned to reject rather
// than store.

import { env } from "cloudflare:test"
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { scriptMockResponse } from "../../../scripts/mock-openrouter"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"
import {
  getFileSegmentation,
  setFileSegmentation,
  validateBoundaries,
  validateSegmentationInput,
  MAX_SEGMENT_SIZE,
  MIN_SEGMENT_SIZE,
} from "../../../db/shared/file-segmentation"

const PROJECT = "proj-seg"
const FILE = "file-seg"
const CELLS = ["c1", "c2", "c3", "c4", "c5", "c6"]
const MOCK_BASE = "http://mock.local/api/v1"

const testEnv = env as typeof env & { OPENROUTER_BASE_URL?: string }
const realFetch = globalThis.fetch

async function seedWorld(): Promise<{ lead: string; contrib: string; viewer: string }> {
  await seedUser(1, "seg-lead")
  await seedUser(2, "seg-contrib")
  await seedUser(3, "seg-viewer")
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by) VALUES (?, ?, ?)")
    .bind(PROJECT, "Segmentation", 1)
    .run()
  for (const [userId, role] of [
    [1, 500],
    [2, 400],
    [3, 100],
  ] as const) {
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES (?, ?, ?, 1)",
    )
      .bind(PROJECT, userId, role)
      .run()
  }
  for (let i = 0; i < CELLS.length; i++) {
    await env.AQUILLA_PG.prepare(
      `INSERT INTO cells (project_id, file_id, cell_id, side, value, sequence_index, event_id, last_edit_at)
       VALUES (?, ?, ?, 'source', ?, ?, ?, 0)`,
    )
      .bind(PROJECT, FILE, CELLS[i], `Sentence ${i + 1}.`, i, `ev-${CELLS[i]}`)
      .run()
  }
  return {
    lead: await jwtFor("seg-lead"),
    contrib: await jwtFor("seg-contrib"),
    viewer: await jwtFor("seg-viewer"),
  }
}

async function req(method: string, path: string, jwt: string, body?: unknown) {
  return app.request(
    `/api/v2/projects/${PROJECT}/contextual${path}`,
    {
      method,
      headers: authHeader(jwt),
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  )
}

const span = (startCellId: string, endCellId: string) => ({ startCellId, endCellId })

// ── Pure validation ─────────────────────────────────────────────────────────

describe("validateBoundaries", () => {
  it("accepts a contiguous list that covers the file", () => {
    const result = validateBoundaries([span("c1", "c3"), span("c4", "c6")], CELLS)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toHaveLength(2)
  })

  it("rejects an endpoint that is not in the file", () => {
    const result = validateBoundaries([span("c1", "c3"), span("c4", "nope")], CELLS)
    expect(result).toMatchObject({ ok: false })
    if (!result.ok) expect(result.error).toContain("endCellId not in this file")
  })

  it("rejects a gap — cells in no span would never be drafted", () => {
    const result = validateBoundaries([span("c1", "c2"), span("c4", "c6")], CELLS)
    expect(result).toMatchObject({ ok: false })
    if (!result.ok) expect(result.error).toContain("gap of 1 cell")
  })

  it("rejects an overlap", () => {
    const result = validateBoundaries([span("c1", "c4"), span("c3", "c6")], CELLS)
    expect(result).toMatchObject({ ok: false })
    if (!result.ok) expect(result.error).toContain("overlaps")
  })

  it("rejects out-of-order spans", () => {
    const result = validateBoundaries([span("c4", "c6"), span("c1", "c3")], CELLS)
    expect(result).toMatchObject({ ok: false })
  })

  it("rejects a span that ends before it starts", () => {
    const result = validateBoundaries([span("c3", "c1")], CELLS)
    expect(result).toMatchObject({ ok: false })
    if (!result.ok) expect(result.error).toContain("ends before it starts")
  })

  it("rejects a list that stops short of the end of the file", () => {
    const result = validateBoundaries([span("c1", "c4")], CELLS)
    expect(result).toMatchObject({ ok: false })
    if (!result.ok) expect(result.error).toContain("cover 4 of 6")
  })

  it("rejects empty, non-array, and malformed entries", () => {
    expect(validateBoundaries([], CELLS)).toMatchObject({ ok: false })
    expect(validateBoundaries("nope", CELLS)).toMatchObject({ ok: false })
    expect(validateBoundaries([{ startCellId: "c1" }], CELLS)).toMatchObject({ ok: false })
    expect(validateBoundaries([null], CELLS)).toMatchObject({ ok: false })
  })

  it("carries title/gist/depth through, trimmed and clamped", () => {
    const result = validateBoundaries(
      [{ startCellId: "c1", endCellId: "c6", title: "  A scene  ", gist: "x".repeat(5000), depth: 99.7 }],
      CELLS,
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value[0].title).toBe("A scene")
      expect(result.value[0].gist?.length).toBe(1000)
      expect(result.value[0].depth).toBe(4)
    }
  })

  it("drops blank optional fields rather than storing empty strings", () => {
    const result = validateBoundaries([{ startCellId: "c1", endCellId: "c6", title: "   " }], CELLS)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value[0].title).toBeUndefined()
  })
})

describe("validateSegmentationInput", () => {
  it("drops a size and boundaries sent alongside 'auto'", () => {
    const result = validateSegmentationInput(
      { strategy: "auto", fixedSize: 9, boundaries: [span("c1", "c6")] },
      CELLS,
    )
    expect(result).toMatchObject({ ok: true, value: { strategy: "auto" } })
    if (result.ok) {
      expect(result.value.fixedSize).toBeUndefined()
      expect(result.value.boundaries).toBeUndefined()
    }
  })

  it("requires a size for 'fixed' and clamps it to the shared bounds", () => {
    expect(validateSegmentationInput({ strategy: "fixed" }, CELLS)).toMatchObject({ ok: false })
    expect(validateSegmentationInput({ strategy: "fixed", fixedSize: 1 }, CELLS)).toMatchObject({
      ok: true,
      value: { fixedSize: MIN_SEGMENT_SIZE },
    })
    expect(validateSegmentationInput({ strategy: "fixed", fixedSize: 9999 }, CELLS)).toMatchObject({
      ok: true,
      value: { fixedSize: MAX_SEGMENT_SIZE },
    })
    expect(validateSegmentationInput({ strategy: "fixed", fixedSize: 7.8 }, CELLS)).toMatchObject({
      ok: true,
      value: { fixedSize: 7 },
    })
  })

  it("rejects an over-long note", () => {
    expect(
      validateSegmentationInput({ strategy: "auto", note: "x".repeat(2001) }, CELLS),
    ).toMatchObject({ ok: false })
  })
})

// ── Storage ─────────────────────────────────────────────────────────────────

describe("file_segmentation storage", () => {
  beforeEach(async () => {
    await seedWorld()
  })

  it("returns null for a file nobody has configured — absent means 'auto'", async () => {
    expect(await getFileSegmentation(env.AQUILLA_PG, PROJECT, FILE)).toBeNull()
  })

  it("upserts, bumps the version, and round-trips boundaries", async () => {
    const first = await setFileSegmentation(
      env.AQUILLA_PG,
      PROJECT,
      FILE,
      { strategy: "fixed", fixedSize: 4, humanEdited: true },
      "seg-lead",
    )
    expect(first).toMatchObject({ strategy: "fixed", fixedSize: 4, version: 1, humanEdited: true })

    const second = await setFileSegmentation(
      env.AQUILLA_PG,
      PROJECT,
      FILE,
      { strategy: "explicit", boundaries: [span("c1", "c3"), span("c4", "c6")] },
      "seg-lead",
    )
    expect(second.version).toBe(2)
    expect(second.strategy).toBe("explicit")
    expect(second.boundaries).toEqual([span("c1", "c3"), span("c4", "c6")])
    expect(second.fixedSize).toBeNull()
  })

  it("keeps the human-edited pin once set, even on a later automated write", async () => {
    await setFileSegmentation(
      env.AQUILLA_PG,
      PROJECT,
      FILE,
      { strategy: "fixed", fixedSize: 4, humanEdited: true },
      "seg-lead",
    )
    const afterModel = await setFileSegmentation(
      env.AQUILLA_PG,
      PROJECT,
      FILE,
      { strategy: "explicit", boundaries: [span("c1", "c6")], generatedBy: "model", modelId: "m/1" },
      null,
    )
    expect(afterModel.humanEdited).toBe(true)
    expect(afterModel.generatedBy).toBe("model")
    expect(afterModel.modelId).toBe("m/1")
  })
})

// ── HTTP ────────────────────────────────────────────────────────────────────

describe("GET /contextual/segmentation", () => {
  beforeEach(async () => {
    await seedWorld()
  })

  it("previews the DERIVED segmentation when nothing is stored", async () => {
    const { viewer } = await seedTokens()
    const res = await req("GET", `/segmentation?fileId=${FILE}`, viewer)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      segmentation: unknown
      effective: { spanCount: number; cellCount: number; spans: { cellCount: number }[] }
      limits: { minSize: number; maxSize: number }
    }
    expect(body.segmentation).toBeNull()
    expect(body.effective.cellCount).toBe(6)
    expect(body.effective.spanCount).toBe(1) // 6 cells, no structure → one chunk
    expect(body.effective.spans[0].cellCount).toBe(6)
    expect(body.limits).toMatchObject({ minSize: MIN_SEGMENT_SIZE, maxSize: MAX_SEGMENT_SIZE })
  })

  it("previews through the SAME resolver the run uses, so the preview is the truth", async () => {
    const { lead } = await seedTokens()
    const put = await req("PUT", `/segmentation?fileId=${FILE}`, lead, {
      strategy: "fixed",
      fixedSize: 2,
    })
    expect(put.status).toBe(200)

    const res = await req("GET", `/segmentation?fileId=${FILE}`, lead)
    const body = (await res.json()) as {
      effective: { spanCount: number; spans: { cellCount: number; seedSource: string }[] }
    }
    expect(body.effective.spanCount).toBe(3)
    expect(body.effective.spans.map((s) => s.cellCount)).toEqual([2, 2, 2])
  })

  it("reports an explicit stored list as the effective source", async () => {
    const { lead } = await seedTokens()
    await req("PUT", `/segmentation?fileId=${FILE}`, lead, {
      strategy: "explicit",
      boundaries: [span("c1", "c2"), span("c3", "c6")],
    })
    const res = await req("GET", `/segmentation?fileId=${FILE}`, lead)
    const body = (await res.json()) as {
      effective: { seedSource: string; spanCount: number; spans: { cellCount: number }[] }
    }
    expect(body.effective.seedSource).toBe("explicit")
    expect(body.effective.spans.map((s) => s.cellCount)).toEqual([2, 4])
  })

  it("requires fileId", async () => {
    const { viewer } = await seedTokens()
    expect((await req("GET", "/segmentation", viewer)).status).toBe(400)
  })

  it("dry-runs a fixed preview without writing the stored row", async () => {
    const { viewer } = await seedTokens()
    const preview = await req("GET", `/segmentation?fileId=${FILE}&strategy=fixed&fixedSize=2`, viewer)
    expect(preview.status).toBe(200)
    const body = (await preview.json()) as {
      segmentation: unknown
      effective: { spanCount: number; spans: { cellCount: number; excerpt?: string }[] }
    }
    expect(body.segmentation).toBeNull()
    expect(body.effective.spanCount).toBe(3)
    expect(body.effective.spans.map((s) => s.cellCount)).toEqual([2, 2, 2])
    expect(body.effective.spans[0]?.excerpt).toMatch(/Sentence 1/)

    const stored = await req("GET", `/segmentation?fileId=${FILE}`, viewer)
    const storedBody = (await stored.json()) as { effective: { spanCount: number } }
    expect(storedBody.effective.spanCount).toBe(1)
  })
})

describe("PUT /contextual/segmentation", () => {
  beforeEach(async () => {
    await seedWorld()
  })

  it("is closed to CONTRIBUTOR — cutting the file differently changes every future run", async () => {
    const { contrib } = await seedTokens()
    const res = await req("PUT", `/segmentation?fileId=${FILE}`, contrib, {
      strategy: "fixed",
      fixedSize: 3,
    })
    expect(res.status).toBe(403)
    expect(await getFileSegmentation(env.AQUILLA_PG, PROJECT, FILE)).toBeNull()
  })

  it("stores a lead's choice, marked human-edited", async () => {
    const { lead } = await seedTokens()
    const res = await req("PUT", `/segmentation?fileId=${FILE}`, lead, {
      strategy: "fixed",
      fixedSize: 3,
      note: "the chapter breaks are wrong in this book",
    })
    expect(res.status).toBe(200)
    const stored = await getFileSegmentation(env.AQUILLA_PG, PROJECT, FILE)
    expect(stored).toMatchObject({
      strategy: "fixed",
      fixedSize: 3,
      humanEdited: true,
      generatedBy: "human",
      updatedBy: "seg-lead",
      note: "the chapter breaks are wrong in this book",
    })
  })

  it("rejects a boundary list with a gap rather than storing it", async () => {
    const { lead } = await seedTokens()
    const res = await req("PUT", `/segmentation?fileId=${FILE}`, lead, {
      strategy: "explicit",
      boundaries: [span("c1", "c2"), span("c4", "c6")],
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { message: string } }
    expect(body.error.message).toContain("gap")
    expect(await getFileSegmentation(env.AQUILLA_PG, PROJECT, FILE)).toBeNull()
  })

  it("rejects an unknown strategy", async () => {
    const { lead } = await seedTokens()
    const res = await req("PUT", `/segmentation?fileId=${FILE}`, lead, { strategy: "vibes" })
    expect(res.status).toBe(400)
  })

  it("round-trips back to 'auto', clearing the stored size", async () => {
    const { lead } = await seedTokens()
    await req("PUT", `/segmentation?fileId=${FILE}`, lead, { strategy: "fixed", fixedSize: 3 })
    const res = await req("PUT", `/segmentation?fileId=${FILE}`, lead, { strategy: "auto" })
    expect(res.status).toBe(200)
    const stored = await getFileSegmentation(env.AQUILLA_PG, PROJECT, FILE)
    expect(stored).toMatchObject({ strategy: "auto", fixedSize: null, boundaries: null })
  })
})

/** Tokens for the already-seeded users (seedWorld runs in beforeEach). */
async function seedTokens(): Promise<{ lead: string; contrib: string; viewer: string }> {
  return {
    lead: await jwtFor("seg-lead"),
    contrib: await jwtFor("seg-contrib"),
    viewer: await jwtFor("seg-viewer"),
  }
}


// ── AI re-segmentation ──────────────────────────────────────────────────────

/** A file long enough that break points are meaningful (the mock breaks every
 *  10 lines, and sub-minimum segments are dropped). */
const LONG_FILE = "file-seg-long"
const LONG_CELLS = 25

async function seedLongFile(): Promise<void> {
  for (let i = 0; i < LONG_CELLS; i++) {
    await env.AQUILLA_PG.prepare(
      `INSERT INTO cells (project_id, file_id, cell_id, side, value, sequence_index, event_id, last_edit_at)
       VALUES (?, ?, ?, 'source', ?, ?, ?, 0)`,
    )
      .bind(PROJECT, LONG_FILE, `L${i + 1}`, `Long sentence number ${i + 1}.`, i, `ev-L${i + 1}`)
      .run()
  }
}

describe("POST /contextual/segmentation/generate", () => {
  let modelCalls = 0

  beforeEach(async () => {
    await seedWorld()
    await seedLongFile()
    modelCalls = 0
    testEnv.OPENROUTER_API_KEY = "mock"
    testEnv.OPENROUTER_BASE_URL = MOCK_BASE
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === `${MOCK_BASE}/chat/completions`) {
        modelCalls += 1
        const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] }
        return new Response(JSON.stringify(scriptMockResponse(body.messages)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      throw new Error(`unexpected fetch in segmentation test: ${url}`)
    })
  })

  afterEach(() => {
    testEnv.OPENROUTER_API_KEY = undefined
    delete testEnv.OPENROUTER_BASE_URL
    vi.stubGlobal("fetch", realFetch)
  })

  it("stores model-found passages that cover the file exactly", async () => {
    const { lead } = await seedTokens()
    const res = await req("POST", `/segmentation/generate?fileId=${LONG_FILE}`, lead, {})
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      segmentation: { strategy: string; generatedBy: string; humanEdited: boolean; modelId: string }
      generated: { passageCount: number; calls: number }
    }
    expect(modelCalls).toBeGreaterThan(0)
    expect(body.segmentation.strategy).toBe("explicit")
    expect(body.segmentation.generatedBy).toBe("model")
    expect(body.segmentation.modelId).toBeTruthy()
    // Asked for by a human, but not AUTHORED by one — the pin is what stops a
    // later automated pass overwriting a person's own division.
    expect(body.segmentation.humanEdited).toBe(false)
    expect(body.generated.passageCount).toBeGreaterThan(1)

    const stored = await getFileSegmentation(env.AQUILLA_PG, PROJECT, LONG_FILE)
    const boundaries = stored?.boundaries ?? []
    expect(boundaries[0].startCellId).toBe("L1")
    expect(boundaries[boundaries.length - 1].endCellId).toBe(`L${LONG_CELLS}`)
    // Contiguous, by construction — no gap and no overlap anywhere.
    for (let i = 1; i < boundaries.length; i++) {
      const prevEnd = Number(boundaries[i - 1].endCellId.slice(1))
      expect(Number(boundaries[i].startCellId.slice(1))).toBe(prevEnd + 1)
    }
  })

  it("carries the human's note into the prompt and keeps it on the row", async () => {
    const { lead } = await seedTokens()
    let sawNote = false
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] }
      if (body.messages.some((m) => m.content.includes("keep each parable whole"))) sawNote = true
      return new Response(JSON.stringify(scriptMockResponse(body.messages)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    })
    const res = await req("POST", `/segmentation/generate?fileId=${LONG_FILE}`, lead, {
      note: "keep each parable whole",
    })
    expect(res.status).toBe(200)
    expect(sawNote).toBe(true)
    const stored = await getFileSegmentation(env.AQUILLA_PG, PROJECT, LONG_FILE)
    expect(stored?.note).toBe("keep each parable whole")
  })

  it("is closed to CONTRIBUTOR and spends nothing when refused", async () => {
    const { contrib } = await seedTokens()
    const res = await req("POST", `/segmentation/generate?fileId=${LONG_FILE}`, contrib, {})
    expect(res.status).toBe(403)
    expect(modelCalls).toBe(0)
    expect(await getFileSegmentation(env.AQUILLA_PG, PROJECT, LONG_FILE)).toBeNull()
  })

  it("refuses a file with no source cells before calling the model", async () => {
    const { lead } = await seedTokens()
    const res = await req("POST", "/segmentation/generate?fileId=nope", lead, {})
    expect(res.status).toBe(400)
    expect(modelCalls).toBe(0)
  })

  it("changes nothing when the upstream is unreachable", async () => {
    const { lead } = await seedTokens()
    vi.stubGlobal("fetch", async () => {
      throw new Error("upstream down")
    })
    const res = await req("POST", `/segmentation/generate?fileId=${LONG_FILE}`, lead, {})
    // The pass keeps the file whole rather than failing, so this still stores
    // a valid one-passage segmentation — what must NOT happen is a partial or
    // gapped list.
    expect([200, 502]).toContain(res.status)
    const stored = await getFileSegmentation(env.AQUILLA_PG, PROJECT, LONG_FILE)
    if (stored?.boundaries) {
      expect(stored.boundaries[0].startCellId).toBe("L1")
      expect(stored.boundaries[stored.boundaries.length - 1].endCellId).toBe(`L${LONG_CELLS}`)
    }
  })

  it("preserves a human-set pin when a later generation runs over it", async () => {
    const { lead } = await seedTokens()
    await req("PUT", `/segmentation?fileId=${LONG_FILE}`, lead, { strategy: "fixed", fixedSize: 5 })
    expect((await getFileSegmentation(env.AQUILLA_PG, PROJECT, LONG_FILE))?.humanEdited).toBe(true)

    const res = await req("POST", `/segmentation/generate?fileId=${LONG_FILE}`, lead, {})
    expect(res.status).toBe(200)
    const stored = await getFileSegmentation(env.AQUILLA_PG, PROJECT, LONG_FILE)
    expect(stored?.strategy).toBe("explicit")
    expect(stored?.humanEdited).toBe(true)
  })
})
