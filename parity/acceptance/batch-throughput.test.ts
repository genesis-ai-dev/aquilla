// Throughput bar test — BATCH_ENDPOINT_CONTRACT.md §4 (frozen):
// 10,000 segments through create→process→results with a no-op translator in
// ≤5 minutes of pipeline time (≥2,000 segments/minute sustained).
import { describe, it, expect } from "vitest"
import { BatchStubServer } from "../batch/stub-server"

const KEY = { "x-aquilla-key": "test_acct.s3cret" }

describe("batch throughput", () => {
  it("[batch.throughput] 10k segments flow create→process→results within the 5-minute pipeline budget", { timeout: 330_000 }, async () => {
    const server = new BatchStubServer({
      translate: async ({ text }) => ({ translation: text, model: "noop" }),
      retrieveExamples: async () => [],
    })
    const started = performance.now()
    const TOTAL = 10_000
    const CHUNK = 500 // contract cap per create request
    const batchRefs: { batchId: string; resultsUrl: string }[] = []
    for (let offset = 0; offset < TOTAL; offset += CHUNK) {
      const created = await server.handle({
        method: "POST",
        path: "/batch/v1/batches",
        headers: KEY,
        body: {
          projectId: "throughput",
          sourceLang: "en-US",
          targetLang: "fr-FR",
          segments: Array.from({ length: CHUNK }, (_, i) => ({
            id: `s${offset + i}`,
            text: `Segment number ${offset + i} with some realistic length of text to translate.`,
          })),
        },
      })
      expect(created.status).toBe(202)
      batchRefs.push(created.body as { batchId: string; resultsUrl: string })
    }
    await server.drain()
    let translated = 0
    for (const ref of batchRefs) {
      let cursor: string | null = null
      do {
        const path: string = `${ref.resultsUrl}?limit=500${cursor ? `&cursor=${cursor}` : ""}`
        const page = await server.handle({ method: "GET", path, headers: KEY })
        const body = page.body as { results: { status: string }[]; nextCursor: string | null }
        translated += body.results.filter((r) => r.status === "succeeded").length
        cursor = body.nextCursor
      } while (cursor)
    }
    const elapsedMs = performance.now() - started
    expect(translated).toBe(TOTAL)
    expect(elapsedMs).toBeLessThan(5 * 60 * 1000)
    // eslint-disable-next-line no-console
    console.log(`[batch.throughput] ${TOTAL} segments in ${(elapsedMs / 1000).toFixed(1)}s (${Math.round((TOTAL / elapsedMs) * 60000)} seg/min)`)
  })
})
