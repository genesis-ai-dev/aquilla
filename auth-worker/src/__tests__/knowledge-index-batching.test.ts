import { env } from "cloudflare:test"
import { describe, it, expect, vi, afterEach } from "vitest"
import {
  segmentText, batchSections, buildEnrichmentPrompt, indexKnowledgeDoc, describeIndexFailure,
  KB_ENRICH_BATCH_CHARS, KB_ENRICH_BATCH_NODES,
} from "../lib/knowledge/index-doc"
import { createDoc, getDocTree, getDocMeta } from "../../../db/shared/knowledge"
import type { KnowledgeNode } from "../../../db/shared/knowledge"

// AQU-2029: the model leg sent every section in one prompt. 200 sections of
// fully-vowelled Arabic (VanDyck_OT_1_Law_History.txt, 1.9M chars, on dev)
// came to 217,696 tokens against Haiku's 200,000, the provider answered 400,
// and every large reference document indexed without summaries while the
// uploader was told only "returned HTTP 400".

afterEach(() => vi.unstubAllGlobals())

/** 200 headed sections with ~1,200 chars of body each — the shape that used to
 *  become a single ~240k-char prompt. */
function largeDoc(sections = 200): string {
  return Array.from({ length: sections }, (_, i) =>
    `# Section ${i + 1}\n${`verse ${i + 1} `.repeat(120).slice(0, 1200)}`).join("\n")
}

function flatNodes(nodes: KnowledgeNode[]): KnowledgeNode[] {
  return nodes.flatMap((n) => [n, ...flatNodes(n.children ?? [])])
}

function flatIds(nodes: KnowledgeNode[]): string[] {
  return flatNodes(nodes).map((n) => n.id)
}

const SECTION_ID = /^(n[\d.]+): "/gm

function reply(content: unknown): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }))
}

function promptOf(init?: RequestInit): string {
  return (JSON.parse(String(init?.body)) as { messages: { content: string }[] }).messages[0].content
}

/** Answers every section request with a summary per id it names, and the
 *  closing outline request with a document summary. */
function summarizingModel() {
  const sectionPrompts: string[] = []
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    const prompt = promptOf(init)
    if (prompt.includes("outline of its sections")) return reply({ docSummary: "The whole book." })
    sectionPrompts.push(prompt)
    const ids = [...prompt.matchAll(SECTION_ID)].map((m) => m[1])
    return reply({ nodes: ids.map((id) => ({ id, summary: `about ${id}` })) })
  })
  return { fetch, sectionPrompts }
}

describe("batchSections", () => {
  it("splits a 200-section document into bounded batches covering every section once", () => {
    const text = largeDoc()
    const tree = segmentText(text)
    expect(flatIds(tree)).toHaveLength(200)

    const batches = batchSections(text, tree)

    expect(batches.length).toBeGreaterThan(1)
    for (const batch of batches) expect(batch.length).toBeLessThanOrEqual(KB_ENRICH_BATCH_NODES)
    expect(batches.flat().map((n) => n.id)).toEqual(flatIds(tree))
  })

  it("keeps a small document in one batch", () => {
    const text = "# A\nalpha body\n# B\nbeta body"
    expect(batchSections(text, segmentText(text))).toHaveLength(1)
  })

  it("caps a single oversized title so every prompt stays under the budget", () => {
    const text = `# ${"t".repeat(100_000)}\nbody\n# B\nbeta`
    for (const batch of batchSections(text, segmentText(text))) {
      expect(buildEnrichmentPrompt("d", text, batch).length).toBeLessThan(KB_ENRICH_BATCH_CHARS)
    }
  })
})

describe("describeIndexFailure — context overflow (AQU-2029)", () => {
  it("names the document's size instead of a status code", () => {
    // Verbatim from OpenRouter for the dev upload, via upstreamDetail.
    const err = new Error('openrouter 400: {"message":"prompt is too long: 217696 tokens > 200000 maximum"}')
    expect(describeIndexFailure(err))
      .toBe("This document is too large for the summarizing model to read in one pass.")
    expect(describeIndexFailure(new Error("openrouter 413"))).toContain("too large")
  })

  it("leaves other 400s generic and never echoes the provider's words", () => {
    const reason = describeIndexFailure(new Error("openrouter 400: invalid model id sk-or-secret"))
    expect(reason).toBe("The summarizing model returned HTTP 400.")
  })
})

describe("indexKnowledgeDoc — large documents", () => {
  const DOC = "99999999-9999-9999-9999-999999999999"

  async function seed(extractedText: string): Promise<void> {
    await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by) VALUES (?, ?, ?)")
      .bind("proj-big", "P", 1).run()
    await createDoc(env.AQUILLA_PG, {
      id: DOC, scope: { projectId: "proj-big" }, name: "big.md", contentType: "text/markdown",
      sizeBytes: extractedText.length, sha256: "s", r2Key: "kb/project/proj-big/" + DOC,
      extractedText, createdBy: "test-user",
    })
  }

  it("summarizes a 200-section document in batches, each under the budget, then the whole", async () => {
    await seed(largeDoc())
    const model = summarizingModel()
    vi.stubGlobal("fetch", model.fetch)

    await indexKnowledgeDoc({ OPENROUTER_API_KEY: "k" }, env.AQUILLA_PG, DOC)

    const res = await getDocTree(env.AQUILLA_PG, DOC)
    expect(res?.meta.indexStatus).toBe("ready")
    expect(res?.meta.indexError).toBeNull()
    expect(res?.meta.docSummary).toBe("The whole book.")
    const flat = flatNodes(res?.tree ?? [])
    expect(flat).toHaveLength(200)
    expect(flat.every((n) => n.summary === `about ${n.id}`)).toBe(true)

    // The single prompt this used to send was ~240k chars.
    expect(model.sectionPrompts.length).toBeGreaterThan(1)
    for (const prompt of model.sectionPrompts) {
      expect(prompt.length).toBeLessThan(KB_ENRICH_BATCH_CHARS + 1_000)
      expect(prompt).not.toContain("docSummary")
    }
    const requested = model.sectionPrompts.flatMap((p) => [...p.matchAll(SECTION_ID)].map((m) => m[1]))
    expect(requested).toEqual(flat.map((n) => n.id))
    expect(model.fetch).toHaveBeenCalledTimes(model.sectionPrompts.length + 1)
  })

  it("a small document still takes exactly one call", async () => {
    await seed("# A\nalpha body\n# B\nbeta body")
    const fetch = vi.fn(async () => reply({ docSummary: "doc sum", nodes: [{ id: "n1", summary: "sa" }] }))
    vi.stubGlobal("fetch", fetch)

    await indexKnowledgeDoc({ OPENROUTER_API_KEY: "k" }, env.AQUILLA_PG, DOC)

    expect(fetch).toHaveBeenCalledTimes(1)
    expect((await getDocMeta(env.AQUILLA_PG, DOC))?.docSummary).toBe("doc sum")
  })

  it("one failed batch degrades the whole leg: structure kept, no partial summaries", async () => {
    await seed(largeDoc())
    const model = summarizingModel()
    let calls = 0
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) =>
      ++calls === 3 ? new Response("boom", { status: 500 }) : model.fetch(url, init)))
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})

    await indexKnowledgeDoc({ OPENROUTER_API_KEY: "k" }, env.AQUILLA_PG, DOC)

    const res = await getDocTree(env.AQUILLA_PG, DOC)
    expect(res?.meta.indexStatus).toBe("ready")
    expect(res?.meta.indexError).toBe("The summarizing model returned HTTP 500.")
    expect(res?.meta.docSummary).toBeNull()
    expect(res?.tree).toHaveLength(200)
    expect(res?.tree?.some((n) => n.summary)).toBe(false)
    logged.mockRestore()
  })

  it("a context overflow that still gets through is reported in plain words", async () => {
    await seed(largeDoc())
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: {
        message: "Provider returned error",
        code: 400,
        metadata: { raw: '{"message":"prompt is too long: 217696 tokens > 200000 maximum"}', provider_name: "Amazon Bedrock" },
      },
    }), { status: 400 })))
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})

    await indexKnowledgeDoc({ OPENROUTER_API_KEY: "k" }, env.AQUILLA_PG, DOC)

    expect((await getDocMeta(env.AQUILLA_PG, DOC))?.indexError)
      .toBe("This document is too large for the summarizing model to read in one pass.")
    // The provider's own words reach the log, so the next 400 is diagnosable.
    expect(logged.mock.calls.some((call) => String(call[1]).includes("prompt is too long"))).toBe(true)
    logged.mockRestore()
  })
})
