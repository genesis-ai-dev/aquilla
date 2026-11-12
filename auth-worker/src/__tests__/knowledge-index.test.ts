import { env } from "cloudflare:test"
import { describe, it, expect, vi, afterEach } from "vitest"
import {
  segmentText, applyEnrichment, indexKnowledgeDoc, describeIndexFailure,
} from "../lib/knowledge/index-doc"
import { indexDocOnOwnConnection, openIndexingConnection, type IndexingConnection } from "../routes/knowledge"
import { createDoc, getDocTree, getDocMeta } from "../../../db/shared/knowledge"
import type { Env } from "../types"

afterEach(() => vi.unstubAllGlobals())

describe("segmentText", () => {
  it("builds a node per markdown heading with correct char ranges, nested by level", () => {
    const text = "# One\naaa\n## One-sub\nbbb\n# Two\nccc"
    const tree = segmentText(text)
    expect(tree).toHaveLength(2)
    expect(tree[0].title).toBe("One")
    expect(tree[0].children?.[0].title).toBe("One-sub")
    expect(text.slice(tree[1].charStart, tree[1].charEnd)).toBe("# Two\nccc")
  })

  it("headingless text falls back to ~2000-char paragraph blocks", () => {
    const text = Array.from({ length: 40 }, (_, i) => `para ${i} ${"x".repeat(200)}`).join("\n\n")
    const tree = segmentText(text)
    expect(tree.length).toBeGreaterThan(1)
    // ranges tile the text: each block starts where the previous ended (modulo separators)
    expect(tree[0].charStart).toBe(0)
    expect(tree[tree.length - 1].charEnd).toBe(text.length)
  })

  it("caps node count at 200", () => {
    const text = Array.from({ length: 500 }, (_, i) => `# H${i}\nbody`).join("\n")
    expect(segmentText(text).length).toBeLessThanOrEqual(200)
  })
})

describe("applyEnrichment", () => {
  it("merges summaries + docSummary by node id and ignores unknown ids", () => {
    const nodes = [{ id: "n1", title: "One", charStart: 0, charEnd: 5 }]
    const raw = JSON.stringify({ docSummary: "About things.", nodes: [{ id: "n1", summary: "s1" }, { id: "nx", summary: "ignored" }] })
    const { tree, docSummary } = applyEnrichment(nodes, raw)
    expect(docSummary).toBe("About things.")
    expect(tree[0].summary).toBe("s1")
  })

  it("throws on non-JSON", () => {
    expect(() => applyEnrichment([], "not json")).toThrow()
  })
})

// AQU-2002: these sentences are rendered verbatim in the knowledge-base list,
// so they have to read as advice and may name no internals.
describe("describeIndexFailure", () => {
  it("names the fix for each failure a run can hit", () => {
    expect(describeIndexFailure(new Error("no OPENROUTER_API_KEY")))
      .toBe("No summarizing model is configured in this environment.")
    expect(describeIndexFailure(new Error("openrouter 402"))).toContain("out of credit")
    expect(describeIndexFailure(new Error("openrouter 429"))).toContain("rate-limiting")
    expect(describeIndexFailure(new Error("openrouter 401"))).toContain("credentials")
    expect(describeIndexFailure(new SyntaxError("Unexpected token")))
      .toContain("could not be read")
    const aborted = new Error("The operation was aborted")
    aborted.name = "AbortError"
    expect(describeIndexFailure(aborted)).toContain("did not answer within")
  })

  it("never leaks the underlying error text", () => {
    const reason = describeIndexFailure(
      new Error('relation "knowledge_docs" does not exist at 0x7f'),
    )
    expect(reason).toBe("The summarizing step failed for an unexpected reason.")
  })
})

describe("indexKnowledgeDoc", () => {
  const DOC = "88888888-8888-8888-8888-888888888888"
  async function seed() {
    await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by) VALUES (?, ?, ?)")
      .bind("proj-idx", "P", 1).run()
    await createDoc(env.AQUILLA_PG, {
      id: DOC, scope: { projectId: "proj-idx" }, name: "g.md", contentType: "text/markdown",
      sizeBytes: 10, sha256: "s", r2Key: "kb/project/proj-idx/" + DOC,
      extractedText: "# A\nalpha body\n# B\nbeta body", createdBy: "test-user",
    })
  }

  it("happy path: one OpenRouter call → status ready with enriched tree", async () => {
    await seed()
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ docSummary: "doc sum", nodes: [{ id: "n1", summary: "sa" }] }) } }],
    }))))
    await indexKnowledgeDoc({ OPENROUTER_API_KEY: "k" }, env.AQUILLA_PG, DOC)
    const res = await getDocTree(env.AQUILLA_PG, DOC)
    expect(res?.meta.indexStatus).toBe("ready")
    expect(res?.meta.docSummary).toBe("doc sum")
    expect(res?.tree?.[0].summary).toBe("sa")
  })

  // AQU-2002: the model leg only writes summaries, so losing it cannot mean
  // the document failed to index. It used to: the heuristic tree was discarded,
  // the row was parked at `failed` with nothing recorded, and the retry button
  // the badge offered ran the same doomed call again — the LOTE knowledge
  // base's "never indexes, re-index also fails, no error shown".
  it("upstream failure → ready WITHOUT summaries, keeping the structure, reason recorded", async () => {
    await seed()
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })))
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})

    await indexKnowledgeDoc({ OPENROUTER_API_KEY: "k" }, env.AQUILLA_PG, DOC)

    const res = await getDocTree(env.AQUILLA_PG, DOC)
    expect(res?.meta.indexStatus).toBe("ready")
    // The two markdown headings of the seeded doc are still navigable.
    expect(res?.tree?.map((n) => n.title)).toEqual(["A", "B"])
    expect(res?.tree?.[0].summary).toBeUndefined()
    expect(res?.meta.docSummary).toBeNull()
    expect(res?.meta.indexError).toBe("The summarizing model returned HTTP 500.")
    logged.mockRestore()
  })

  it("a billing rejection names the account, not a status code the uploader cannot act on", async () => {
    await seed()
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no credit", { status: 402 })))
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})

    await indexKnowledgeDoc({ OPENROUTER_API_KEY: "k" }, env.AQUILLA_PG, DOC)

    expect((await getDocMeta(env.AQUILLA_PG, DOC))?.indexError).toContain("out of credit")
    logged.mockRestore()
  })

  it("no API key → ready without summaries, saying so (dev without a key degrades)", async () => {
    await seed()
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})

    await indexKnowledgeDoc({}, env.AQUILLA_PG, DOC)

    const meta = await getDocMeta(env.AQUILLA_PG, DOC)
    expect(meta?.indexStatus).toBe("ready")
    expect(meta?.indexError).toBe("No summarizing model is configured in this environment.")
    logged.mockRestore()
  })

  it("a doc with no extractable text is failed, with a reason no retry can clear", async () => {
    await seed()
    // Upload rejects text-free files, but an inherited copy or a hand-edited
    // row can still reach the job this way.
    await env.AQUILLA_PG.prepare("UPDATE knowledge_docs SET extracted_text = '' WHERE id = ?")
      .bind(DOC).run()
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})

    await indexKnowledgeDoc({ OPENROUTER_API_KEY: "k" }, env.AQUILLA_PG, DOC)

    const meta = await getDocMeta(env.AQUILLA_PG, DOC)
    expect(meta?.indexStatus).toBe("failed")
    expect(meta?.indexError).toContain("no extractable text")
    logged.mockRestore()
  })

  it("a clean run clears the reason left by the run before it", async () => {
    await seed()
    await indexKnowledgeDoc({}, env.AQUILLA_PG, DOC) // no key → degraded
    expect((await getDocMeta(env.AQUILLA_PG, DOC))?.indexError).not.toBeNull()

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ docSummary: "doc sum", nodes: [] }) } }],
    }))))
    await indexKnowledgeDoc({ OPENROUTER_API_KEY: "k" }, env.AQUILLA_PG, DOC)

    const meta = await getDocMeta(env.AQUILLA_PG, DOC)
    expect(meta?.indexStatus).toBe("ready")
    expect(meta?.indexError).toBeNull()
  })

  // AQU-2002: PostHog had zero events from this pipeline over the week the
  // LOTE uploads were stuck, so "never indexed" could only be investigated by
  // reading rows by hand. Every run now says it started and how it ended.
  it("ships a start event and a terminal event for each run", async () => {
    await seed()
    const shipped: string[] = []
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/i/v1/logs")) {
        const body = JSON.parse(String(init?.body)) as {
          resourceLogs: { scopeLogs: { logRecords: { body: { stringValue: string } }[] }[] }[]
        }
        shipped.push(body.resourceLogs[0].scopeLogs[0].logRecords[0].body.stringValue)
        return new Response("{}")
      }
      return new Response("boom", { status: 500 })
    }))
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})

    await indexKnowledgeDoc(
      { OPENROUTER_API_KEY: "k", POSTHOG_KEY: "phc_test" }, env.AQUILLA_PG, DOC,
    )

    expect(shipped).toEqual(["kb-index-started", "kb-index-degraded"])
    logged.mockRestore()
  })
  // AQU-1376: the two ways a doc used to end up stranded at `pending` forever.
  it("hung upstream is aborted by the timeout → terminal, not left pending", async () => {
    await seed()
    // Stands in for a response that never arrives: settles only when the job's
    // own AbortController fires, which is exactly what real fetch does.
    const hang = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      if (!signal) throw new Error("indexKnowledgeDoc must pass an abort signal")
      signal.addEventListener("abort", () => reject(new Error("aborted")))
    }))
    vi.stubGlobal("fetch", hang)
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})

    await indexKnowledgeDoc({ OPENROUTER_API_KEY: "k" }, env.AQUILLA_PG, DOC, { timeoutMs: 20 })

    // Terminal either way; since AQU-2002 the structure survives the hang and
    // only the summaries are reported missing.
    const meta = await getDocMeta(env.AQUILLA_PG, DOC)
    expect(meta?.indexStatus).toBe("ready")
    expect(meta?.indexError).toContain("did not answer within")
    expect(logged).toHaveBeenCalled()
    logged.mockRestore()
  })

  it("logs when the compensating 'failed' write is itself what fails", async () => {
    await seed()
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })))
    // A db whose writes reject — the case where nothing is left to move the row
    // off `pending`, so the log is the only trace of it.
    const brokenDb = {
      prepare: () => ({
        bind: () => ({
          run: async () => { throw new Error("connection lost") },
          first: async () => { throw new Error("connection lost") },
          all: async () => { throw new Error("connection lost") },
        }),
      }),
    } as unknown as typeof env.AQUILLA_PG
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})

    // Reads come from the real db, the failing write from the broken one, so the
    // job gets all the way to the compensating write before it blows up.
    const db = {
      prepare: (sql: string) =>
        /^\s*update/i.test(sql) ? brokenDb.prepare(sql) : env.AQUILLA_PG.prepare(sql),
    } as unknown as typeof env.AQUILLA_PG

    await expect(indexKnowledgeDoc({ OPENROUTER_API_KEY: "k" }, db, DOC)).resolves.toBeUndefined()

    const messages = logged.mock.calls.map((call) => String(call[0]))
    expect(messages.some((m) => m.includes("could not mark doc"))).toBe(true)
    // The original cause is logged too, not lost behind the write failure.
    expect(messages.some((m) => m.includes("indexing doc"))).toBe(true)
    logged.mockRestore()
  })
})

// AQU-1763: the connection the indexing job runs on. The job is started with
// ctx.waitUntil and then awaits a model round-trip of up to 60s, but index.ts
// closes the request-scoped AQUILLA_PG shim as soon as the Response returns
// (postgres.js end({ timeout: 5 })). Running on that shim meant the terminal
// index_status write — and the compensating 'failed' write in its catch — both
// hit a destroyed pool, so every doc stayed `pending` forever and the UI showed
// "Indexing…" / "Indexing stalled" for documents that were never indexed.
//
// These tests sit at the boundary the bug escaped through: the unit tests above
// all pass a live db straight in, and the route tests inject AQUILLA_PG with no
// PG_CONNECTION_STRING, so neither could ever see the closed-shim shape.
describe("indexDocOnOwnConnection", () => {
  const DOC = "77777777-7777-7777-7777-777777777777"

  async function seedDoc(): Promise<void> {
    await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by) VALUES (?, ?, ?)")
      .bind("proj-own-conn", "P", 1).run()
    await createDoc(env.AQUILLA_PG, {
      id: DOC, scope: { projectId: "proj-own-conn" }, name: "g.md", contentType: "text/markdown",
      sizeBytes: 10, sha256: "s", r2Key: "kb/project/proj-own-conn/" + DOC,
      extractedText: "# A\nalpha body\n# B\nbeta body", createdBy: "test-user",
    })
  }

  function stubEnrichmentOk(): void {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ docSummary: "doc sum", nodes: [] }) } }],
    }))))
  }

  /** Stands in for the request-scoped shim after index.ts has closed it. */
  function closedShim(): Env["AQUILLA_PG"] {
    const fail = async () => { throw new Error("write CONNECTION_DESTROYED") }
    return {
      prepare: () => ({ bind: () => ({ run: fail, first: fail, all: fail }) }),
    } as unknown as Env["AQUILLA_PG"]
  }

  it("indexes to a terminal status even though the request-scoped shim is already closed", async () => {
    await seedDoc()
    stubEnrichmentOk()
    const own: IndexingConnection = { db: env.AQUILLA_PG, close: async () => {} }

    await indexDocOnOwnConnection(
      { OPENROUTER_API_KEY: "k", PG_CONNECTION_STRING: "postgres://unused", AQUILLA_PG: closedShim() } as unknown as Env,
      DOC,
      () => own,
    )

    // On the request-scoped shim this write never lands and the row stays
    // `pending` — the exact state the LOTE project was stuck in.
    const res = await getDocTree(env.AQUILLA_PG, DOC)
    expect(res?.meta.indexStatus).toBe("ready")
    expect(res?.meta.docSummary).toBe("doc sum")
  })

  it("releases the job's connection only after the job has settled", async () => {
    await seedDoc()
    stubEnrichmentOk()
    const order: string[] = []
    const own: IndexingConnection = {
      // Every statement the job runs is recorded, so a close that landed first
      // would show up ahead of the writes instead of after them.
      db: new Proxy(env.AQUILLA_PG, {
        get(target, prop, receiver) {
          if (prop === "prepare") {
            return (sql: string) => { order.push("query"); return target.prepare(sql) }
          }
          return Reflect.get(target, prop, receiver) as unknown
        },
      }),
      close: async () => { order.push("close") },
    }

    await indexDocOnOwnConnection(
      { OPENROUTER_API_KEY: "k", PG_CONNECTION_STRING: "postgres://unused", AQUILLA_PG: closedShim() } as unknown as Env,
      DOC,
      () => own,
    )

    expect(order.filter((e) => e === "query").length).toBeGreaterThan(0)
    expect(order.at(-1)).toBe("close")
    expect(order.filter((e) => e === "close")).toHaveLength(1)
  })

  it("a connection that fails to close is logged, never raised past the job", async () => {
    await seedDoc()
    stubEnrichmentOk()
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})

    await expect(indexDocOnOwnConnection(
      { OPENROUTER_API_KEY: "k", PG_CONNECTION_STRING: "postgres://unused", AQUILLA_PG: closedShim() } as unknown as Env,
      DOC,
      () => ({ db: env.AQUILLA_PG, close: async () => { throw new Error("already destroyed") } }),
    )).resolves.toBeUndefined()

    expect((await getDocMeta(env.AQUILLA_PG, DOC))?.indexStatus).toBe("ready")
    expect(logged.mock.calls.some((call) => String(call[0]).includes("releasing the indexing connection"))).toBe(true)
    logged.mockRestore()
  })

  it("falls back to the injected AQUILLA_PG when there is no connection string to open", async () => {
    await seedDoc()
    stubEnrichmentOk()
    // The vitest harness and `wrangler dev` without Hyperdrive both land here:
    // no own connection is opened, and nothing closes the injected handle.
    expect(openIndexingConnection({})).toBeNull()

    await indexDocOnOwnConnection(
      { OPENROUTER_API_KEY: "k", AQUILLA_PG: env.AQUILLA_PG } as unknown as Env,
      DOC,
    )

    expect((await getDocMeta(env.AQUILLA_PG, DOC))?.indexStatus).toBe("ready")
  })
})
