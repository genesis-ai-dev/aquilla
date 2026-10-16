import { env } from "cloudflare:test"
import { describe, it, expect, vi, afterEach } from "vitest"
import { segmentText, applyEnrichment, indexKnowledgeDoc } from "../lib/knowledge/index-doc"
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

  it("upstream failure → status failed, never throws", async () => {
    await seed()
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })))
    await indexKnowledgeDoc({ OPENROUTER_API_KEY: "k" }, env.AQUILLA_PG, DOC)
    expect((await getDocMeta(env.AQUILLA_PG, DOC))?.indexStatus).toBe("failed")
  })

  it("no API key → status failed (dev without key degrades, not crashes)", async () => {
    await seed()
    await indexKnowledgeDoc({}, env.AQUILLA_PG, DOC)
    expect((await getDocMeta(env.AQUILLA_PG, DOC))?.indexStatus).toBe("failed")
  })
  // AQU-1376: the two ways a doc used to end up stranded at `pending` forever.
  it("hung upstream is aborted by the timeout → failed, not left pending", async () => {
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

    expect((await getDocMeta(env.AQUILLA_PG, DOC))?.indexStatus).toBe("failed")
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
