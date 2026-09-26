// Tests for the external Living Memory read surface (AQU-1229).
//
// The contract under test is PARITY: what these endpoints return must match
// what the in-app Memory page shows and what the copilot's own retrieval
// (`buildMemoryContext`) injects. So the assertions compare against those
// shared helpers rather than against a hand-written expected shape — a change
// to retrieval that this surface failed to follow should fail here.

import { describe, it, expect, beforeEach } from "vitest"
import { handleExternalMemoryReadRequest } from "../external/memory-read-routes"
import { buildPromptPreview } from "../external/prompt-preview"
import { buildBriefBlock } from "../../../src/lib/completion/prompt-build"
import { mintApiToken } from "../../../db/shared/api-credentials"
import {
  buildMemoryContext,
  listMemories,
  MEMORY_INDEX_RENDER_CAP,
  memoryKindForPath,
} from "../../../db/shared/agent-memory"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"

const SECRET = "test-secret"
const CRED_1 = "00000000-0000-0000-0000-000000000001"

async function seedCredential(
  testDb: TestDb,
  opts: { id: string; userId: number; projectId?: string | null; orgId?: number | null; pii?: boolean },
): Promise<string> {
  const { token, tokenHash, tokenPrefix } = await mintApiToken()
  await testDb.pg.query(
    `INSERT INTO api_credentials (id, user_id, name, token_prefix, token_hash, mode, org_id, project_id, pii)
     VALUES ($1, $2, 'test', $3, $4, 'ask', $5, $6, $7)`,
    [
      opts.id,
      String(opts.userId),
      tokenPrefix,
      tokenHash,
      opts.orgId != null ? String(opts.orgId) : null,
      opts.projectId ?? null,
      opts.pii === true,
    ],
  )
  return token
}

/** Set the project's agentAuthorship policy the same way AQU-1180's own tests
 *  do (external-pii.test.ts) — through project_settings, which is what
 *  resolveAuthorshipPolicy actually reads. */
async function setAgentAuthorship(testDb: TestDb, projectId: string, value: string): Promise<void> {
  await testDb.pg.query(
    `INSERT INTO project_settings (project_id, settings) VALUES ($1, $2)
     ON CONFLICT (project_id) DO UPDATE SET settings = EXCLUDED.settings`,
    [projectId, JSON.stringify({ agentAuthorship: value })],
  )
}

function env(testDb: TestDb) {
  return { AQUILLA_PG: testDb.db, SYNC_SECRET_KEY: SECRET }
}

function req(path: string, token?: string, method = "GET"): Request {
  const headers: Record<string, string> = {}
  if (token !== undefined) headers["Authorization"] = `Bearer ${token}`
  return new Request(`https://worker${path}`, { headers, method })
}

/** One memory row. `updatedAt` drives ordering (most-recently-updated first). */
async function seedMemory(
  testDb: TestDb,
  m: {
    id: string
    projectId?: string
    path: string
    content: string
    status?: "proposed" | "approved" | "rejected" | "archived"
    humanEdited?: boolean
    createdBy?: string | null
    reviewedBy?: string | null
    provenance?: Record<string, string> | null
    updatedAt?: string
  },
) {
  await testDb.pg.query(
    `INSERT INTO agent_memories
       (id, project_id, path, content, status, human_edited, rationale, provenance,
        created_by, reviewed_by, version, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8, $9, 1, $10, $10)`,
    [
      m.id,
      m.projectId ?? "proj-a",
      m.path,
      m.content,
      m.status ?? "approved",
      m.humanEdited ?? false,
      m.provenance === undefined ? null : m.provenance === null ? null : JSON.stringify(m.provenance),
      m.createdBy === undefined ? "alice" : m.createdBy,
      m.reviewedBy === undefined ? null : m.reviewedBy,
      m.updatedAt ?? "2026-01-01T00:00:00Z",
    ],
  )
}

/** The brief the copilot actually reads: `settings.translationBrief` (AQU-1282). */
async function seedTranslationBrief(
  testDb: TestDb,
  brief: { l1Summary: string | null; updatedBy?: string; updatedAt?: string; l1GeneratedAt?: string | null },
) {
  const record = {
    version: 2,
    updatedAt: brief.updatedAt ?? "2026-02-01T00:00:00.000Z",
    updatedBy: brief.updatedBy ?? "alice",
    parameters: { purpose: "Liturgical reading", audience: "Rural youth" },
    freeformNotes: "",
    l2Markdown: "",
    l1Summary: brief.l1Summary,
    l1GeneratedAt: brief.l1GeneratedAt === undefined ? "2026-02-02T00:00:00.000Z" : brief.l1GeneratedAt,
    l1ModelId: brief.l1Summary ? "model-x" : null,
  }
  await testDb.pg.query(
    `INSERT INTO project_settings (project_id, settings, version, updated_by, updated_at)
     VALUES ('proj-a', $1, 1, 1, now())`,
    [JSON.stringify({ targetLanguage: "fr", translationBrief: record })],
  )
}

async function seedProject(testDb: TestDb) {
  await testDb.pg.query(
    `INSERT INTO users (id, username, email, password_hash) VALUES (1, 'owner', 'owner@x.com', 'h')`,
  )
  await testDb.pg.query(
    `INSERT INTO users (id, username, email, password_hash) VALUES (2, 'member', 'member@x.com', 'h')`,
  )
  await testDb.pg.query(`INSERT INTO organizations (id, name, owner_user_id) VALUES (10, 'Org A', 1)`)
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
  await testDb.pg.query(
    `INSERT INTO cells (project_id, file_id, cell_id, side, value, event_id, last_edit_at, word_count)
     VALUES ('proj-a', 'file-x', 'cell-1', 'source', 'In the beginning', 'evt-1', 1000, 3)`,
  )
}

interface MemoryEntryBody {
  id: string
  path: string
  kind: string
  status: string
  humanEdited: boolean
  content: string
  firstLine: string
  createdBy: string | null
  reviewedBy: string | null
  provenance: Record<string, string> | null
  inRetrieval: boolean
}

interface BriefBody {
  content: string
  version: number
  updatedAt: string | null
  updatedBy: string | null
  source: string
  reachesCopilot: boolean
  sections: number
  l1Stale: boolean
}

interface MemoryListBody {
  brief: BriefBody
  legacyBrief?: { content: string; version: number }
  data: MemoryEntryBody[]
  nextCursor: string | null
  retrieval: { scope: string; indexRenderCap: number; approvedCount: number; injectedCount: number }
}

interface CellMemoryBody {
  cell: { fileId: string; cellId: string }
  brief: BriefBody
  legacyBrief?: { content: string; version: number }
  entries: Array<{ path: string; kind: string; firstLine: string; humanEdited: boolean }>
  retrieval: {
    scope: string
    indexRenderCap: number
    approvedCount: number
    injectedCount: number
    truncated: boolean
    note: string
  }
}

describe("external Living Memory reads", () => {
  let testDb: TestDb

  beforeEach(async () => {
    testDb = await makeTestDb()
    await seedProject(testDb)
  })

  it("returns null for unrelated paths", async () => {
    expect(await handleExternalMemoryReadRequest(req("/admin/whatever"), env(testDb))).toBeNull()
    // The plain cells read must NOT be captured by the memory router.
    expect(
      await handleExternalMemoryReadRequest(
        req("/api/v1/external/projects/proj-a/files/file-x/cells"),
        env(testDb),
      ),
    ).toBeNull()
  })

  describe("GET .../memory", () => {
    it("lists the same entries as the in-app surface, newest first, with kinds", async () => {
      await seedMemory(testDb, {
        id: "11111111-1111-1111-1111-111111111111",
        path: "decisions/divine-name.md",
        content: "Render Lord as Господь, never Пан.\nRationale follows.",
        updatedAt: "2026-02-01T00:00:00Z",
      })
      await seedMemory(testDb, {
        id: "22222222-2222-2222-2222-222222222222",
        path: "examples/greeting.md",
        content: "source: Hello\ntarget: Привет",
        status: "proposed",
        updatedAt: "2026-03-01T00:00:00Z",
      })
      await seedMemory(testDb, {
        id: "33333333-3333-3333-3333-333333333333",
        path: "notes/file-x/cell-1-abc.md",
        content: "Chose the formal register here.",
        updatedAt: "2026-01-15T00:00:00Z",
      })
      const token = await seedCredential(testDb, { id: CRED_1, userId: 2, projectId: "proj-a" })

      const res = await handleExternalMemoryReadRequest(
        req("/api/v1/external/projects/proj-a/memory", token),
        env(testDb),
      )
      expect(res!.status).toBe(200)
      const body = (await res!.json()) as MemoryListBody

      // Parity with the in-app page: every status, same order.
      const inApp = await listMemories(testDb.db, "proj-a")
      expect(body.data.map((e) => e.path)).toEqual(inApp.map((m) => m.path))
      expect(body.data.map((e) => e.path)).toEqual([
        "examples/greeting.md",
        "decisions/divine-name.md",
        "notes/file-x/cell-1-abc.md",
      ])
      expect(body.data.map((e) => e.kind)).toEqual(["example", "decision", "note"])
      expect(body.data.map((e) => e.kind)).toEqual(inApp.map((m) => memoryKindForPath(m.path)))
      expect(body.data[1].content).toContain("Господь")
      expect(body.data[1].firstLine).toBe("Render Lord as Господь, never Пан.")
      expect(body.retrieval).toMatchObject({
        scope: "project",
        indexRenderCap: MEMORY_INDEX_RENDER_CAP,
        approvedCount: 2,
        injectedCount: 2,
      })
    })

    it("marks only entries retrieval actually injects with inRetrieval", async () => {
      await seedMemory(testDb, {
        id: "11111111-1111-1111-1111-111111111111",
        path: "decisions/approved.md",
        content: "approved",
        status: "approved",
      })
      await seedMemory(testDb, {
        id: "22222222-2222-2222-2222-222222222222",
        path: "decisions/pending.md",
        content: "pending",
        status: "proposed",
      })
      await seedMemory(testDb, {
        id: "33333333-3333-3333-3333-333333333333",
        path: "decisions/retired.md",
        content: "retired",
        status: "archived",
      })
      const token = await seedCredential(testDb, { id: CRED_1, userId: 2, projectId: "proj-a" })

      const res = await handleExternalMemoryReadRequest(
        req("/api/v1/external/projects/proj-a/memory", token),
        env(testDb),
      )
      const body = (await res!.json()) as MemoryListBody
      const byPath = new Map(body.data.map((e) => [e.path, e]))
      expect(byPath.get("decisions/approved.md")!.inRetrieval).toBe(true)
      expect(byPath.get("decisions/pending.md")!.inRetrieval).toBe(false)
      expect(byPath.get("decisions/retired.md")!.inRetrieval).toBe(false)

      // And the true injected set agrees with the copilot's own retrieval.
      const ctx = await buildMemoryContext(testDb.db, "proj-a")
      expect(ctx.memoryIndex.map((m) => m.path)).toEqual(
        body.data.filter((e) => e.inRetrieval).map((e) => e.path),
      )
    })

    it("filters by status and by kind", async () => {
      await seedMemory(testDb, {
        id: "11111111-1111-1111-1111-111111111111",
        path: "examples/one.md",
        content: "one",
        status: "approved",
      })
      await seedMemory(testDb, {
        id: "22222222-2222-2222-2222-222222222222",
        path: "decisions/two.md",
        content: "two",
        status: "proposed",
      })
      const token = await seedCredential(testDb, { id: CRED_1, userId: 2, projectId: "proj-a" })

      const byStatus = (await (
        await handleExternalMemoryReadRequest(
          req("/api/v1/external/projects/proj-a/memory?status=proposed", token),
          env(testDb),
        )
      )!.json()) as MemoryListBody
      expect(byStatus.data.map((e) => e.path)).toEqual(["decisions/two.md"])
      // Retrieval facts describe the WHOLE approved set, not the filtered page.
      expect(byStatus.retrieval.approvedCount).toBe(1)

      const byKind = (await (
        await handleExternalMemoryReadRequest(
          req("/api/v1/external/projects/proj-a/memory?kind=example", token),
          env(testDb),
        )
      )!.json()) as MemoryListBody
      expect(byKind.data.map((e) => e.path)).toEqual(["examples/one.md"])
    })

    it("rejects an unknown status or kind rather than silently ignoring it", async () => {
      const token = await seedCredential(testDb, { id: CRED_1, userId: 2, projectId: "proj-a" })
      for (const qs of ["?status=nonsense", "?kind=nonsense"]) {
        const res = await handleExternalMemoryReadRequest(
          req(`/api/v1/external/projects/proj-a/memory${qs}`, token),
          env(testDb),
        )
        expect(res!.status).toBe(400)
        const body = (await res!.json()) as { error: { code: string } }
        expect(body.error.code).toBe("validation_failed")
      }
    })

    it("paginates with an opaque cursor", async () => {
      for (let i = 0; i < 3; i++) {
        await seedMemory(testDb, {
          id: `4444444${i}-4444-4444-4444-444444444444`,
          path: `decisions/d${i}.md`,
          content: `d${i}`,
          updatedAt: `2026-0${i + 1}-01T00:00:00Z`,
        })
      }
      const token = await seedCredential(testDb, { id: CRED_1, userId: 2, projectId: "proj-a" })
      const first = (await (
        await handleExternalMemoryReadRequest(
          req("/api/v1/external/projects/proj-a/memory?limit=2", token),
          env(testDb),
        )
      )!.json()) as MemoryListBody
      expect(first.data).toHaveLength(2)
      expect(first.nextCursor).not.toBeNull()

      const second = (await (
        await handleExternalMemoryReadRequest(
          req(
            `/api/v1/external/projects/proj-a/memory?limit=2&cursor=${encodeURIComponent(first.nextCursor as string)}`,
            token,
          ),
          env(testDb),
        )
      )!.json()) as MemoryListBody
      expect(second.data).toHaveLength(1)
      expect(second.nextCursor).toBeNull()
      expect(second.data[0].path).not.toBe(first.data[0].path)
    })

    it("reports the brief the copilot prompt injects — the rendered L1 of settings.translationBrief (AQU-1282)", async () => {
      await seedTranslationBrief(testDb, { l1Summary: "Translate for rural youth in a liturgical register." })
      const token = await seedCredential(testDb, { id: CRED_1, userId: 2, projectId: "proj-a" })
      const body = (await (
        await handleExternalMemoryReadRequest(
          req("/api/v1/external/projects/proj-a/memory", token),
          env(testDb),
        )
      )!.json()) as MemoryListBody
      expect(body.brief.content).toBe("Translate for rural youth in a liturgical register.")
      expect(body.brief.source).toBe("translationBrief")
      expect(body.brief.version).toBe(2)
      expect(body.brief.reachesCopilot).toBe(true)
      expect(body.brief.sections).toBe(2)
      expect(body.brief.l1Stale).toBe(false)
      expect(body.legacyBrief).toBeUndefined()

      // Agreement with prompt-preview: the brief block the copilot gets is
      // built from exactly this text.
      const preview = await buildPromptPreview(testDb.db, { projectId: "proj-a", cellId: "cell-1", targetLang: "" })
      expect(preview.ok).toBe(true)
      if (preview.ok) {
        expect(preview.body.parts.brief).not.toBe("")
        expect(preview.body.parts.brief).toBe(buildBriefBlock(body.brief.content))
      }
    })

    it("a brief with sections but no L1 does NOT reach the copilot, and says so", async () => {
      await seedTranslationBrief(testDb, { l1Summary: null, l1GeneratedAt: null })
      const token = await seedCredential(testDb, { id: CRED_1, userId: 2, projectId: "proj-a" })
      const body = (await (
        await handleExternalMemoryReadRequest(
          req("/api/v1/external/projects/proj-a/memory", token),
          env(testDb),
        )
      )!.json()) as MemoryListBody
      expect(body.brief.content).toBe("")
      expect(body.brief.sections).toBe(2)
      expect(body.brief.reachesCopilot).toBe(false)
      expect(body.brief.l1Stale).toBe(true)
      const preview = await buildPromptPreview(testDb.db, { projectId: "proj-a", cellId: "cell-1", targetLang: "" })
      expect(preview.ok && preview.body.parts.brief).toBe("")
    })

    it("surfaces the older free-text project brief as legacyBrief only when it has content", async () => {
      await testDb.pg.query(
        `INSERT INTO project_briefs (project_id, content, updated_by, version)
         VALUES ('proj-a', 'Formal register throughout.', 'owner', 3)`,
      )
      const token = await seedCredential(testDb, { id: CRED_1, userId: 2, projectId: "proj-a" })
      const body = (await (
        await handleExternalMemoryReadRequest(
          req("/api/v1/external/projects/proj-a/memory", token),
          env(testDb),
        )
      )!.json()) as MemoryListBody
      expect(body.legacyBrief).toEqual({ content: "Formal register throughout.", version: 3 })
      // …and it is NOT reported as the copilot's brief: no settings brief exists.
      expect(body.brief.content).toBe("")
      expect(body.brief.reachesCopilot).toBe(false)
    })
  })

  describe("PII default (AQU-1180)", () => {
    it("never echoes a username — authors are stable per-project pseudonyms", async () => {
      await seedMemory(testDb, {
        id: "11111111-1111-1111-1111-111111111111",
        path: "decisions/a.md",
        content: "a",
        createdBy: "alice",
        reviewedBy: "owner",
        provenance: { runId: "run-1", sessionId: "sess-1", credentialId: "cred-secret" },
      })
      await seedMemory(testDb, {
        id: "22222222-2222-2222-2222-222222222222",
        path: "decisions/b.md",
        content: "b",
        createdBy: "alice",
      })
      await seedTranslationBrief(testDb, { l1Summary: "brief", updatedBy: "alice" })
      await testDb.pg.query(
        `INSERT INTO project_briefs (project_id, content, updated_by, version)
         VALUES ('proj-a', 'legacy brief', 'alice', 1)`,
      )
      const token = await seedCredential(testDb, { id: CRED_1, userId: 2, projectId: "proj-a" })

      const res = await handleExternalMemoryReadRequest(
        req("/api/v1/external/projects/proj-a/memory", token),
        env(testDb),
      )
      const raw = await res!.text()
      expect(raw).not.toContain("alice")
      expect(raw).not.toContain("owner")
      // The credentialId names another person's token — same PII class, dropped.
      expect(raw).not.toContain("cred-secret")

      const body = JSON.parse(raw) as MemoryListBody
      const byPath = new Map(body.data.map((e) => [e.path, e]))
      const a = byPath.get("decisions/a.md")!
      const b = byPath.get("decisions/b.md")!
      expect(a.createdBy).toMatch(/^u_[0-9a-f]{8}$/)
      // Same person, same pseudonym within the project — so "one author wrote
      // both of these" survives pseudonymization.
      expect(b.createdBy).toBe(a.createdBy)
      expect(body.brief.updatedBy).toBe(a.createdBy)
      // Different people stay distinguishable.
      expect(a.reviewedBy).not.toBe(a.createdBy)
      // Run/session provenance is kept — it identifies an agent run, not a person.
      expect(a.provenance).toEqual({ runId: "run-1", sessionId: "sess-1" })
    })

    it("gives the same person different pseudonyms in different projects", async () => {
      await seedMemory(testDb, {
        id: "11111111-1111-1111-1111-111111111111",
        projectId: "proj-a",
        path: "decisions/a.md",
        content: "a",
        createdBy: "alice",
      })
      await seedMemory(testDb, {
        id: "22222222-2222-2222-2222-222222222222",
        projectId: "proj-b",
        path: "decisions/a.md",
        content: "a",
        createdBy: "alice",
      })
      const token = await seedCredential(testDb, { id: CRED_1, userId: 2, projectId: null })

      const inA = (await (
        await handleExternalMemoryReadRequest(
          req("/api/v1/external/projects/proj-a/memory", token),
          env(testDb),
        )
      )!.json()) as MemoryListBody
      const inB = (await (
        await handleExternalMemoryReadRequest(
          req("/api/v1/external/projects/proj-b/memory", token),
          env(testDb),
        )
      )!.json()) as MemoryListBody
      expect(inA.data[0].createdBy).not.toBe(inB.data[0].createdBy)
    })

    it("a credential minted with the pii grant reads real identities", async () => {
      // Regression (2026-09-17 pen test): this route used to run its own
      // pseudonymizer that never checked the credential's `pii` grant at all,
      // so an OWNER-minted real-identity credential still only ever got
      // pseudonyms here, unlike every other agent-facing read route.
      await seedMemory(testDb, {
        id: "11111111-1111-1111-1111-111111111111",
        path: "decisions/a.md",
        content: "a",
        createdBy: "alice",
        reviewedBy: "owner",
      })
      const token = await seedCredential(testDb, { id: CRED_1, userId: 2, projectId: "proj-a", pii: true })

      const body = (await (
        await handleExternalMemoryReadRequest(
          req("/api/v1/external/projects/proj-a/memory", token),
          env(testDb),
        )
      )!.json()) as MemoryListBody
      expect(body.data[0].createdBy).toBe("alice")
      expect(body.data[0].reviewedBy).toBe("owner")
    })

    it("honors the project's agentAuthorship: 'none' opt-out — fields are absent, not pseudonymous", async () => {
      // Regression (2026-09-17 pen test): this route never consulted the
      // project's agentAuthorship setting, so a project that opted out of all
      // agent-visible identity still got pseudonymous createdBy/reviewedBy
      // back — the same class of gap the comments route had.
      await setAgentAuthorship(testDb, "proj-a", "none")
      await seedMemory(testDb, {
        id: "11111111-1111-1111-1111-111111111111",
        path: "decisions/a.md",
        content: "a",
        createdBy: "alice",
        reviewedBy: "owner",
      })
      const token = await seedCredential(testDb, { id: CRED_1, userId: 2, projectId: "proj-a" })

      const res = await handleExternalMemoryReadRequest(
        req("/api/v1/external/projects/proj-a/memory", token),
        env(testDb),
      )
      const raw = await res!.text()
      expect(raw).not.toContain("alice")
      expect(raw).not.toContain("owner")
      const body = JSON.parse(raw) as MemoryListBody
      expect(body.data[0]).not.toHaveProperty("createdBy")
      expect(body.data[0]).not.toHaveProperty("reviewedBy")

      // And it overrides even a pii credential — the project's choice wins.
      const piiToken = await seedCredential(testDb, {
        id: "00000000-0000-0000-0000-000000000099",
        userId: 2,
        projectId: "proj-a",
        pii: true,
      })
      const piiBody = (await (
        await handleExternalMemoryReadRequest(
          req("/api/v1/external/projects/proj-a/memory", piiToken),
          env(testDb),
        )
      )!.json()) as MemoryListBody
      expect(piiBody.data[0]).not.toHaveProperty("createdBy")
    })
  })

  describe("GET .../files/:fileId/cells/:cellId/memory", () => {
    it("returns exactly what the copilot's retrieval would inject", async () => {
      await seedTranslationBrief(testDb, { l1Summary: "Formal register throughout." })
      await testDb.pg.query(
        `INSERT INTO project_briefs (project_id, content, updated_by, version)
         VALUES ('proj-a', 'Legacy free-text brief.', 'owner', 2)`,
      )
      await seedMemory(testDb, {
        id: "11111111-1111-1111-1111-111111111111",
        path: "decisions/divine-name.md",
        content: "Render Lord as Господь.\nNever Пан: it reads as a landowner.",
        humanEdited: true,
      })
      await seedMemory(testDb, {
        id: "22222222-2222-2222-2222-222222222222",
        path: "examples/pending.md",
        content: "not approved yet",
        status: "proposed",
      })
      const token = await seedCredential(testDb, { id: CRED_1, userId: 2, projectId: "proj-a" })

      const res = await handleExternalMemoryReadRequest(
        req("/api/v1/external/projects/proj-a/files/file-x/cells/cell-1/memory", token),
        env(testDb),
      )
      expect(res!.status).toBe(200)
      const body = (await res!.json()) as CellMemoryBody

      const ctx = await buildMemoryContext(testDb.db, "proj-a")
      expect(body.cell).toEqual({ fileId: "file-x", cellId: "cell-1" })
      // The brief block is the drafting prompt's brief (settings L1); the
      // free-text row the in-app agent's memory context still carries is the
      // legacy one — reported separately, never conflated.
      expect(body.brief.content).toBe("Formal register throughout.")
      expect(body.brief.reachesCopilot).toBe(true)
      const preview = await buildPromptPreview(testDb.db, { projectId: "proj-a", cellId: "cell-1", targetLang: "" })
      expect(preview.ok && preview.body.parts.brief).toBe(buildBriefBlock(body.brief.content))
      expect(body.legacyBrief).toEqual({ content: ctx.brief, version: 2 })
      expect(body.entries.map((e) => e.path)).toEqual(ctx.memoryIndex.map((m) => m.path))
      expect(body.entries.map((e) => e.firstLine)).toEqual(ctx.memoryIndex.map((m) => m.firstLine))
      expect(body.entries[0].humanEdited).toBe(true)
      expect(body.entries[0].kind).toBe("decision")
      // Unapproved entries never reach a prompt, so they are absent here.
      expect(body.entries.some((e) => e.path === "examples/pending.md")).toBe(false)
      // Full text is NOT injected — the prompt carries path + first line only,
      // so the entry's later lines must not appear anywhere in the response.
      expect(body.entries[0].firstLine).toBe("Render Lord as Господь.")
      expect(JSON.stringify(body)).not.toContain("it reads as a landowner")
      expect(body.retrieval.scope).toBe("project")
      expect(body.retrieval.truncated).toBe(false)
    })

    it("reports truncation when approved entries sit past the render cap", async () => {
      for (let i = 0; i < MEMORY_INDEX_RENDER_CAP + 2; i++) {
        await seedMemory(testDb, {
          id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
          path: `decisions/d${i}.md`,
          content: `decision ${i}`,
          updatedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
        })
      }
      const token = await seedCredential(testDb, { id: CRED_1, userId: 2, projectId: "proj-a" })
      const body = (await (
        await handleExternalMemoryReadRequest(
          req("/api/v1/external/projects/proj-a/files/file-x/cells/cell-1/memory", token),
          env(testDb),
        )
      )!.json()) as CellMemoryBody
      expect(body.entries).toHaveLength(MEMORY_INDEX_RENDER_CAP)
      expect(body.retrieval.approvedCount).toBe(MEMORY_INDEX_RENDER_CAP + 2)
      expect(body.retrieval.injectedCount).toBe(MEMORY_INDEX_RENDER_CAP)
      expect(body.retrieval.truncated).toBe(true)
      expect(body.retrieval.note).toContain("2 further approved entries are NOT injected")
    })

    it("404s an unknown cell rather than returning a project-wide dump", async () => {
      const token = await seedCredential(testDb, { id: CRED_1, userId: 2, projectId: "proj-a" })
      const res = await handleExternalMemoryReadRequest(
        req("/api/v1/external/projects/proj-a/files/file-x/cells/nope/memory", token),
        env(testDb),
      )
      expect(res!.status).toBe(404)
      const body = (await res!.json()) as { error: { code: string } }
      expect(body.error.code).toBe("not_found")
    })
  })

  describe("auth, scope, and method", () => {
    it("401s without a credential", async () => {
      const res = await handleExternalMemoryReadRequest(
        req("/api/v1/external/projects/proj-a/memory"),
        env(testDb),
      )
      expect(res!.status).toBe(401)
    })

    it("403s a credential scoped to another project", async () => {
      const token = await seedCredential(testDb, { id: CRED_1, userId: 2, projectId: "proj-b" })
      for (const path of [
        "/api/v1/external/projects/proj-a/memory",
        "/api/v1/external/projects/proj-a/files/file-x/cells/cell-1/memory",
      ]) {
        const res = await handleExternalMemoryReadRequest(req(path, token), env(testDb))
        expect(res!.status).toBe(403)
        const body = (await res!.json()) as { error: { code: string } }
        expect(body.error.code).toBe("scope_denied")
      }
    })

    it("403s a credential whose owner has no membership on the project", async () => {
      await testDb.pg.query(
        `INSERT INTO users (id, username, email, password_hash) VALUES (3, 'stranger', 's@x.com', 'h')`,
      )
      const token = await seedCredential(testDb, {
        id: "00000000-0000-0000-0000-000000000003",
        userId: 3,
        projectId: "proj-a",
      })
      const res = await handleExternalMemoryReadRequest(
        req("/api/v1/external/projects/proj-a/memory", token),
        env(testDb),
      )
      expect(res!.status).toBe(403)
      const body = (await res!.json()) as { error: { code: string } }
      expect(body.error.code).toBe("permission_denied")
    })

    it("throttles a credential over the shared read budget", async () => {
      const token = await seedCredential(testDb, { id: CRED_1, userId: 2, projectId: "proj-a" })
      await testDb.pg.query(
        `INSERT INTO auth_rate_limit_events (kind, identifier, success)
         SELECT 'external_read', $1, 1 FROM generate_series(1, 300)`,
        [`credential:${CRED_1}`],
      )
      const res = await handleExternalMemoryReadRequest(
        req("/api/v1/external/projects/proj-a/memory", token),
        env(testDb),
      )
      expect(res!.status).toBe(429)
    })

    it("405s a write attempt on a memory path, naming GET", async () => {
      const token = await seedCredential(testDb, { id: CRED_1, userId: 2, projectId: "proj-a" })
      const res = await handleExternalMemoryReadRequest(
        req("/api/v1/external/projects/proj-a/memory", token, "POST"),
        env(testDb),
      )
      expect(res!.status).toBe(405)
      expect(res!.headers.get("Allow")).toBe("GET")
    })
  })
})
