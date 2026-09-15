// Tests for the Agent API effective-prompt preview (AQU-1230).
//
//   GET /api/v1/external/projects/:projectId/cells/:cellId/prompt-preview
//
// The acceptance criteria this suite encodes:
//   1. an agent gets the assembled prompt AND labeled parts for a cell
//   2. a term added through the terminology path then appears in that cell's
//      preview (observable cause→effect)
//   3. an example added to the project's validated corpus appears in previews
//      for similar cells
//   4. the preview MATCHES what the copilot actually sends — asserted by
//      building the same prompt with the SAME shared builder the editor calls
//      (src/lib/completion/prompt-build.ts) and comparing byte-for-byte
//   5. a wrong-project PAT gets 403
//
// Credential seeding mirrors external-reads.test.ts: real `api_credentials`
// rows minted through db/shared/api-credentials.

import { describe, it, expect, beforeEach } from "vitest"
import { handleExternalReadRequest } from "../external/read-routes"
import { mintApiToken } from "../../../db/shared/api-credentials"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"
import {
  buildPrompt,
  DEFAULT_SYSTEM_PROMPT,
  type ChatMessage,
} from "../../../src/lib/completion/prompt-build"
import { compileConceptsToRulesCore } from "../../../src/lib/terminology/compile-core"

const SECRET = "test-secret"
const CRED_A = "00000000-0000-0000-0000-0000000000a1"
const CRED_B = "00000000-0000-0000-0000-0000000000b1"

interface PreviewBody {
  projectId: string
  fileId: string
  cellId: string
  targetLang: string
  sourceLanguage: string
  targetLanguage: string
  sourceText: string
  messages: ChatMessage[]
  parts: {
    base: string
    brief: string
    rules: string
    injectedTerms: {
      conceptId: string
      sourceTerm: string
      approvedRenderings: string[]
      forbiddenRenderings: string[]
    }[]
    examples: { cellId?: string; source: string; target: string }[]
    precedingContext: { source: string; target: string }[]
  }
  generation: {
    provider: string
    model: string
    temperature: number | null
    maxTokens: number | null
    exampleFormat: string
    topK: number
  }
  retrieval: {
    primitive: string
    topK: number
    corpusSize: number
    upstreamProjectId: string | null
    retrievedCount: number
  }
  warnings: { code: string; message: string }[]
}

async function seedCredential(
  testDb: TestDb,
  opts: { id: string; userId: number; projectId: string | null },
): Promise<string> {
  const { token, tokenHash, tokenPrefix } = await mintApiToken()
  await testDb.pg.query(
    `INSERT INTO api_credentials (id, user_id, name, token_prefix, token_hash, mode, org_id, project_id)
     VALUES ($1, $2, 'test', $3, $4, 'act', NULL, $5)`,
    [opts.id, String(opts.userId), tokenPrefix, tokenHash, opts.projectId],
  )
  return token
}

function env(testDb: TestDb) {
  return { AQUILLA_PG: testDb.db, SYNC_SECRET_KEY: SECRET }
}

function req(path: string, token?: string): Request {
  const headers: Record<string, string> = {}
  if (token !== undefined) headers["Authorization"] = `Bearer ${token}`
  return new Request(`https://worker${path}`, { headers })
}

/** Insert a paired source/target cell. `validated` marks the target approved. */
async function insertCell(
  testDb: TestDb,
  opts: {
    projectId?: string
    fileId?: string
    cellId: string
    seq: number
    source: string
    target?: string
    validated?: boolean
    medium?: string | null
    transcription?: string | null
  },
) {
  const projectId = opts.projectId ?? "proj-a"
  const fileId = opts.fileId ?? "file-x"
  await testDb.pg.query(
    `INSERT INTO cells (project_id, file_id, cell_id, side, value, event_id, last_edit_at, word_count, sequence_index, medium, transcription)
     VALUES ($1, $2, $3, 'source', $4, $5, 1000, 1, $6, $7, $8)`,
    [
      projectId,
      fileId,
      opts.cellId,
      opts.source,
      `evt-s-${opts.cellId}`,
      opts.seq,
      opts.medium ?? null,
      opts.transcription ?? null,
    ],
  )
  if (opts.target !== undefined) {
    await testDb.pg.query(
      `INSERT INTO cells (project_id, file_id, cell_id, side, value, event_id, last_edit_at, word_count, sequence_index, validated)
       VALUES ($1, $2, $3, 'target', $4, $5, 2000, 1, $6, $7)`,
      [
        projectId,
        fileId,
        opts.cellId,
        opts.target,
        `evt-t-${opts.cellId}`,
        opts.seq,
        opts.validated ? 1 : 0,
      ],
    )
  }
}

async function putSettings(testDb: TestDb, projectId: string, settings: object) {
  await testDb.pg.query(
    `INSERT INTO project_settings (project_id, settings, version) VALUES ($1, $2, 1)
     ON CONFLICT (project_id) DO UPDATE SET settings = EXCLUDED.settings`,
    [projectId, JSON.stringify(settings)],
  )
}

async function seedBase(testDb: TestDb) {
  await testDb.pg.query(
    `INSERT INTO users (id, username, email, password_hash) VALUES (1, 'owner', 'o@x.com', 'h')`,
  )
  await testDb.pg.query(
    `INSERT INTO users (id, username, email, password_hash) VALUES (2, 'member', 'm@x.com', 'h')`,
  )
  await testDb.pg.query(
    `INSERT INTO organizations (id, name, owner_user_id) VALUES (10, 'Org A', 1)`,
  )
  await testDb.pg.query(
    `INSERT INTO projects (id, name, org_id, created_by) VALUES ('proj-a', 'Project A', 10, 1)`,
  )
  await testDb.pg.query(
    `INSERT INTO projects (id, name, org_id, created_by) VALUES ('proj-b', 'Project B', 10, 1)`,
  )
  await testDb.pg.query(
    `INSERT INTO project_members (project_id, user_id, role_level) VALUES ('proj-a', 2, 400)`,
  )
  await testDb.pg.query(
    `INSERT INTO project_members (project_id, user_id, role_level) VALUES ('proj-b', 2, 400)`,
  )
  await testDb.pg.query(
    `INSERT INTO files (id, project_id, name, event_id) VALUES ('file-x', 'proj-a', 'Genesis', 'evt-file-1')`,
  )
  await putSettings(testDb, "proj-a", {
    sourceLanguage: "English",
    targetLanguage: "French",
  })
}

async function preview(
  testDb: TestDb,
  token: string,
  cellId = "cell-live",
  qs = "",
): Promise<{ status: number; body: PreviewBody }> {
  const res = await handleExternalReadRequest(
    req(`/api/v1/external/projects/proj-a/cells/${cellId}/prompt-preview${qs}`, token),
    env(testDb),
  )
  expect(res).not.toBeNull()
  return { status: res!.status, body: (await res!.json()) as PreviewBody }
}

describe("external prompt preview", () => {
  let testDb: TestDb
  let token: string

  beforeEach(async () => {
    testDb = await makeTestDb()
    await seedBase(testDb)
    token = await seedCredential(testDb, { id: CRED_A, userId: 2, projectId: "proj-a" })
  })

  describe("assembly", () => {
    beforeEach(async () => {
      await insertCell(testDb, { cellId: "cell-live", seq: 3, source: "God saw the light" })
    })

    it("returns the assembled messages and the labeled parts", async () => {
      const { status, body } = await preview(testDb, token)
      expect(status).toBe(200)
      expect(body.cellId).toBe("cell-live")
      expect(body.fileId).toBe("file-x")
      expect(body.sourceText).toBe("God saw the light")
      expect(body.sourceLanguage).toBe("English")
      expect(body.targetLanguage).toBe("French")

      expect(body.messages).toHaveLength(2)
      expect(body.messages[0].role).toBe("system")
      expect(body.messages[1].role).toBe("user")
      // Language placeholders are substituted, not echoed.
      expect(body.messages[0].content).not.toContain("{targetLanguage}")
      expect(body.messages[0].content).toContain("French")
      // The final line is always the live source.
      expect(body.messages[1].content.endsWith("Source: God saw the light\nTranslation:")).toBe(true)

      // Parts are labeled and, with nothing configured, empty rather than absent.
      expect(body.parts.base).toContain("English")
      expect(body.parts.brief).toBe("")
      expect(body.parts.rules).toBe("")
      expect(body.parts.injectedTerms).toEqual([])
      expect(body.retrieval.primitive).toBe("branching-search")
    })

    it("reports the project's generation configuration", async () => {
      await putSettings(testDb, "proj-a", {
        sourceLanguage: "English",
        targetLanguage: "French",
        completionSettings: {
          provider: "frontier",
          model: "some-model",
          temperature: 0.4,
          maxTokens: 2048,
          top_k: 3,
          fewShotExampleFormat: "target-only",
        },
      })
      const { body } = await preview(testDb, token)
      expect(body.generation).toMatchObject({
        provider: "frontier",
        model: "some-model",
        temperature: 0.4,
        maxTokens: 2048,
        exampleFormat: "target-only",
        topK: 3,
      })
      expect(body.retrieval.topK).toBe(3)
    })

    it("injects a custom system prompt and the translation brief", async () => {
      await putSettings(testDb, "proj-a", {
        sourceLanguage: "English",
        targetLanguage: "French",
        completionSettings: { systemPrompt: "Translate {sourceLanguage}→{targetLanguage} tersely." },
        translationBrief: { l1Summary: "Aimed at oral communities." },
      })
      const { body } = await preview(testDb, token)
      expect(body.parts.base).toBe("Translate English→French tersely.")
      expect(body.parts.brief).toContain("Aimed at oral communities.")
      expect(body.messages[0].content).toContain("Translate English→French tersely.")
      expect(body.messages[0].content).toContain("Aimed at oral communities.")
    })

    it("404s a cell with no source row in this project", async () => {
      const { status, body } = await preview(testDb, token, "nope")
      expect(status).toBe(404)
      expect((body as unknown as { error: { code: string } }).error.code).toBe("not_found")
    })

    it("warns when the cell has no effective source text", async () => {
      // A media section whose ASR has not run: `value` is the import filename,
      // so there is no source text and the copilot refuses to draft it.
      await insertCell(testDb, {
        cellId: "cell-media",
        seq: 9,
        source: "recording-04.mp3",
        medium: "media",
        transcription: null,
      })
      const { body } = await preview(testDb, token, "cell-media")
      expect(body.sourceText).toBe("")
      expect(body.warnings.map((w) => w.code)).toContain("empty_source")
    })
  })

  describe("terminology cause→effect", () => {
    beforeEach(async () => {
      await insertCell(testDb, { cellId: "cell-live", seq: 3, source: "the covenant endures" })
    })

    it("a term added via the terminology path appears in the preview", async () => {
      const before = await preview(testDb, token)
      expect(before.body.parts.rules).toBe("")
      expect(before.body.parts.injectedTerms).toEqual([])

      await testDb.pg.query(
        `INSERT INTO concepts (concept_id, project_id, source_term, renderings, status, case_sensitive, created_at, updated_at)
         VALUES ('c1', 'proj-a', 'covenant', $1, 'active', 0, 1, 1)`,
        [JSON.stringify([{ rendering: "alliance", status: "preferred" }])],
      )

      const after = await preview(testDb, token)
      expect(after.body.parts.rules).toContain("covenant")
      expect(after.body.parts.rules).toContain("alliance")
      expect(after.body.messages[0].content).toContain("alliance")
      expect(after.body.parts.injectedTerms).toEqual([
        {
          conceptId: "c1",
          sourceTerm: "covenant",
          approvedRenderings: ["alliance"],
          forbiddenRenderings: [],
        },
      ])
    })

    it("a forbidden rendering becomes a 'do NOT use' line", async () => {
      await testDb.pg.query(
        `INSERT INTO concepts (concept_id, project_id, source_term, renderings, status, case_sensitive, created_at, updated_at)
         VALUES ('c2', 'proj-a', 'covenant', $1, 'active', 0, 1, 1)`,
        [JSON.stringify([{ rendering: "contrat", status: "forbidden" }])],
      )
      const { body } = await preview(testDb, token)
      expect(body.parts.rules).toContain("Do NOT use")
      expect(body.parts.rules).toContain("contrat")
    })

    it("a draft concept injects nothing (only active concepts compile)", async () => {
      await testDb.pg.query(
        `INSERT INTO concepts (concept_id, project_id, source_term, renderings, status, case_sensitive, created_at, updated_at)
         VALUES ('c3', 'proj-a', 'covenant', $1, 'draft', 0, 1, 1)`,
        [JSON.stringify([{ rendering: "alliance", status: "preferred" }])],
      )
      const { body } = await preview(testDb, token)
      expect(body.parts.rules).toBe("")
      expect(body.parts.injectedTerms).toEqual([])
    })

    it("a deleted concept stops injecting", async () => {
      await testDb.pg.query(
        `INSERT INTO concepts (concept_id, project_id, source_term, renderings, status, case_sensitive, created_at, updated_at, deleted_at)
         VALUES ('c4', 'proj-a', 'covenant', $1, 'active', 0, 1, 1, 5)`,
        [JSON.stringify([{ rendering: "alliance", status: "preferred" }])],
      )
      const { body } = await preview(testDb, token)
      expect(body.parts.rules).toBe("")
    })

    it("injects project rules from settings", async () => {
      await putSettings(testDb, "proj-a", {
        sourceLanguage: "English",
        targetLanguage: "French",
        rules: [
          {
            id: "r1",
            enabled: true,
            scope: "project",
            check: { type: "target-forbids", targetPattern: "thingy" },
          },
        ],
      })
      const { body } = await preview(testDb, token)
      expect(body.parts.rules).toContain("thingy")
    })

    it("drops a lane-scoped rule belonging to another lane", async () => {
      await putSettings(testDb, "proj-a", {
        sourceLanguage: "English",
        targetLanguage: "French",
        rules: [
          {
            id: "r-other",
            enabled: true,
            scope: "lane",
            lane: "es",
            check: { type: "target-forbids", targetPattern: "otherlane" },
          },
          {
            id: "r-default",
            enabled: true,
            scope: "lane",
            lane: "",
            check: { type: "target-forbids", targetPattern: "defaultlane" },
          },
        ],
      })
      const { body } = await preview(testDb, token)
      expect(body.parts.rules).toContain("defaultlane")
      expect(body.parts.rules).not.toContain("otherlane")
    })
  })

  describe("examples and discourse context", () => {
    it("a validated example for a similar cell appears in the preview", async () => {
      await insertCell(testDb, { cellId: "cell-live", seq: 5, source: "God saw the light" })
      const before = await preview(testDb, token)
      expect(before.body.parts.examples).toEqual([])

      // Seeded AFTER the live cell so it is a retrieved EXAMPLE rather than
      // part of the preceding discourse window — `selectApprovedExamples`
      // deliberately drops examples the window already carries, so a preceding
      // cell would show up under precedingContext instead (covered below).
      await insertCell(testDb, {
        cellId: "cell-example",
        seq: 9,
        source: "God saw the darkness",
        target: "Dieu vit les ténèbres",
        validated: true,
      })

      const after = await preview(testDb, token)
      expect(after.body.parts.examples.map((e) => e.target)).toContain("Dieu vit les ténèbres")
      expect(after.body.messages[1].content).toContain("Dieu vit les ténèbres")
      expect(after.body.retrieval.corpusSize).toBeGreaterThan(0)
    })

    it("an unvalidated translation is never used as an example", async () => {
      await insertCell(testDb, { cellId: "cell-live", seq: 5, source: "God saw the light" })
      await insertCell(testDb, {
        cellId: "cell-unapproved",
        seq: 1,
        source: "God saw the darkness",
        target: "brouillon non validé",
        validated: false,
      })
      const { body } = await preview(testDb, token)
      expect(body.messages[1].content).not.toContain("brouillon non validé")
      expect(body.parts.examples).toEqual([])
    })

    it("renders the preceding approved targets in document order", async () => {
      await insertCell(testDb, {
        cellId: "c1",
        seq: 1,
        source: "In the beginning",
        target: "Au commencement",
        validated: true,
      })
      await insertCell(testDb, {
        cellId: "c2",
        seq: 2,
        source: "God created",
        target: "Dieu créa",
        validated: true,
      })
      await insertCell(testDb, { cellId: "cell-live", seq: 3, source: "and it was good" })
      // A LATER cell must not leak backwards into the window.
      await insertCell(testDb, {
        cellId: "c4",
        seq: 4,
        source: "the evening came",
        target: "le soir vint",
        validated: true,
      })

      const { body } = await preview(testDb, token)
      expect(body.parts.precedingContext.map((c) => c.target)).toEqual([
        "Au commencement",
        "Dieu créa",
      ])
      expect(body.parts.precedingContext.map((c) => c.target)).not.toContain("le soir vint")
    })

    it("honours draftContext.precedingTargetCells", async () => {
      for (let i = 1; i <= 4; i++) {
        await insertCell(testDb, {
          cellId: `p${i}`,
          seq: i,
          source: `source ${i}`,
          target: `cible ${i}`,
          validated: true,
        })
      }
      await insertCell(testDb, { cellId: "cell-live", seq: 9, source: "the live one" })
      await putSettings(testDb, "proj-a", {
        sourceLanguage: "English",
        targetLanguage: "French",
        draftContext: { precedingTargetCells: 2 },
      })

      const { body } = await preview(testDb, token)
      expect(body.parts.precedingContext.map((c) => c.target)).toEqual(["cible 3", "cible 4"])
    })
  })

  describe("fidelity — matches what the copilot sends", () => {
    it("equals buildPrompt() called with the same evidence", async () => {
      await insertCell(testDb, {
        cellId: "c1",
        seq: 1,
        source: "In the beginning",
        target: "Au commencement",
        validated: true,
      })
      await insertCell(testDb, { cellId: "cell-live", seq: 2, source: "God saw the light" })
      await testDb.pg.query(
        `INSERT INTO concepts (concept_id, project_id, source_term, renderings, status, case_sensitive, created_at, updated_at)
         VALUES ('c1', 'proj-a', 'light', $1, 'active', 0, 1, 1)`,
        [JSON.stringify([{ rendering: "lumière", status: "preferred" }])],
      )
      await putSettings(testDb, "proj-a", {
        sourceLanguage: "English",
        targetLanguage: "French",
        translationBrief: { l1Summary: "Plain register." },
      })

      const { body } = await preview(testDb, token)

      // Re-assemble with the SHARED builder the editor calls, over the SHARED
      // terminology compiler, feeding it the evidence the preview reported. If
      // the route ever starts hand-rolling its own string concatenation — or
      // either shared module changes under it — this fails.
      //
      // Note the compiled pattern is the wildcard-aware one from
      // ./terminology/match (`(?<!\p{L})light(?!\p{L})`), not the bare term:
      // going through the real compiler is precisely what makes this a
      // fidelity check rather than a restatement.
      const expected = buildPrompt({
        sourceLanguage: "English",
        targetLanguage: "French",
        systemPrompt: DEFAULT_SYSTEM_PROMPT,
        sourceText: "God saw the light",
        examples: [],
        rules: compileConceptsToRulesCore(
          [
            {
              id: "c1",
              sourceTerm: "light",
              renderings: [{ rendering: "lumière", status: "preferred" }],
              status: "active",
            },
          ],
          {
            approvedName: () => "n",
            approvedDescription: () => "d",
            forbiddenName: () => "n",
            forbiddenDescription: () => "d",
          },
        ),
        validatedPairs: body.parts.examples,
        exampleFormat: "source-and-target",
        briefSummary: "Plain register.",
        precedingContext: body.parts.precedingContext,
      })

      expect(body.messages).toEqual(expected)
    })
  })

  describe("scope", () => {
    it("a PAT scoped to another project gets 403", async () => {
      await insertCell(testDb, { cellId: "cell-live", seq: 1, source: "God saw the light" })
      const otherToken = await seedCredential(testDb, {
        id: CRED_B,
        userId: 2,
        projectId: "proj-b",
      })
      const res = await handleExternalReadRequest(
        req("/api/v1/external/projects/proj-a/cells/cell-live/prompt-preview", otherToken),
        env(testDb),
      )
      expect(res!.status).toBe(403)
      const body = (await res!.json()) as { error: { code: string } }
      expect(body.error.code).toBe("scope_denied")
    })

    it("a credential with no membership on the project gets 403", async () => {
      await insertCell(testDb, { cellId: "cell-live", seq: 1, source: "God saw the light" })
      const strangerToken = await seedCredential(testDb, {
        id: CRED_B,
        userId: 1,
        projectId: null,
      })
      await testDb.pg.query(`DELETE FROM projects WHERE id = 'proj-a'`)
      await testDb.pg.query(
        `INSERT INTO projects (id, name, org_id, created_by) VALUES ('proj-a', 'Project A', 10, 2)`,
      )
      await testDb.pg.query(`DELETE FROM project_members WHERE project_id = 'proj-a'`)
      const res = await handleExternalReadRequest(
        req("/api/v1/external/projects/proj-a/cells/cell-live/prompt-preview", strangerToken),
        env(testDb),
      )
      expect(res!.status).toBe(403)
    })

    it("a missing credential gets 401", async () => {
      const res = await handleExternalReadRequest(
        req("/api/v1/external/projects/proj-a/cells/cell-live/prompt-preview"),
        env(testDb),
      )
      expect(res!.status).toBe(401)
    })
  })
})
