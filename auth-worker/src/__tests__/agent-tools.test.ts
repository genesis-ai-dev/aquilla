// Semantic tools (read / examples / search / draft) — the recipes-as-code
// layer. WHY: these encode what the old prompt taught the model to derive by
// hand; each behavior pinned here (display order, ref scoping, status
// classification, validated-first retrieval, draft staging through the same
// lint path as a hand emit) is one the model can no longer get wrong.

import { env } from "cloudflare:test"
import { describe, it, expect, afterEach, vi } from "vitest"
import { seedUser } from "./helpers/db"
import { AliasMap } from "../lib/agent/compress"
import type { EmitStageContext } from "../lib/agent/emit-stage"
import { parseRefRange, orderPairs, statusOf, type CellPair } from "../lib/agent/tools/select-cells"
import { executeRead } from "../lib/agent/tools/read"
import { executeExamples, orTsquery } from "../lib/agent/tools/examples"
import { executeSearch } from "../lib/agent/tools/search"
import { executeDraft, parseDraftReply } from "../lib/agent/tools/draft"

const PROJECT = "11111111-1111-4111-8111-111111111111"
const FILE = "22222222-2222-4222-8222-222222222222"

const CELLS = [
  // cell_id suffix, ref, source, target, validated, seq
  { id: "c1", ref: "MRK 4:1", source: "And he began again to teach", target: "Y comenzó otra vez a enseñar", validated: 1 },
  { id: "c2", ref: "MRK 4:2", source: "And he taught them many things", target: "Y les enseñaba muchas cosas", validated: 0 },
  { id: "c3", ref: "MRK 4:3", source: "Listen! Behold, a sower went out to sow", target: "", validated: 0 },
  { id: "c10", ref: "MRK 4:10", source: "And when he was alone", target: "", validated: 0 },
] as const

function cellId(suffix: string): string {
  return `33333333-3333-4333-8333-${suffix.padStart(12, "0")}`
}

async function seedWorld() {
  await seedUser(1, "alice")
  await env.AQUILLA_PG.prepare(`INSERT INTO projects (id, name, created_by) VALUES (?, 'P', 1)`).bind(PROJECT).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO files (id, project_id, name, book_code, event_id) VALUES (?, ?, 'Mark', 'MRK', ?)`,
  )
    .bind(FILE, PROJECT, crypto.randomUUID())
    .run()
  for (const c of CELLS) {
    const id = cellId(c.id)
    await env.AQUILLA_PG.prepare(
      `INSERT INTO cells (project_id, file_id, cell_id, side, value, canonical_ref, event_id, last_edit_at)
       VALUES (?, ?, ?, 'source', ?, ?, ?, 0)`,
    )
      .bind(PROJECT, FILE, id, c.source, c.ref, crypto.randomUUID())
      .run()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO cells (project_id, file_id, cell_id, side, value, canonical_ref, event_id, validated, last_edit_at)
       VALUES (?, ?, ?, 'target', ?, ?, ?, ?, 0)`,
    )
      .bind(PROJECT, FILE, id, c.target, c.ref, crypto.randomUUID(), c.validated)
      .run()
  }
}

function toolCtx() {
  return { projectId: PROJECT, focusedFileId: FILE, aliases: new AliasMap() }
}

afterEach(() => vi.restoreAllMocks())

describe("parseRefRange / orderPairs / statusOf (pure)", () => {
  it("parses book / chapter / verse-range refs", () => {
    expect(parseRefRange("MRK")).toEqual({ book: "MRK" })
    expect(parseRefRange("mrk 4")).toEqual({ book: "MRK", chapter: 4 })
    expect(parseRefRange("MRK 4:5")).toEqual({ book: "MRK", chapter: 4, verseFrom: 5, verseTo: 5 })
    expect(parseRefRange("MRK 4:1-20")).toEqual({ book: "MRK", chapter: 4, verseFrom: 1, verseTo: 20 })
    expect(parseRefRange("1CO 13")).toEqual({ book: "1CO", chapter: 13 })
    expect(parseRefRange("garbage!!")).toBeNull()
  })

  it("orders scripture numerically (4:10 after 4:2, not lexically)", () => {
    const pair = (ref: string): CellPair => ({
      cellId: ref, canonicalRef: ref, sequenceIndex: null, anchorCellId: null,
      source: "s", target: "", validated: false, aiDrafted: false,
      sourceHead: null, targetBasedOn: null, hasTargetRow: false,
    })
    const ordered = orderPairs([pair("MRK 4:10"), pair("MRK 4:2"), pair("MRK 4:1")])
    expect(ordered.map((p) => p.canonicalRef)).toEqual(["MRK 4:1", "MRK 4:2", "MRK 4:10"])
  })

  it("classifies status: stale when the source head moved past the commit base", () => {
    const base: CellPair = {
      cellId: "x", canonicalRef: null, sequenceIndex: null, anchorCellId: null,
      source: "s", target: "t", validated: false, aiDrafted: false,
      sourceHead: "e2", targetBasedOn: "e1", hasTargetRow: true,
    }
    expect(statusOf(base)).toBe("stale")
    expect(statusOf({ ...base, targetBasedOn: "e2" })).toBe("translated")
    expect(statusOf({ ...base, target: "" })).toBe("untranslated")
    expect(statusOf({ ...base, validated: true })).toBe("validated")
    expect(statusOf({ ...base, targetBasedOn: "e2", aiDrafted: true })).toBe("drafted")
  })
})

describe("executeRead", () => {
  it("returns display-ordered rows with status, aliases in text, real ids in data", async () => {
    await seedWorld()
    const ctx = toolCtx()
    const out = await executeRead(env.AQUILLA_PG, { ref: "MRK 4" }, ctx)
    expect(out.ok).toBe(true)
    expect(out.data?.cells?.map((c) => c.ref)).toEqual(["MRK 4:1", "MRK 4:2", "MRK 4:3", "MRK 4:10"])
    expect(out.data?.cells?.[0]).toMatchObject({ cellId: cellId("c1"), status: "validated" })
    expect(out.data?.cells?.[2]).toMatchObject({ status: "untranslated" })
    // Model text carries aliases, never raw UUIDs.
    expect(out.text).toContain("#c1")
    expect(out.text).not.toContain(cellId("c1"))
  })

  it("scopes by verse range and filters by status", async () => {
    await seedWorld()
    const out = await executeRead(
      env.AQUILLA_PG,
      { ref: "MRK 4:1-5", filter: "untranslated" },
      toolCtx(),
    )
    expect(out.data?.cells).toHaveLength(1) // 4:10 outside range; only 4:3 untranslated
    expect(out.data?.cells?.[0].ref).toBe("MRK 4:3")
  })

  it("resolves the file by book code when no file is focused", async () => {
    await seedWorld()
    const out = await executeRead(env.AQUILLA_PG, { ref: "MRK 4:1" }, {
      projectId: PROJECT,
      aliases: new AliasMap(),
    })
    expect(out.ok).toBe(true)
    expect(out.data?.cells?.[0].ref).toBe("MRK 4:1")
  })
})

describe("executeExamples", () => {
  it("returns validated pairs first, matched by source-text similarity", async () => {
    await seedWorld()
    const out = await executeExamples(
      env.AQUILLA_PG,
      { text: "he began to teach them" },
      toolCtx(),
    )
    expect(out.ok).toBe(true)
    const pairs = out.data?.examples ?? []
    expect(pairs.length).toBeGreaterThanOrEqual(2)
    expect(pairs[0]).toMatchObject({ ref: "MRK 4:1", validated: true }) // validated leads
    expect(pairs.every((p) => p.target !== "")).toBe(true) // untranslated rows never appear
  })

  it("orTsquery builds an OR query and survives hostile input", () => {
    expect(orTsquery("He began, to teach!")).toBe("'he' | 'began' | 'to' | 'teach'")
    expect(orTsquery("x")).toBeNull()
    expect(orTsquery("don't o'clock")).toBe("'dont' | 'oclock'")
  })
})

describe("executeSearch", () => {
  it("finds cells by websearch text with side filtering", async () => {
    await seedWorld()
    const out = await executeSearch(env.AQUILLA_PG, { q: "sower", side: "source" }, toolCtx())
    expect(out.ok).toBe(true)
    expect(out.data?.hits).toHaveLength(1)
    expect(out.data?.hits?.[0]).toMatchObject({ side: "source", ref: "MRK 4:3" })
    const none = await executeSearch(env.AQUILLA_PG, { q: "sower", side: "target" }, toolCtx())
    expect(none.data?.hits).toHaveLength(0)
  })
})

describe("executeDraft", () => {
  function draftCtx(aliases = new AliasMap()) {
    const stageCtx: EmitStageContext = {
      runId: "run-1",
      projectId: PROJECT,
      roleLevel: 400,
      fileId: FILE,
      aliases,
    }
    const progress: { label: string; done: number; total: number }[] = []
    const usage: unknown[] = []
    return {
      ctx: {
        projectId: PROJECT,
        focusedFileId: FILE,
        aliases,
        stageCtx,
        sourceLanguage: "English",
        targetLanguage: "Spanish",
        briefSummary: "A clear, natural Spanish translation.",
        signal: new AbortController().signal,
        sendProgress: (label: string, done: number, total: number) => progress.push({ label, done, total }),
        addUsage: (u: unknown) => usage.push(u),
      },
      progress,
      usage,
    }
  }

  it("drafts untranslated cells via the model and stages them through emit-stage", async () => {
    await seedWorld()
    let draftRequest: { messages: { role: string; content: string }[] } | null = null
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      draftRequest = JSON.parse(String(init?.body))
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: '[{"i":1,"t":"¡Oíd! He aquí, el sembrador salió a sembrar"},{"i":2,"t":"Y cuando estuvo solo"}]',
              },
            },
          ],
          usage: { prompt_tokens: 500, completion_tokens: 60, cost: 0.0002 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    })

    const { ctx, progress, usage } = draftCtx()
    const out = await executeDraft(
      env.AQUILLA_PG,
      { ref: "MRK 4" },
      ctx,
      { model: "test/drafter", apiKey: "k", url: "https://mock/chat/completions" },
    )

    expect(out.ok).toBe(true)
    expect(out.proposal).toBeDefined()
    expect(out.proposal!.events).toHaveLength(2)
    expect(out.proposal!.events[0]).toMatchObject({
      kind: "target.cell.commit",
      cellId: cellId("c3"),
      payload: { ai_suggestion: true, agent_run_id: "run-1" },
    })
    expect(out.data?.cells?.map((c) => c.status)).toEqual(["drafted", "drafted"])
    expect(progress).toEqual([
      { label: "Drafting 2 cells", done: 0, total: 2 },
      { label: "Drafting 2 cells", done: 2, total: 2 },
    ])
    expect(usage).toHaveLength(1)

    // The drafting prompt carried the project's own pairs + language pair.
    const sys = draftRequest!.messages[0].content
    expect(sys).toContain("into Spanish")
    expect(sys).toContain("Y comenzó otra vez a enseñar") // exemplar rode along
    expect(draftRequest!.messages[1].content).toContain("1. [MRK 4:3]")
  })

  it("reports scope exhaustion and remaining work honestly", async () => {
    await seedWorld()
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: '[{"i":1,"t":"borrador"}]' } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    )
    const { ctx } = draftCtx()
    const out = await executeDraft(
      env.AQUILLA_PG,
      { ref: "MRK 4", limit: 1 },
      ctx,
      { model: "m", apiKey: "k", url: "https://mock/x" },
    )
    expect(out.ok).toBe(true)
    expect(out.text).toContain("1 more untranslated cells remain")

    const done = await executeDraft(
      env.AQUILLA_PG,
      { ref: "MRK 4:1-2" }, // both already translated
      ctx,
      { model: "m", apiKey: "k", url: "https://mock/x" },
    )
    expect(done.text).toContain("Nothing to draft")
  })
})
