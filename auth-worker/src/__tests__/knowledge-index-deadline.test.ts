import { env } from "cloudflare:test"
import { describe, it, expect, vi, afterEach } from "vitest"
import {
  indexKnowledgeDoc, segmentText, carryOverSummaries, describeIncomplete,
  KB_INDEX_BUDGET_MS, KB_WAITUNTIL_WINDOW_MS, KB_ENRICH_BATCH_NODES,
} from "../lib/knowledge/index-doc"
import { createDoc, getDocTree } from "../../../db/shared/knowledge"
import type { KnowledgeNode } from "../../../db/shared/knowledge"

// AQU-2050: Cloudflare cancels a `ctx.waitUntil` task 30 s after the response
// is sent. The job's own ceiling was a flat 60 s (AQU-1376, set before that
// limit was accounted for), so a run needing between 30 and 60 s was killed
// with nothing written: the row stayed `pending`, the list showed "Indexing…"
// and then "Indexing stalled", and "Try indexing again" hit the same cliff
// (Art of Survival_Arabic_clean.docx on dev, 30,940 ms wall time, then
// "waitUntil() tasks did not complete… and have been cancelled"). Two halves
// to the fix, and this file guards both: the budget comes from the platform
// window, and what a run does manage to summarize is kept so the retry
// continues instead of starting over.

afterEach(() => vi.unstubAllGlobals())

/** 200 headed sections, enough to need several batches. */
function largeDoc(sections = 200): string {
  return Array.from({ length: sections }, (_, i) =>
    `# Section ${i + 1}\n${`verse ${i + 1} `.repeat(120).slice(0, 1200)}`).join("\n")
}

function flatNodes(nodes: KnowledgeNode[]): KnowledgeNode[] {
  return nodes.flatMap((n) => [n, ...flatNodes(n.children ?? [])])
}

const SECTION_ID = /^(n[\d.]+): "/gm

function reply(content: unknown): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }))
}

function promptOf(init?: RequestInit): string {
  return (JSON.parse(String(init?.body)) as { messages: { content: string }[] }).messages[0].content
}

/** Answers section requests with a summary per id they name and the closing
 *  outline request with a document summary, recording the ids it was asked
 *  for. `hangFrom` makes that request and every later one wait for the job's
 *  own abort signal — a response the deadline cancels. */
function model({ hangFrom = Infinity }: { hangFrom?: number } = {}) {
  const asked: string[] = []
  let calls = 0
  const fetch = vi.fn((_url: string, init?: RequestInit): Promise<Response> => {
    if (++calls >= hangFrom) {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (!signal) throw new Error("indexKnowledgeDoc must pass an abort signal")
        signal.addEventListener("abort", () => reject(new Error("aborted")))
      })
    }
    const prompt = promptOf(init)
    if (prompt.includes("outline of its sections")) {
      return Promise.resolve(reply({ docSummary: "The whole book." }))
    }
    const ids = [...prompt.matchAll(SECTION_ID)].map((m) => m[1])
    asked.push(...ids)
    return Promise.resolve(reply({ nodes: ids.map((id) => ({ id, summary: `about ${id}` })) }))
  })
  return { fetch, asked, sectionRequests: () => calls }
}

describe("the indexing budget (AQU-2050)", () => {
  it("is derived from the platform's waitUntil window, with margin for the terminal write", () => {
    expect(KB_WAITUNTIL_WINDOW_MS).toBe(30_000)
    expect(KB_INDEX_BUDGET_MS).toBeLessThan(KB_WAITUNTIL_WINDOW_MS)
    // Enough left for the `ready` write, its log line and the propagation.
    expect(KB_WAITUNTIL_WINDOW_MS - KB_INDEX_BUDGET_MS).toBeGreaterThanOrEqual(5_000)
    // The old ceiling sat *above* the window, which is the bug.
    expect(KB_INDEX_BUDGET_MS).not.toBe(60_000)
  })
})

describe("carryOverSummaries", () => {
  const text = "# A\nalpha body\n# B\nbeta body"

  it("keeps a stored summary for the same section and ignores the rest", () => {
    const stored = segmentText(text)
    stored[0].summary = "about A"
    const kept = carryOverSummaries(segmentText(text), stored)
    expect([...kept]).toEqual([[stored[0].id, "about A"]])
  })

  it("refuses a summary whose section has moved, so it never lands on the wrong one", () => {
    const stored = segmentText(text).map((n) => ({ ...n, title: "something else", summary: "stale" }))
    expect(carryOverSummaries(segmentText(text), stored).size).toBe(0)
    expect(carryOverSummaries(segmentText(text), null).size).toBe(0)
  })
})

describe("describeIncomplete", () => {
  const err = new Error("openrouter 500")

  it("names what is still owed and that the retry continues from there", () => {
    const reason = describeIncomplete(err, 22, 31, false)
    expect(reason).toContain("Summaries are missing for 9 of 31 sections")
    expect(reason).toContain("Try indexing again")
  })

  it("asks only for the document summary when every section has one", () => {
    expect(describeIncomplete(err, 31, 31, false)).toContain("adds the document summary")
  })

  it("stays the bare cause when nothing landed — there is nothing to continue from", () => {
    expect(describeIncomplete(err, 0, 31, false)).toBe("The summarizing model returned HTTP 500.")
  })
})

describe("indexKnowledgeDoc — a run the deadline cuts short", () => {
  const DOC = "77777777-7777-7777-7777-777777777777"

  async function seed(extractedText = largeDoc()): Promise<void> {
    await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by) VALUES (?, ?, ?)")
      .bind("proj-deadline", "P", 1).run()
    await createDoc(env.AQUILLA_PG, {
      id: DOC, scope: { projectId: "proj-deadline" }, name: "art-of-survival.md",
      contentType: "text/markdown", sizeBytes: extractedText.length, sha256: "s",
      r2Key: "kb/project/proj-deadline/" + DOC, extractedText, createdBy: "test-user",
    })
  }

  /** Runs out of budget with the first two batches back. */
  async function partialRun(): Promise<void> {
    const partial = model({ hangFrom: 3 })
    vi.stubGlobal("fetch", partial.fetch)
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})
    await indexKnowledgeDoc({ OPENROUTER_API_KEY: "k" }, env.AQUILLA_PG, DOC, { timeoutMs: 300 })
    logged.mockRestore()
  }

  it("lands ready with the summaries that arrived, never pending, and says how far it got", async () => {
    await seed()

    await partialRun()

    const res = await getDocTree(env.AQUILLA_PG, DOC)
    // The one outcome this ticket exists to rule out.
    expect(res?.meta.indexStatus).not.toBe("pending")
    expect(res?.meta.indexStatus).toBe("ready")
    const summarized = flatNodes(res?.tree ?? []).filter((n) => n.summary)
    expect(summarized).toHaveLength(2 * KB_ENRICH_BATCH_NODES)
    expect(res?.meta.indexError).toContain("did not answer within")
    expect(res?.meta.indexError).toContain(`Summaries are missing for ${200 - summarized.length} of 200 sections`)
    expect(res?.meta.indexError).toContain("Try indexing again")
    expect(res?.meta.docSummary).toBeNull()
  })

  it("the retry asks only for the sections still missing, then writes the document summary", async () => {
    await seed()
    await partialRun()
    const before = flatNodes((await getDocTree(env.AQUILLA_PG, DOC))?.tree ?? [])
      .filter((n) => n.summary).map((n) => n.id)

    const retry = model()
    vi.stubGlobal("fetch", retry.fetch)
    await indexKnowledgeDoc({ OPENROUTER_API_KEY: "k" }, env.AQUILLA_PG, DOC)

    // Nothing already paid for is asked for a second time.
    expect(retry.asked).toHaveLength(200 - before.length)
    expect(retry.asked.some((id) => before.includes(id))).toBe(false)

    const res = await getDocTree(env.AQUILLA_PG, DOC)
    const flat = flatNodes(res?.tree ?? [])
    expect(flat).toHaveLength(200)
    expect(flat.every((n) => n.summary)).toBe(true)
    expect(res?.meta.docSummary).toBe("The whole book.")
    expect(res?.meta.indexError).toBeNull()
  })

  it("re-indexing a complete row costs no model requests and changes nothing", async () => {
    await seed()
    const first = model()
    vi.stubGlobal("fetch", first.fetch)
    await indexKnowledgeDoc({ OPENROUTER_API_KEY: "k" }, env.AQUILLA_PG, DOC)
    const done = await getDocTree(env.AQUILLA_PG, DOC)

    const again = model()
    vi.stubGlobal("fetch", again.fetch)
    await indexKnowledgeDoc({ OPENROUTER_API_KEY: "k" }, env.AQUILLA_PG, DOC)

    expect(again.fetch).not.toHaveBeenCalled()
    const res = await getDocTree(env.AQUILLA_PG, DOC)
    expect(res?.tree).toEqual(done?.tree)
    expect(res?.meta.docSummary).toBe("The whole book.")
    expect(res?.meta.indexError).toBeNull()
  })

  it("the degraded log carries how far the run got, so a deadline reads differently from a 400", async () => {
    await seed()
    const shipped: { event: string; attrs: Record<string, number | string> }[] = []
    const partial = model({ hangFrom: 3 })
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      if (!String(url).includes("/i/v1/logs")) return partial.fetch(url, init)
      const body = JSON.parse(String(init?.body)) as {
        resourceLogs: { scopeLogs: { logRecords: {
          body: { stringValue: string }
          attributes: { key: string; value: { intValue?: number; stringValue?: string } }[]
        }[] }[] }[]
      }
      const record = body.resourceLogs[0].scopeLogs[0].logRecords[0]
      shipped.push({
        event: record.body.stringValue,
        attrs: Object.fromEntries(record.attributes.map(
          (a) => [a.key, a.value.intValue ?? a.value.stringValue ?? ""],
        )),
      })
      return Promise.resolve(new Response("{}"))
    }))
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})

    await indexKnowledgeDoc(
      { OPENROUTER_API_KEY: "k", POSTHOG_KEY: "phc_test" }, env.AQUILLA_PG, DOC, { timeoutMs: 300 },
    )

    const degraded = shipped.find((l) => l.event === "kb-index-degraded")
    expect(degraded?.attrs["kb.sections_total"]).toBe(200)
    expect(degraded?.attrs["kb.sections_done"]).toBe(2 * KB_ENRICH_BATCH_NODES)
    logged.mockRestore()
  })
})
