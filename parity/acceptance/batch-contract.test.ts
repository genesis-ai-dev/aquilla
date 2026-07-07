// Contract tests for the FROZEN Batch API v1 (BATCH_ENDPOINT_CONTRACT.md),
// run against the reference stub. The real endpoint must pass this exact
// suite through an HTTP transport adapter (parity/batch/contract.test.ts
// re-exports it for that purpose).
import { describe, it, expect } from "vitest"
import { BatchStubServer, type StubRequest, type StubResponse } from "../batch/stub-server"
import type { FewShotExample } from "@/lib/batch/types"

const KEY = { "x-aquilla-key": "test_acct.s3cret" }

const seg = (id: string, text: string): { id: string; text: string } => ({ id, text })

const createBody = (over?: Record<string, unknown>): Record<string, unknown> => ({
  projectId: "proj-1",
  sourceLang: "en-US",
  targetLang: "fr-FR",
  segments: [seg("s1", "Hello world"), seg("s2", "Second segment")],
  ...over,
})

const post = (server: BatchStubServer, body: unknown, headers: Record<string, string> = KEY): Promise<StubResponse> =>
  server.handle({ method: "POST", path: "/batch/v1/batches", headers, body })

describe("batch API contract", () => {
  it("[batch.contract] rejects missing/malformed credentials with 401 and stable error codes", async () => {
    const server = new BatchStubServer()
    const noKey = await post(server, createBody(), {})
    expect(noKey.status).toBe(401)
    expect((noKey.body as { errors: { code: string }[] }).errors[0].code).toBe("unauthorized")
    const badKey = await post(server, createBody(), { "x-aquilla-key": "not-a-key" })
    expect(badKey.status).toBe(401)
  })

  it("[batch.contract] validates the request schema with field-naming messages", async () => {
    const server = new BatchStubServer()
    const noProject = await post(server, createBody({ projectId: undefined }))
    expect(noProject.status).toBe(400)
    expect((noProject.body as { errors: { message: string }[] }).errors[0].message).toContain("projectId")
    const badLang = await post(server, createBody({ targetLang: "not a lang!" }))
    expect(badLang.status).toBe(422)
    expect((badLang.body as { errors: { code: string }[] }).errors[0].code).toBe("unsupported_language")
    const dupIds = await post(server, createBody({ segments: [seg("a", "x"), seg("a", "y")] }))
    expect(dupIds.status).toBe(400)
    const tooMany = await post(
      server,
      createBody({ segments: Array.from({ length: 501 }, (_, i) => seg(`s${i}`, "x")) }),
    )
    expect(tooMany.status).toBe(413)
    expect((tooMany.body as { errors: { code: string }[] }).errors[0].code).toBe("too_many_segments")
  })

  it("[batch.contract] returns 202 with batchId/batchToken/URLs and transitions to succeeded", async () => {
    const server = new BatchStubServer()
    const created = await post(server, createBody())
    expect(created.status).toBe(202)
    const body = created.body as { batchId: string; batchToken: string; status: string; segmentCount: number; statusUrl: string }
    expect(body.status).toBe("queued")
    expect(body.segmentCount).toBe(2)
    expect(body.statusUrl).toBe(`/batch/v1/batches/${body.batchId}`)

    const before = await server.handle({ method: "GET", path: body.statusUrl, headers: KEY })
    expect((before.body as { status: string }).status).toBe("queued")
    await server.drain()
    const after = await server.handle({ method: "GET", path: body.statusUrl, headers: KEY })
    const status = after.body as { status: string; completedCount: number; finishedAt: string | null }
    expect(status.status).toBe("succeeded")
    expect(status.completedCount).toBe(2)
    expect(status.finishedAt).not.toBeNull()
  })

  it("[batch.contract] capability token reads work without the account key; wrong ids 404", async () => {
    const server = new BatchStubServer()
    const created = (await post(server, createBody())).body as { batchId: string; batchToken: string }
    await server.drain()
    const viaToken = await server.handle({
      method: "GET",
      path: `/batch/v1/batches/${created.batchId}`,
      headers: { authorization: `Bearer ${created.batchToken}` },
    })
    expect(viaToken.status).toBe(200)
    const wrongToken = await server.handle({
      method: "GET",
      path: `/batch/v1/batches/${created.batchId}`,
      headers: { authorization: "Bearer btok_forged" },
    })
    expect(wrongToken.status).toBe(404)
    const unknown = await server.handle({ method: "GET", path: "/batch/v1/batches/nope", headers: KEY })
    expect(unknown.status).toBe(404)
    expect((unknown.body as { errors: { code: string }[] }).errors[0].code).toBe("batch_not_found")
  })

  it("[batch.contract] per-segment failures surface as failed results and partially_failed status", async () => {
    const server = new BatchStubServer({
      translate: async ({ text }) => {
        if (text.includes("boom")) throw new Error("model exploded")
        return { translation: `«${text}»`, model: "m" }
      },
    })
    const created = (await post(server, createBody({ segments: [seg("ok", "fine"), seg("bad", "boom")] })))
      .body as { batchId: string; resultsUrl: string }
    await server.drain()
    const status = await server.handle({ method: "GET", path: `/batch/v1/batches/${created.batchId}`, headers: KEY })
    expect((status.body as { status: string; failedCount: number }).status).toBe("partially_failed")
    const results = await server.handle({ method: "GET", path: created.resultsUrl, headers: KEY })
    const rs = (results.body as { results: { id: string; status: string; error?: { code: string } }[] }).results
    expect(rs.find((r) => r.id === "ok")?.status).toBe("succeeded")
    expect(rs.find((r) => r.id === "bad")?.status).toBe("failed")
    expect(rs.find((r) => r.id === "bad")?.error?.code).toBe("translation_failed")
  })

  it("[batch.contract] cancel is idempotent and cancelling a finished batch is a no-op", async () => {
    const server = new BatchStubServer()
    const created = (await post(server, createBody())).body as { batchId: string }
    const c1 = await server.handle({ method: "POST", path: `/batch/v1/batches/${created.batchId}/cancel`, headers: KEY })
    expect((c1.body as { cancelled: boolean; status: string }).cancelled).toBe(true)
    const c2 = await server.handle({ method: "POST", path: `/batch/v1/batches/${created.batchId}/cancel`, headers: KEY })
    expect(c2.status).toBe(200)

    const done = (await post(server, createBody())).body as { batchId: string }
    await server.drain()
    const c3 = await server.handle({ method: "POST", path: `/batch/v1/batches/${done.batchId}/cancel`, headers: KEY })
    expect((c3.body as { status: string; cancelled: boolean }).status).toBe("succeeded")
    expect((c3.body as { cancelled: boolean }).cancelled).toBe(false)
  })

  it("[batch.idempotency] same key + same body replays the original response; different body conflicts", async () => {
    const server = new BatchStubServer()
    const headers = { ...KEY, "idempotency-key": "11111111-2222-3333-4444-555555555555" }
    const first = await post(server, createBody(), headers)
    const replay = await post(server, createBody(), headers)
    expect(replay.status).toBe(202)
    expect((replay.body as { batchId: string }).batchId).toBe((first.body as { batchId: string }).batchId)
    const conflict = await post(server, createBody({ targetLang: "de-DE" }), headers)
    expect(conflict.status).toBe(409)
    expect((conflict.body as { errors: { code: string }[] }).errors[0].code).toBe("idempotency_conflict")
  })

  it("[batch.pagination] cursor pages are stable, ordered, capped at 500, readable while running", async () => {
    const server = new BatchStubServer()
    const segments = Array.from({ length: 25 }, (_, i) => seg(`s${String(i).padStart(2, "0")}`, `text ${i}`))
    const created = (await post(server, createBody({ segments }))).body as { batchId: string; resultsUrl: string }

    // readable while queued/running: all pending
    const pending = await server.handle({ method: "GET", path: `${created.resultsUrl}?limit=10`, headers: KEY })
    expect((pending.body as { results: { status: string }[] }).results.every((r) => r.status === "pending")).toBe(true)

    await server.drain()
    const ids: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const path: string = `${created.resultsUrl}?limit=10${cursor ? `&cursor=${cursor}` : ""}`
      const page = await server.handle({ method: "GET", path, headers: KEY })
      const body = page.body as { results: { id: string }[]; nextCursor: string | null }
      ids.push(...body.results.map((r) => r.id))
      cursor = body.nextCursor
      pages++
    } while (cursor)
    expect(pages).toBe(3)
    expect(ids).toEqual(segments.map((s) => s.id)) // submission order, no dupes/gaps
    const bad = await server.handle({ method: "GET", path: `${created.resultsUrl}?cursor=garbage`, headers: KEY })
    expect(bad.status).toBe(400)
  })

  it("[batch.fewshot] pipeline retrieves ≤maxExamplesPerSegment examples per segment and reports examplesUsed", async () => {
    const calls: { query: string; limit: number }[] = []
    const server = new BatchStubServer({
      retrieveExamples: async ({ query, limit }) => {
        calls.push({ query, limit })
        const pool: FewShotExample[] = [
          { source: "Hello", target: "Bonjour", projectId: "p9", orgId: "org-normal" },
          { source: "World", target: "Monde", projectId: "p9", orgId: "org-normal" },
          { source: "Save", target: "Enregistrer", projectId: "p8", orgId: "org-normal" },
        ]
        return pool.slice(0, limit)
      },
    })
    const created = (await post(
      server,
      createBody({ options: { maxExamplesPerSegment: 2, useGlobalExamples: true } }),
    )).body as { batchId: string; resultsUrl: string }
    await server.drain()
    expect(calls).toHaveLength(2)
    expect(calls.every((c) => c.limit === 2)).toBe(true)
    const results = await server.handle({ method: "GET", path: created.resultsUrl, headers: KEY })
    const rs = (results.body as { results: { examplesUsed: number }[] }).results
    expect(rs.every((r) => r.examplesUsed === 2)).toBe(true)

    // useGlobalExamples=false → zero retrieval calls, examplesUsed 0
    const calls2 = calls.length
    const noEx = (await post(server, createBody({ options: { useGlobalExamples: false } }))).body as { resultsUrl: string }
    await server.drain()
    expect(calls.length).toBe(calls2)
    const rs2 = await server.handle({ method: "GET", path: noEx.resultsUrl, headers: KEY })
    expect((rs2.body as { results: { examplesUsed: number }[] }).results.every((r) => r.examplesUsed === 0)).toBe(true)
  })
})
