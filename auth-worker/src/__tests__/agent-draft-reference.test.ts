// AQU-1573: the agent's drafting pipeline copies cited verses from the lane's
// reference Bible. Living on the Edge drafts Arabic sermons through the
// in-app agent and the Agent API's DraftCells (both run generateDrafts); a
// sermon line that quotes "Isaiah 40:25" must reach BOTH model passes with the
// Van Dyck wording and a MUST-copy instruction — with Bible resources off —
// and a sermon must not be called "a scripture translation project".

import { env } from "cloudflare:test"
import { describe, it, expect, afterEach, vi } from "vitest"
import { seedUser } from "./helpers/db"
import { AliasMap } from "../lib/agent/compress"
import type { EmitStageContext } from "../lib/agent/emit-stage"
import { executeDraft, isScriptureRef } from "../lib/agent/tools/draft"
import { installFixtureReferenceBibles } from "../../../db/shared/reference-bible-fixtures"
import { lookupPassages } from "../../../db/shared/reference-bible"
import { REFERENCE_VERSES_HEADING } from "../../../src/lib/completion/prompt-build"

const PROJECT = "44444444-4444-4444-8444-444444444444"
const FILE = "55555555-5555-4555-8555-555555555555"

function cellId(n: number): string {
  return `66666666-6666-4666-8666-${String(n).padStart(12, "0")}`
}

async function seedProject(opts: {
  settings: Record<string, unknown>
  cells: { source: string; ref?: string }[]
  bookCode?: string
}) {
  await seedUser(1, "alice")
  await env.AQUILLA_PG.prepare(`INSERT INTO projects (id, name, created_by) VALUES (?, 'Sermons', 1)`).bind(PROJECT).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO files (id, project_id, name, book_code, event_id) VALUES (?, ?, 'The Journey', ?, ?)`,
  )
    .bind(FILE, PROJECT, opts.bookCode ?? null, crypto.randomUUID())
    .run()
  for (const [i, c] of opts.cells.entries()) {
    await env.AQUILLA_PG.prepare(
      `INSERT INTO cells (project_id, file_id, cell_id, side, value, canonical_ref, sequence_index, event_id, last_edit_at)
       VALUES (?, ?, ?, 'source', ?, ?, ?, ?, 0)`,
    )
      .bind(PROJECT, FILE, cellId(i + 1), c.source, c.ref ?? null, i, crypto.randomUUID())
      .run()
  }
  await env.AQUILLA_PG.prepare(
    `INSERT INTO project_settings (project_id, settings, version, updated_by, updated_at)
     VALUES (?, ?::text::jsonb, 1, 1, now())`,
  )
    .bind(PROJECT, JSON.stringify(opts.settings))
    .run()
}

/** Both passes answer; returns every request body the drafting model got. */
function mockModel(count: number) {
  const requests: { messages: { role: string; content: string }[] }[] = []
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)))
    const content =
      requests.length === 1
        ? "Evidence: copy the cited verse from the block."
        : JSON.stringify(Array.from({ length: count }, (_, i) => ({ i: i + 1, t: `مسودة ${i + 1}` })))
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })
  })
  return requests
}

function ctx(lane = "") {
  const aliases = new AliasMap()
  const stageCtx: EmitStageContext = { runId: "run-1", projectId: PROJECT, roleLevel: 400, fileId: FILE, lane, aliases }
  return {
    projectId: PROJECT,
    focusedFileId: FILE,
    lane,
    aliases,
    stageCtx,
    sourceLanguage: "English",
    targetLanguage: "Arabic",
    signal: new AbortController().signal,
    sendProgress: () => {},
    addUsage: () => {},
  }
}

const MODEL = { model: "test/drafter", apiKey: "k", url: "https://mock/chat/completions" }
const SERMON = [
  { source: "Who is God?" },
  { source: 'Isaiah 40:25 says, "To whom will you compare me? Or who is my equal?" says the Holy One.' },
  { source: "Romans 8:28; John 3:16 show us his love." },
]
const LOTE_SETTINGS = {
  sourceLanguage: "English",
  targetLanguage: "Arabic",
  targetLanes: ["en"],
  bibleResourcesEnabled: false,
  referenceBibleVersions: { "": "arb-vandyck", en: "eng-kjv" },
}

async function verse(versionId: string, canonical: string): Promise<string> {
  const { passages } = await lookupPassages(env.AQUILLA_PG, versionId, [canonical])
  return passages[0].verses.map((v) => v.text).join(" ")
}

afterEach(() => vi.restoreAllMocks())

describe("agent draft — reference Bible verses (AQU-1573)", () => {
  it("puts the cited Van Dyck verses in both passes, with Bible resources off", async () => {
    await installFixtureReferenceBibles(env.AQUILLA_PG)
    await seedProject({ settings: LOTE_SETTINGS, cells: SERMON })
    const requests = mockModel(3)

    const out = await executeDraft(env.AQUILLA_PG, {}, ctx(), MODEL)
    expect(out.ok).toBe(true)
    expect(requests).toHaveLength(2)

    const isa = await verse("arb-vandyck", "ISA 40:25")
    const rom = await verse("arb-vandyck", "ROM 8:28")
    const jhn = await verse("arb-vandyck", "JHN 3:16")
    for (const request of requests) {
      const system = request.messages[0].content
      expect(system).toContain(`${REFERENCE_VERSES_HEADING}Van Dyck (Arabic) (MUST follow):`)
      expect(system).toContain(`- Isaiah 40:25 [ISA 40:25]: ${isa}`)
      expect(system).toContain(`[ROM 8:28]: ${rom}`)
      expect(system).toContain(`[JHN 3:16]: ${jhn}`)
      // A sermon is not Scripture.
      expect(system).toContain("You draft for a translation project.")
      expect(system).not.toContain("scripture translation project")
    }
    // The research pass is told what it is before the block, then its job.
    expect(requests[0].messages[0].content).toMatch(/MUST follow\):[\s\S]*You are the RESEARCH pass/)
    expect(requests[1].messages[0].content).toMatch(/MUST follow\):[\s\S]*You are the GENERATION pass/)
  })

  it("uses the lane's own Bible: the English lane quotes the KJV", async () => {
    await installFixtureReferenceBibles(env.AQUILLA_PG)
    await seedProject({ settings: LOTE_SETTINGS, cells: SERMON })
    const requests = mockModel(3)

    await executeDraft(env.AQUILLA_PG, {}, ctx("en"), MODEL)
    const system = requests[0].messages[0].content
    expect(system).toContain(`${REFERENCE_VERSES_HEADING}King James Version (English) (MUST follow):`)
    expect(system).toContain(await verse("eng-kjv", "ISA 40:25"))
    expect(system).not.toContain(await verse("arb-vandyck", "ISA 40:25"))
  })

  it("adds nothing for a lane with no Bible, or a Bible the server does not have", async () => {
    await installFixtureReferenceBibles(env.AQUILLA_PG, ["eng-kjv"])
    await seedProject({
      settings: { ...LOTE_SETTINGS, referenceBibleVersions: { "": "arb-vandyck" } },
      cells: SERMON,
    })
    const requests = mockModel(3)

    // Default lane: arb-vandyck is not installed here.
    await executeDraft(env.AQUILLA_PG, {}, ctx(), MODEL)
    // English lane: no Bible chosen.
    await executeDraft(env.AQUILLA_PG, {}, ctx("en"), MODEL)
    expect(requests).toHaveLength(4)
    for (const request of requests) expect(request.messages[0].content).not.toContain(REFERENCE_VERSES_HEADING)
  })

  it("still calls a Bible book a scripture translation project, unchanged", async () => {
    await seedProject({
      settings: { sourceLanguage: "English", targetLanguage: "Spanish" },
      cells: [
        { source: "And he began again to teach", ref: "MRK 4:1" },
        { source: "And he taught them many things", ref: "MRK 4:2" },
      ],
      bookCode: "MRK",
    })
    const requests = mockModel(2)

    await executeDraft(env.AQUILLA_PG, { ref: "MRK 4" }, ctx(), MODEL)
    expect(requests[0].messages[0].content).toContain("You draft for a scripture translation project.")
    expect(requests[0].messages[0].content).not.toContain(REFERENCE_VERSES_HEADING)
  })
})

describe("isScriptureRef (AQU-1573 review)", () => {
  it("keeps every Scripture ref shape on the scripture wording", () => {
    for (const ref of ["MRK 4:12", "MRK 4", "1CO 13:4", "GEN:h:1", "GEN:mt1:1", "PSA:d:1", "OBS 1:1", " JHN 3:16 "]) {
      expect(isScriptureRef(ref), ref).toBe(true)
    }
  })

  it("treats a sermon's own labels and empty refs as not Scripture", () => {
    for (const ref of [null, "", "Session 1", "§2", "S1:3", "ABC 1:1", "XYZ:h:1", "OBS", "Intro 1"]) {
      expect(isScriptureRef(ref), String(ref)).toBe(false)
    }
  })
})
