import { env } from "cloudflare:test"
import { describe, it, expect, vi, afterEach } from "vitest"
import { segmentText, applyEnrichment, indexKnowledgeDoc } from "../lib/knowledge/index-doc"
import { createDoc, getDocTree, getDocMeta } from "../../../db/shared/knowledge"

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
      extractedText: "# A\nalpha body\n# B\nbeta body", createdBy: "ryder",
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
