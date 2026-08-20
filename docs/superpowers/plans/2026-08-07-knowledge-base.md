# Knowledge Base Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Project/org knowledge base (context documents that aren't translation pairs) surfaced in the Living Memory tab, always readable by the in-app agent and external PAT agents, and — behind one project toggle — feeding draft prompts via plain string search. PageIndex-style tree indexing (heuristic structure + one Haiku enrichment call).

**Architecture:** New `knowledge_docs` Postgres table (org XOR project scoped; originals in the `aquilla-snapshots` R2 bucket under `kb/`); shared domain module `db/shared/knowledge.ts` used by both workers; auth-worker router + async indexer + three agent tools; sync-worker read-only external REST + MCP tools; SPA section in the Living Memory tab; toggle-gated `preSourceBlock` injection in the completion pipeline.

**Tech Stack:** TypeScript, Hono, Zod, `AquillaDb` shim (`db/shim/postgres.ts`), Cloudflare R2, OpenRouter (Haiku), React 19 + Tailwind v4 + shadcn/ui, Vitest (workers-pool + PGlite for auth-worker; happy-dom for SPA).

**Spec:** `docs/superpowers/specs/2026-08-07-knowledge-base-design.md` — read it first.

## Global Constraints

- Role floors: project KB doc writes = `ROLE.PROJECT_LEAD` (500); org KB doc writes = org `MAINTAINER` (600); reads = `ROLE.VIEWER` (project) / any org member (org). Toggle rides `project_settings` (MAINTAINER floor, unchanged).
- One toggle key: `knowledgeBaseEnabled` (boolean, default false) in the `project_settings` blob. Agent access is NEVER gated by it.
- Formats: `.md`/`.txt` stored as-is; `.docx`/`.pdf` via `extractTextFromDocx`/`extractTextFromPdf` from `auth-worker/src/routes/parse-document.ts`. docx/pdf uploads capped at 2 MB (`2_000_000` bytes); all originals capped at 25 MB; `extracted_text` truncated at 2,000,000 chars.
- Originals always kept in R2 (`SNAPSHOTS` binding), key `kb/{project|org}/{scopeId}/{docId}`, honoring `R2_KEY_PREFIX` like `artifactR2Key`.
- Index model: `env.KB_INDEX_MODEL || "anthropic/claude-haiku-4-5"`, called through the same OpenRouter URL resolution as the agent (`OPENROUTER_BASE_URL` override → mock in dev/e2e).
- Tree caps: depth ≤ 3, ≤ 200 nodes. Indexing failure is non-fatal (`index_status='failed'`, doc still string-searchable).
- All KB failures in the draft path degrade silently (no KB block, never a broken draft).
- Error envelope: `{ error: { code, message, details? } }` matching `agent-memory.ts`.
- External API v1 is READ-ONLY (list/search/get/content). No external uploads/deletes.
- TypeScript, no `any`. Match surrounding style. Root `pnpm test` excludes worker packages — run worker suites from their package dirs with `npm test`.

---

### Task 1: DB migration + schema

**Files:**
- Create: `db/postgres/migrations/0074_knowledge_docs.sql`
- Modify: `db/postgres/schema.sql` (append after the `artifact_bindings` section)

**Interfaces:**
- Produces: table `knowledge_docs` with columns exactly as below; later tasks' SQL depends on these names.

- [ ] **Step 1: Write the migration**

`db/postgres/migrations/0074_knowledge_docs.sql`:

```sql
-- Knowledge base documents (spec: docs/superpowers/specs/2026-08-07-knowledge-base-design.md).
-- Org XOR project scoped context documents; originals in R2 (kb/ prefix),
-- extracted text + PageIndex-style tree here.
CREATE TABLE knowledge_docs (
    id UUID PRIMARY KEY,
    org_id BIGINT REFERENCES organizations(id) ON DELETE CASCADE,
    project_id TEXT,
    name TEXT NOT NULL,
    content_type TEXT,
    size_bytes BIGINT NOT NULL,
    sha256 TEXT NOT NULL,
    r2_key TEXT NOT NULL,
    extracted_text TEXT NOT NULL,
    doc_summary TEXT,
    index_status TEXT NOT NULL DEFAULT 'pending'
      CHECK (index_status IN ('pending','ready','failed')),
    index_tree JSONB,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((org_id IS NULL) <> (project_id IS NULL))
);
CREATE INDEX knowledge_docs_project ON knowledge_docs (project_id) WHERE project_id IS NOT NULL;
CREATE INDEX knowledge_docs_org ON knowledge_docs (org_id) WHERE org_id IS NOT NULL;
```

- [ ] **Step 2: Append the same DDL to `db/postgres/schema.sql`** (the live-schema file the PGlite test env loads), with the same comment header, placed after the `artifact_bindings` block. Keep byte-identical DDL.

- [ ] **Step 3: Verify the test env picks it up**

Run: `cd auth-worker && npm test -- agent-artifacts` (any quick suite). Expected: PASS (schema loads without error — a syntax error in schema.sql fails every test at setup).

- [ ] **Step 4: Check migration status tooling recognizes it**

Run: `pnpm neon:status` (from repo root). Expected: `0074_knowledge_docs.sql` listed as pending. Do NOT apply to Neon in this task — rollout happens at deploy per `db/rollout/` conventions.

- [ ] **Step 5: Commit**

```bash
git add db/postgres/migrations/0074_knowledge_docs.sql db/postgres/schema.sql
git commit -m "feat(kb): knowledge_docs table migration"
```

---

### Task 2: Shared domain module `db/shared/knowledge.ts`

**Files:**
- Create: `db/shared/knowledge.ts`
- Test: `auth-worker/src/__tests__/knowledge-shared.test.ts`

**Interfaces:**
- Consumes: `AquillaDb` from `db/shim/postgres.ts`; `knowledge_docs` table (Task 1).
- Produces (exact exports later tasks import):

```ts
export type KnowledgeIndexStatus = "pending" | "ready" | "failed"
export interface KnowledgeNode {
  id: string            // "n1", "n1.2", … stable within a doc
  title: string
  summary?: string
  charStart: number     // inclusive index into extracted_text
  charEnd: number       // exclusive
  children?: KnowledgeNode[]
}
export interface KnowledgeDocMeta {
  id: string
  orgId: number | null
  projectId: string | null
  scope: "project" | "org"
  name: string
  contentType: string | null
  sizeBytes: number
  sha256: string
  r2Key: string
  docSummary: string | null
  indexStatus: KnowledgeIndexStatus
  createdBy: string
  createdAt: string
  updatedAt: string
}
export interface KnowledgeSnippet { docId: string; docName: string; snippet: string }
export const MAX_KB_ORIGINAL_BYTES = 25 * 1024 * 1024
export const MAX_KB_EXTRACT_INPUT_BYTES = 2_000_000   // docx/pdf raw-bytes cap
export const MAX_KB_TEXT_CHARS = 2_000_000            // extracted_text truncation
export const KB_EXTENSIONS = [".md", ".txt", ".docx", ".pdf"] as const
export function kbExtension(name: string): (typeof KB_EXTENSIONS)[number] | null
export function kbR2Key(prefix: string | undefined, scope: KnowledgeScopeRef, docId: string): string
export type KnowledgeScopeRef = { projectId: string } | { orgId: number }
export async function createDoc(db: AquillaDb, doc: { id: string; scope: KnowledgeScopeRef; name: string; contentType: string | null; sizeBytes: number; sha256: string; r2Key: string; extractedText: string; createdBy: string }): Promise<void>
export async function listProjectDocs(db: AquillaDb, projectId: string): Promise<KnowledgeDocMeta[]>   // project docs + inherited org docs
export async function listOrgDocs(db: AquillaDb, orgId: number): Promise<KnowledgeDocMeta[]>
export async function getDocMeta(db: AquillaDb, docId: string): Promise<KnowledgeDocMeta | null>
export async function getDocTree(db: AquillaDb, docId: string): Promise<{ meta: KnowledgeDocMeta; tree: KnowledgeNode[] | null } | null>
export async function getDocText(db: AquillaDb, docId: string, nodeId?: string): Promise<{ meta: KnowledgeDocMeta; text: string } | null>  // nodeId → node substring; unknown nodeId → null
export async function deleteDoc(db: AquillaDb, docId: string): Promise<string | null>                   // returns r2Key of deleted row
export async function setIndexResult(db: AquillaDb, docId: string, status: KnowledgeIndexStatus, tree: KnowledgeNode[] | null, docSummary: string | null): Promise<void>
export async function searchKnowledge(db: AquillaDb, projectId: string, q: string, limit?: number): Promise<KnowledgeSnippet[]>   // limit default 5; project + inherited org docs
export function resolveNode(tree: KnowledgeNode[] | null, nodeId: string): KnowledgeNode | null
export function flattenNodes(tree: KnowledgeNode[] | null): KnowledgeNode[]
```

- [ ] **Step 1: Write the failing tests**

`auth-worker/src/__tests__/knowledge-shared.test.ts` — follow the header-comment style of `agent-memory.test.ts` (state WHY: org inheritance and node-addressed reads are the contracts agents rely on). Setup helpers mirror that file (`env.AQUILLA_PG` from `cloudflare:test`). Seed: `INSERT INTO organizations (id, name) VALUES (?, ?)` (check the exact columns at the top of `db/postgres/schema.sql` and match them), a project row with `org_id` set, then use `createDoc`.

Test cases (write all of them now):

```ts
import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import {
  createDoc, listProjectDocs, listOrgDocs, getDocMeta, getDocTree, getDocText,
  deleteDoc, setIndexResult, searchKnowledge, resolveNode, kbExtension, kbR2Key,
  type KnowledgeNode,
} from "../../../db/shared/knowledge"

const TEXT = "# Alpha\nThe quick brown fox.\n\n# Beta\nJumps over the lazy dog."

function nodeFixture(): KnowledgeNode[] {
  return [
    { id: "n1", title: "Alpha", charStart: 0, charEnd: 29 },
    { id: "n2", title: "Beta", charStart: 30, charEnd: TEXT.length },
  ]
}

async function seedScope() {
  await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name) VALUES (?, ?)").bind(77, "Org").run()
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by, org_id) VALUES (?, ?, ?, ?)")
    .bind("proj-kb", "KB Project", 1, 77).run()
}

async function seedDoc(id: string, scope: { projectId: string } | { orgId: number }, name = "guide.md") {
  await createDoc(env.AQUILLA_PG, {
    id, scope, name, contentType: "text/markdown", sizeBytes: TEXT.length,
    sha256: "abc", r2Key: `kb/x/${id}`, extractedText: TEXT, createdBy: "ryder",
  })
}

describe("knowledge shared primitives", () => {
  it("listProjectDocs returns project docs AND inherits org docs, scope-tagged", async () => {
    await seedScope()
    await seedDoc("11111111-1111-1111-1111-111111111111", { projectId: "proj-kb" }, "proj.md")
    await seedDoc("22222222-2222-2222-2222-222222222222", { orgId: 77 }, "org.md")
    const docs = await listProjectDocs(env.AQUILLA_PG, "proj-kb")
    expect(docs.map((d) => [d.name, d.scope]).sort()).toEqual([["org.md", "org"], ["proj.md", "project"]])
  })

  it("getDocText resolves a nodeId to its char-range substring; unknown nodeId → null", async () => {
    await seedScope()
    await seedDoc("33333333-3333-3333-3333-333333333333", { projectId: "proj-kb" })
    await setIndexResult(env.AQUILLA_PG, "33333333-3333-3333-3333-333333333333", "ready", nodeFixture(), "sum")
    const node = await getDocText(env.AQUILLA_PG, "33333333-3333-3333-3333-333333333333", "n2")
    expect(node?.text).toBe(TEXT.slice(30))
    expect(await getDocText(env.AQUILLA_PG, "33333333-3333-3333-3333-333333333333", "nope")).toBeNull()
  })

  it("searchKnowledge finds case-insensitive matches across project + org docs with a snippet window", async () => {
    await seedScope()
    await seedDoc("44444444-4444-4444-4444-444444444444", { orgId: 77 }, "org.md")
    const hits = await searchKnowledge(env.AQUILLA_PG, "proj-kb", "LAZY DOG")
    expect(hits).toHaveLength(1)
    expect(hits[0].docName).toBe("org.md")
    expect(hits[0].snippet).toContain("lazy dog")
  })

  it("searchKnowledge returns [] on no match and never throws on % or _ in the query", async () => {
    await seedScope()
    await seedDoc("55555555-5555-5555-5555-555555555555", { projectId: "proj-kb" })
    expect(await searchKnowledge(env.AQUILLA_PG, "proj-kb", "zzz%_zzz")).toEqual([])
  })

  it("deleteDoc returns the r2Key and removes the row", async () => {
    await seedScope()
    await seedDoc("66666666-6666-6666-6666-666666666666", { projectId: "proj-kb" })
    expect(await deleteDoc(env.AQUILLA_PG, "66666666-6666-6666-6666-666666666666")).toBe("kb/x/66666666-6666-6666-6666-666666666666")
    expect(await getDocMeta(env.AQUILLA_PG, "66666666-6666-6666-6666-666666666666")).toBeNull()
  })

  it("setIndexResult('failed') leaves the doc listed and searchable", async () => {
    await seedScope()
    await seedDoc("77777777-7777-7777-7777-777777777777", { projectId: "proj-kb" })
    await setIndexResult(env.AQUILLA_PG, "77777777-7777-7777-7777-777777777777", "failed", null, null)
    expect((await listProjectDocs(env.AQUILLA_PG, "proj-kb"))[0].indexStatus).toBe("failed")
    expect(await searchKnowledge(env.AQUILLA_PG, "proj-kb", "quick brown")).toHaveLength(1)
  })

  it("kbExtension + kbR2Key helpers", () => {
    expect(kbExtension("Style Guide.DOCX")).toBe(".docx")
    expect(kbExtension("noext")).toBeNull()
    expect(kbR2Key(undefined, { projectId: "p1" }, "d1")).toBe("kb/project/p1/d1")
    expect(kbR2Key("pre", { orgId: 9 }, "d2")).toBe("pre/kb/org/9/d2")
  })

  it("resolveNode walks children", () => {
    const tree: KnowledgeNode[] = [{ id: "n1", title: "A", charStart: 0, charEnd: 10,
      children: [{ id: "n1.1", title: "A1", charStart: 0, charEnd: 5 }] }]
    expect(resolveNode(tree, "n1.1")?.title).toBe("A1")
    expect(resolveNode(tree, "nx")).toBeNull()
  })
})
```

If `organizations` has more NOT NULL columns than `(id, name)`, extend the seed insert to satisfy them (read the table definition; do not weaken the test).

- [ ] **Step 2: Run to verify failure**

Run: `cd auth-worker && npm test -- knowledge-shared`
Expected: FAIL — module `db/shared/knowledge` not found.

- [ ] **Step 3: Implement `db/shared/knowledge.ts`**

Header comment mirrors `db/shared/agent-memory.ts` (shared by auth-worker routes, harness tools, and sync-worker external reads; takes bare `AquillaDb`; no HTTP). Implementation:

```ts
import type { AquillaDb } from "../shim/postgres"

// … (types exactly as the Interfaces block above) …

const META_COLS = `id, org_id, project_id, name, content_type, size_bytes, sha256,
  r2_key, doc_summary, index_status, created_by, created_at, updated_at`

interface Row {
  id: string; org_id: number | null; project_id: string | null; name: string
  content_type: string | null; size_bytes: number; sha256: string; r2_key: string
  doc_summary: string | null; index_status: string; created_by: string
  created_at: string; updated_at: string
}

function rowToMeta(r: Row): KnowledgeDocMeta {
  return {
    id: r.id, orgId: r.org_id, projectId: r.project_id,
    scope: r.project_id != null ? "project" : "org",
    name: r.name, contentType: r.content_type, sizeBytes: r.size_bytes,
    sha256: r.sha256, r2Key: r.r2_key, docSummary: r.doc_summary,
    indexStatus: r.index_status as KnowledgeIndexStatus,
    createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
  }
}

export function kbExtension(name: string): (typeof KB_EXTENSIONS)[number] | null {
  const dot = name.lastIndexOf(".")
  if (dot < 0) return null
  const ext = name.slice(dot).toLowerCase()
  return (KB_EXTENSIONS as readonly string[]).includes(ext)
    ? (ext as (typeof KB_EXTENSIONS)[number])
    : null
}

export function kbR2Key(prefix: string | undefined, scope: KnowledgeScopeRef, docId: string): string {
  const p = prefix?.trim().replace(/^\/+|\/+$/g, "") ?? ""
  const pre = p ? `${p}/` : ""
  return "projectId" in scope
    ? `${pre}kb/project/${scope.projectId}/${docId}`
    : `${pre}kb/org/${scope.orgId}/${docId}`
}

export async function createDoc(db: AquillaDb, doc: { /* as in Interfaces */ }): Promise<void> {
  const orgId = "orgId" in doc.scope ? doc.scope.orgId : null
  const projectId = "projectId" in doc.scope ? doc.scope.projectId : null
  await db.prepare(
    `INSERT INTO knowledge_docs
       (id, org_id, project_id, name, content_type, size_bytes, sha256, r2_key, extracted_text, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(doc.id, orgId, projectId, doc.name, doc.contentType, doc.sizeBytes,
         doc.sha256, doc.r2Key, doc.extractedText, doc.createdBy).run()
}

export async function listProjectDocs(db: AquillaDb, projectId: string): Promise<KnowledgeDocMeta[]> {
  const { results } = await db.prepare(
    `SELECT ${META_COLS} FROM knowledge_docs
     WHERE project_id = ?
        OR org_id = (SELECT org_id FROM projects WHERE id = ?)
     ORDER BY created_at DESC`,
  ).bind(projectId, projectId).all<Row>()
  return results.map(rowToMeta)
}

export async function searchKnowledge(
  db: AquillaDb, projectId: string, q: string, limit = 5,
): Promise<KnowledgeSnippet[]> {
  const needle = q.trim().toLowerCase()
  if (!needle) return []
  // position() is plain substring search — no LIKE wildcards to escape.
  const { results } = await db.prepare(
    `SELECT id, name,
            substr(extracted_text,
                   GREATEST(position(? in lower(extracted_text)) - 240, 1),
                   560) AS snippet
     FROM knowledge_docs
     WHERE (project_id = ? OR org_id = (SELECT org_id FROM projects WHERE id = ?))
       AND position(? in lower(extracted_text)) > 0
     ORDER BY updated_at DESC
     LIMIT ?`,
  ).bind(needle, projectId, projectId, needle, limit)
    .all<{ id: string; name: string; snippet: string }>()
  return results.map((r) => ({ docId: r.id, docName: r.name, snippet: r.snippet.trim() }))
}

export function flattenNodes(tree: KnowledgeNode[] | null): KnowledgeNode[] {
  if (!tree) return []
  const out: KnowledgeNode[] = []
  const walk = (nodes: KnowledgeNode[]) => {
    for (const n of nodes) { out.push(n); if (n.children) walk(n.children) }
  }
  walk(tree)
  return out
}

export function resolveNode(tree: KnowledgeNode[] | null, nodeId: string): KnowledgeNode | null {
  return flattenNodes(tree).find((n) => n.id === nodeId) ?? null
}
```

Remaining functions are straightforward single statements: `listOrgDocs` (`WHERE org_id = ?`), `getDocMeta` (`WHERE id = ?` → `rowToMeta` or null), `getDocTree` (also select `index_tree`; JSONB comes back as an object from postgres.js and as an object from PGlite — if it arrives as a string, `JSON.parse` it: `typeof raw === "string" ? JSON.parse(raw) : raw`), `getDocText` (select `extracted_text` + `index_tree`; no nodeId → full text; nodeId → `resolveNode` then `text.slice(charStart, charEnd)`, null if node missing), `deleteDoc` (`DELETE … RETURNING r2_key` via `.first<{ r2_key: string }>()`), `setIndexResult` (`UPDATE knowledge_docs SET index_status=?, index_tree=?, doc_summary=?, updated_at=now() WHERE id=?` — bind tree as `tree ? JSON.stringify(tree) : null` and cast in SQL: `index_tree = ?::jsonb`).

- [ ] **Step 4: Run to verify pass**

Run: `cd auth-worker && npm test -- knowledge-shared`
Expected: PASS (all 8).

- [ ] **Step 5: Commit**

```bash
git add db/shared/knowledge.ts auth-worker/src/__tests__/knowledge-shared.test.ts
git commit -m "feat(kb): shared knowledge_docs domain module (CRUD, org inheritance, search, node reads)"
```

---

### Task 3: Tree builder + async indexer

**Files:**
- Create: `auth-worker/src/lib/knowledge/index-doc.ts`
- Test: `auth-worker/src/__tests__/knowledge-index.test.ts`

**Interfaces:**
- Consumes: `setIndexResult`, `getDocText`, `KnowledgeNode` from `db/shared/knowledge`.
- Produces:

```ts
export function segmentText(text: string): KnowledgeNode[]          // heuristic tree, no LLM
export function buildEnrichmentPrompt(docName: string, text: string, nodes: KnowledgeNode[]): string
export function applyEnrichment(nodes: KnowledgeNode[], raw: string): { tree: KnowledgeNode[]; docSummary: string | null }  // throws on unparseable
export async function indexKnowledgeDoc(env: KbIndexEnv, db: AquillaDb, docId: string): Promise<void>  // never throws
export interface KbIndexEnv { OPENROUTER_API_KEY?: string; OPENROUTER_BASE_URL?: string; KB_INDEX_MODEL?: string }
```

- [ ] **Step 1: Write the failing tests**

`auth-worker/src/__tests__/knowledge-index.test.ts`:

```ts
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
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd auth-worker && npm test -- knowledge-index`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `auth-worker/src/lib/knowledge/index-doc.ts`**

```ts
// PageIndex-style indexing (spec §"Data model"): structure comes from
// heuristics (markdown headings, else paragraph blocks), the LLM only writes
// summaries — one Haiku call per document, made async from the upload route
// via ctx.waitUntil. Failure is non-fatal: docs stay string-searchable.
import type { AquillaDb } from "../../../../db/shim/postgres"
import {
  getDocText, setIndexResult, type KnowledgeNode,
} from "../../../../db/shared/knowledge"

export interface KbIndexEnv {
  OPENROUTER_API_KEY?: string
  OPENROUTER_BASE_URL?: string
  KB_INDEX_MODEL?: string
}

const MAX_NODES = 200
const MAX_DEPTH = 3
const BLOCK_TARGET = 2000
export const DEFAULT_KB_INDEX_MODEL = "anthropic/claude-haiku-4-5"

const HEADING_RE = /^(#{1,3})\s+(.+)$/gm

export function segmentText(text: string): KnowledgeNode[] {
  const headings: { level: number; title: string; start: number }[] = []
  for (const m of text.matchAll(HEADING_RE)) {
    headings.push({ level: m[1].length, title: m[2].trim(), start: m.index ?? 0 })
  }
  let flat: { level: number; title: string; charStart: number; charEnd: number }[]
  if (headings.length >= 2) {
    flat = headings.slice(0, MAX_NODES).map((h, i, arr) => ({
      level: Math.min(h.level, MAX_DEPTH),
      title: h.title,
      charStart: h.start,
      charEnd: i + 1 < arr.length ? arr[i + 1].start - 1 : text.length,
    }))
    // Preamble before the first heading becomes its own node.
    if (headings[0].start > 0) {
      flat.unshift({ level: 1, title: "Introduction", charStart: 0, charEnd: headings[0].start - 1 })
    }
  } else {
    // Headingless: greedy paragraph blocks of ~BLOCK_TARGET chars.
    flat = []
    let start = 0
    while (start < text.length && flat.length < MAX_NODES) {
      let end = Math.min(start + BLOCK_TARGET, text.length)
      if (end < text.length) {
        const brk = text.lastIndexOf("\n\n", end)
        if (brk > start) end = brk
      }
      if (end >= text.length || flat.length === MAX_NODES - 1) end = text.length
      const firstLine = text.slice(start, end).trimStart().split("\n", 1)[0]
      flat.push({ level: 1, title: firstLine.slice(0, 80) || `Part ${flat.length + 1}`, charStart: start, charEnd: end })
      start = end
      while (start < text.length && text[start] === "\n") start++
    }
    if (flat.length) flat[flat.length - 1].charEnd = text.length
  }
  // Nest by heading level (stack-based), assign hierarchical ids n1, n1.1, …
  const roots: KnowledgeNode[] = []
  const stack: { node: KnowledgeNode; level: number }[] = []
  for (const f of flat) {
    const node: KnowledgeNode = { id: "", title: f.title, charStart: f.charStart, charEnd: f.charEnd }
    while (stack.length && stack[stack.length - 1].level >= f.level) stack.pop()
    if (!stack.length) {
      node.id = `n${roots.length + 1}`
      roots.push(node)
    } else {
      const parent = stack[stack.length - 1].node
      parent.children = parent.children ?? []
      node.id = `${parent.id}.${parent.children.length + 1}`
      parent.children.push(node)
      // A parent's range must cover its children.
      parent.charEnd = Math.max(parent.charEnd, node.charEnd)
    }
    stack.push({ node, level: f.level })
  }
  return roots
}

export function buildEnrichmentPrompt(docName: string, text: string, nodes: KnowledgeNode[]): string {
  const flat: string[] = []
  const walk = (ns: KnowledgeNode[]) => {
    for (const n of ns) {
      flat.push(`${n.id}: "${n.title}"\n${text.slice(n.charStart, Math.min(n.charEnd, n.charStart + 1200))}`)
      if (n.children) walk(n.children)
    }
  }
  walk(nodes)
  return [
    `Document: ${docName}. Below are its sections (id, title, opening text).`,
    `Return ONLY JSON: {"docSummary": "<2-3 sentence summary of the whole document>",`,
    ` "nodes": [{"id": "<section id>", "summary": "<1-2 sentence section summary>"}]}.`,
    `Cover every section id exactly once.`,
    "",
    flat.join("\n---\n"),
  ].join("\n")
}

export function applyEnrichment(
  nodes: KnowledgeNode[], raw: string,
): { tree: KnowledgeNode[]; docSummary: string | null } {
  // Models sometimes wrap JSON in a code fence — strip it before parsing.
  const cleaned = raw.trim().replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "")
  const parsed = JSON.parse(cleaned) as { docSummary?: string; nodes?: { id: string; summary?: string }[] }
  const byId = new Map((parsed.nodes ?? []).map((n) => [n.id, n.summary]))
  const walk = (ns: KnowledgeNode[]) => {
    for (const n of ns) {
      const s = byId.get(n.id)
      if (s) n.summary = s
      if (n.children) walk(n.children)
    }
  }
  walk(nodes)
  return { tree: nodes, docSummary: parsed.docSummary?.trim() || null }
}

function openRouterUrl(env: KbIndexEnv): string {
  return env.OPENROUTER_BASE_URL
    ? `${env.OPENROUTER_BASE_URL.replace(/\/$/, "")}/chat/completions`
    : "https://openrouter.ai/api/v1/chat/completions"
}

/** Build + persist the index for one doc. Never throws — any failure lands as
 *  index_status='failed' (the doc remains string-searchable, spec §Error handling). */
export async function indexKnowledgeDoc(env: KbIndexEnv, db: AquillaDb, docId: string): Promise<void> {
  try {
    const doc = await getDocText(db, docId)
    if (!doc) return
    const nodes = segmentText(doc.text)
    if (!env.OPENROUTER_API_KEY) throw new Error("no OPENROUTER_API_KEY")
    const res = await fetch(openRouterUrl(env), {
      method: "POST",
      headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: env.KB_INDEX_MODEL || DEFAULT_KB_INDEX_MODEL,
        messages: [{ role: "user", content: buildEnrichmentPrompt(doc.meta.name, doc.text, nodes) }],
        response_format: { type: "json_object" },
      }),
    })
    if (!res.ok) throw new Error(`openrouter ${res.status}`)
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    const content = body.choices?.[0]?.message?.content ?? ""
    const { tree, docSummary } = applyEnrichment(nodes, content)
    await setIndexResult(db, docId, "ready", tree, docSummary)
  } catch {
    await setIndexResult(db, docId, "failed", null, null).catch(() => {})
  }
}
```

Adjust the headingless-fallback details until the three `segmentText` tests pass — the contract is the tests, not the sketch above (tiling ranges, cap 200, first block starts at 0, last block ends at `text.length`).

- [ ] **Step 4: Run to verify pass**

Run: `cd auth-worker && npm test -- knowledge-index`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add auth-worker/src/lib/knowledge/index-doc.ts auth-worker/src/__tests__/knowledge-index.test.ts
git commit -m "feat(kb): heuristic tree segmentation + haiku enrichment indexer"
```

---

### Task 4: auth-worker knowledge router (project + org)

**Files:**
- Create: `auth-worker/src/routes/knowledge.ts`
- Modify: `auth-worker/src/index.ts` (mount both routers next to the agent-memory mounts, ~L240-250)
- Modify: `auth-worker/src/routes/parse-document.ts` (no logic change — `extractTextFromDocx`/`extractTextFromPdf` are already exported; import them)
- Test: `auth-worker/src/__tests__/knowledge-routes.test.ts`

**Interfaces:**
- Consumes: Task 2 module; Task 3 `indexKnowledgeDoc`; `resolveProjectRole`, `getEffectiveOrgRole` (`auth-worker/src/services/org-permissions.ts:143`), `ROLE` from `../types`; `SNAPSHOTS` R2 binding; `extractTextFromDocx`/`extractTextFromPdf`.
- Produces routes (see table). Response shapes:
  - list → `{ docs: KnowledgeDocMeta[] }`
  - get → `{ doc: KnowledgeDocMeta, tree: KnowledgeNode[] | null }`
  - content → `{ text: string }`
  - search → `{ snippets: KnowledgeSnippet[] }`
  - upload → 201 `{ doc: KnowledgeDocMeta }`
  - reindex → 202 `{ ok: true }`

| Route | Floor |
|---|---|
| `GET  /api/v2/projects/:projectId/knowledge` | ROLE.VIEWER |
| `GET  /api/v2/projects/:projectId/knowledge/search?q=&limit=` | ROLE.VIEWER |
| `GET  /api/v2/projects/:projectId/knowledge/:docId` | ROLE.VIEWER |
| `GET  /api/v2/projects/:projectId/knowledge/:docId/content?nodeId=` | ROLE.VIEWER |
| `GET  /api/v2/projects/:projectId/knowledge/:docId/original` | ROLE.VIEWER |
| `POST /api/v2/projects/:projectId/knowledge` | ROLE.PROJECT_LEAD |
| `DELETE /api/v2/projects/:projectId/knowledge/:docId` | ROLE.PROJECT_LEAD |
| `POST /api/v2/projects/:projectId/knowledge/:docId/reindex` | ROLE.PROJECT_LEAD |
| `GET  /api/v2/orgs/:orgId/knowledge` (+`/:docId`, `/:docId/content`, `/:docId/original`) | any org member |
| `POST /api/v2/orgs/:orgId/knowledge`, `DELETE /:docId`, `POST /:docId/reindex` | org role ≥ 600 (MAINTAINER) |

Scoping rules the handlers must enforce (beyond the role floor):
- Project doc routes accept a `docId` that is EITHER a doc with `project_id = :projectId` OR an org doc whose `org_id` equals the project's org (inherited read). Project-scope WRITES (delete/reindex) only apply to `project_id = :projectId` docs — deleting an inherited org doc from a project route → 403 `permission_denied` with message "org documents are managed at the org level".
- Org routes only touch `org_id = :orgId` docs.

- [ ] **Step 1: Write the failing tests**

`auth-worker/src/__tests__/knowledge-routes.test.ts`, using the `agent-memory.test.ts` harness (`app` from `../index`, `seedUser`/`jwtFor`/`authHeader` from `./helpers/db`, `env.AQUILLA_PG`). Also seed an org and org membership: read `./helpers/db` and the top of `agent-memory.test.ts`/`org-settings` tests for the exact `org_members` insert (`INSERT INTO org_members (org_id, user_id, role_level) VALUES (?, ?, ?)` — confirm column names against `db/postgres/schema.sql:78-84`). Mock the R2 binding if the test env lacks one: check how `agent-artifacts.test.ts` handles `env.SNAPSHOTS` and copy that approach exactly. Stub `fetch` (as in Task 3) so the waitUntil indexing call hits the stub, or assert `index_status` is `pending|failed` without awaiting it.

Cases (write them all):

1. **upload floor**: CONTRIBUTOR (400) POST → 403; PROJECT_LEAD (500) POST `.md` body with `x-doc-name: guide.md` → 201, response `doc.indexStatus === "pending"`, row exists, R2 object exists at `doc.r2Key`.
2. **viewer reads**: VIEWER (100) can `GET /knowledge` (sees the doc), `GET /:docId`, `GET /:docId/content`, `GET /:docId/original` (bytes round-trip), `GET /knowledge/search?q=` (snippet hit). Non-member → 403 on all.
3. **org inheritance**: org doc uploaded via org route by an org MAINTAINER appears in the project list with `scope: "org"`; project VIEWER can read its content; project PROJECT_LEAD `DELETE` on it → 403.
4. **org floors**: org member below 600 → 403 on org POST/DELETE; org MAINTAINER → 201/200. Non-member GET → 403.
5. **validation**: missing `x-doc-name` → 400; unsupported extension (`x-doc-name: a.exe`) → 400; empty body → 400; `.docx` body over 2 MB → 400; extraction yielding empty text (send a `.docx` of garbage bytes) → 422.
6. **delete cleans R2**: DELETE → 200, row gone, `env.SNAPSHOTS.get(r2Key)` null.
7. **reindex**: PROJECT_LEAD POST `/:docId/reindex` → 202 and `index_status` returns to a terminal state after the stubbed fetch resolves (with the fetch stub from Task 3's happy path, expect `ready`).

- [ ] **Step 2: Run to verify failure**

Run: `cd auth-worker && npm test -- knowledge-routes`
Expected: FAIL — 404s (router not mounted).

- [ ] **Step 3: Implement `auth-worker/src/routes/knowledge.ts`**

One file, two exported Hono routers sharing helpers:

```ts
// Knowledge base HTTP surface (spec: docs/superpowers/specs/2026-08-07-knowledge-base-design.md).
// projectKnowledge mounts at /api/v2/projects, orgKnowledge at /api/v2/orgs.
// Originals live in R2 (SNAPSHOTS) under kb/…; extracted text + tree in
// knowledge_docs via db/shared/knowledge.ts. Indexing runs async (waitUntil).
import { Hono, type Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"
import { ROLE } from "../types"
import { resolveProjectRole } from "../services/project-permissions"
import { getEffectiveOrgRole } from "../services/org-permissions"
import { extractTextFromDocx, extractTextFromPdf } from "./parse-document"
import { indexKnowledgeDoc } from "../lib/knowledge/index-doc"
import {
  createDoc, listProjectDocs, listOrgDocs, getDocMeta, getDocTree, getDocText,
  deleteDoc, searchKnowledge, kbExtension, kbR2Key,
  MAX_KB_ORIGINAL_BYTES, MAX_KB_EXTRACT_INPUT_BYTES, MAX_KB_TEXT_CHARS,
  type KnowledgeScopeRef,
} from "../../../db/shared/knowledge"

type ErrorCode = "not_found" | "permission_denied" | "validation_failed" | "storage_unavailable" | "job_failed"
function errorJson(code: ErrorCode, message: string, status: ContentfulStatusCode) {
  return { body: { error: { code, message } }, status } as const
}
```

Shared internals:

- `safeDecode` + `sha256Hex` — copy verbatim from `agent-artifacts.ts:59-70` (same semantics; keeping the route self-contained mirrors how agent-artifacts did it).
- `extractText(fileName, bytes): { ok: true; text: string } | { ok: false; code: ErrorCode; message: string; status: ContentfulStatusCode }`:
  - `.md`/`.txt` → `new TextDecoder().decode(bytes)`
  - `.docx`/`.pdf` → reject over `MAX_KB_EXTRACT_INPUT_BYTES`; call the extractor in try/catch (extractor throw → 422 `validation_failed` "could not extract text")
  - empty/whitespace-only result → 422 `validation_failed` "document contains no extractable text"
  - truncate to `MAX_KB_TEXT_CHARS`.
- `handleUpload(c, scope: KnowledgeScopeRef, createdBy: string)` — bytes from `c.req.arrayBuffer()`; validate name (`x-doc-name` header, `safeDecode`, `kbExtension` non-null), non-empty, ≤ `MAX_KB_ORIGINAL_BYTES`; `extractText`; `crypto.randomUUID()`; `kbR2Key(c.env.R2_KEY_PREFIX, scope, id)`; `bucket.put` with contentType; `createDoc` in try/catch with R2 rollback (`bucket.delete(r2Key).catch(() => {})`) exactly like `agent-artifacts.ts:146-151`; then `c.executionCtx.waitUntil(indexKnowledgeDoc(c.env, c.env.AQUILLA_PG, id))`; return 201 `{ doc: await getDocMeta(...) }`.
- `handleDelete(c, docId, scopeCheck)` — `getDocMeta`; 404 if missing; scope check (see rules above); `deleteDoc`; `bucket.delete(r2Key).catch(() => {})`; `{ ok: true }`.
- `handleOriginal(c, meta)` — `bucket.get(meta.r2Key)`; 404 if null; stream with headers `Content-Type: meta.contentType ?? "application/octet-stream"` and `Content-Disposition: inline; filename*=UTF-8''${encodeURIComponent(meta.name)}`.

Project router (`requireRole` helper copied from `agent-memory.ts:70-86`):

```ts
export const projectKnowledge = new Hono<AuthHonoEnv>()

/** A doc is visible from a project when it belongs to it or to its org. */
async function projectVisibleDoc(c: Context<AuthHonoEnv>, projectId: string, docId: string) {
  const meta = await getDocMeta(c.env.AQUILLA_PG, docId)
  if (!meta) return null
  if (meta.projectId === projectId) return meta
  if (meta.orgId != null) {
    const row = await c.env.AQUILLA_PG.prepare("SELECT org_id FROM projects WHERE id = ?")
      .bind(projectId).first<number>("org_id")
    if (row != null && row === meta.orgId) return meta
  }
  return null
}

projectKnowledge.get("/:projectId/knowledge", authMiddleware, async (c) => {
  const projectId = c.req.param("projectId") ?? ""
  const gate = await requireRole(c, projectId, ROLE.VIEWER)
  if (!gate.ok) return gate.res
  return c.json({ docs: await listProjectDocs(c.env.AQUILLA_PG, projectId) })
})

projectKnowledge.get("/:projectId/knowledge/search", authMiddleware, async (c) => {
  const projectId = c.req.param("projectId") ?? ""
  const gate = await requireRole(c, projectId, ROLE.VIEWER)
  if (!gate.ok) return gate.res
  const q = c.req.query("q") ?? ""
  const limit = Math.min(Number.parseInt(c.req.query("limit") ?? "5", 10) || 5, 20)
  return c.json({ snippets: await searchKnowledge(c.env.AQUILLA_PG, projectId, q, limit) })
})
```

…and the remaining project routes following the same shape (`/:docId` → `getDocTree` on a `projectVisibleDoc`; `/:docId/content` → `getDocText` (404 also for unknown `nodeId`); `/:docId/original` → `handleOriginal`; POST → PROJECT_LEAD gate then `handleUpload(c, { projectId }, user.username ?? String(user.id))` — check what `c.get("user")` exposes in `middleware/auth` and store the same identifier `agent-artifacts` stores; DELETE/reindex → PROJECT_LEAD gate, and 403 when `meta.projectId !== projectId`). Reindex sets nothing synchronously; it just `waitUntil(indexKnowledgeDoc(...))` after an `UPDATE knowledge_docs SET index_status='pending' WHERE id = ?` and returns 202.

Org router: same routes minus `search`, with `const role = await getEffectiveOrgRole(c.env, orgId, user)`; reads require `role != null`, writes require `role >= 600`. Org `orgId` parsed with `Number.parseInt` + finite check (copy `org-settings.ts:167-168`).

**Route-order caveat:** register `/:projectId/knowledge/search` BEFORE `/:projectId/knowledge/:docId`, or "search" will be captured as a docId.

Mount in `auth-worker/src/index.ts` next to the agent-memory mount (~L240):

```ts
import { projectKnowledge, orgKnowledge } from "./routes/knowledge"
app.route("/api/v2/projects", projectKnowledge)
app.route("/api/v2/orgs", orgKnowledge)
```

- [ ] **Step 4: Run to verify pass**

Run: `cd auth-worker && npm test -- knowledge-routes`
Expected: PASS (all cases from Step 1).

- [ ] **Step 5: Run the whole auth-worker suite for regressions**

Run: `cd auth-worker && npm test`
Expected: PASS (no existing route captured by the new mounts).

- [ ] **Step 6: Commit**

```bash
git add auth-worker/src/routes/knowledge.ts auth-worker/src/index.ts auth-worker/src/__tests__/knowledge-routes.test.ts
git commit -m "feat(kb): project + org knowledge routers (upload/extract/index/read/search/original/delete)"
```

---

### Task 5: Settings key + server gate

**Files:**
- Modify: `src/lib/sync/project-settings.ts` (add key to `ProjectWideSettings`, near `bibleResourcesEnabled` at ~L81)
- Create: `auth-worker/src/lib/knowledge/gate.ts`
- Test: `auth-worker/src/__tests__/knowledge-gate.test.ts`

**Interfaces:**
- Produces: `knowledgeBaseEnabled?: boolean` on `ProjectWideSettings`; `isKnowledgeBaseEnabled(db: AquillaDb, projectId: string): Promise<boolean>`.

- [ ] **Step 1: Add the settings key**

In `src/lib/sync/project-settings.ts`, after `bibleResourcesEnabled`:

```ts
  /**
   * Knowledge base drafting toggle (spec docs/superpowers/specs/2026-08-07-knowledge-base-design.md).
   * When true, translation generation + predictions inject KB string-search
   * snippets into draft prompts. Agent access to the KB is NOT gated by this.
   * Default false. Read server-side by the draft tool via
   * auth-worker/src/lib/knowledge/gate.ts.
   */
  knowledgeBaseEnabled?: boolean
```

If the file has an explicit key allowlist array/merge function for synced keys (check how `bibleResourcesEnabled` is registered besides the interface), register `knowledgeBaseEnabled` in the same places.

- [ ] **Step 2: Write the failing gate test**

`auth-worker/src/__tests__/knowledge-gate.test.ts`:

```ts
import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import { isKnowledgeBaseEnabled } from "../lib/knowledge/gate"

describe("isKnowledgeBaseEnabled", () => {
  it("false when no settings row / key absent; true only for explicit true", async () => {
    await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by) VALUES ('pg1', 'P', 1)").run()
    expect(await isKnowledgeBaseEnabled(env.AQUILLA_PG, "pg1")).toBe(false)
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_settings (project_id, settings, version, updated_by) VALUES ('pg1', ?, 1, 1)",
    ).bind(JSON.stringify({ knowledgeBaseEnabled: true })).run()
    expect(await isKnowledgeBaseEnabled(env.AQUILLA_PG, "pg1")).toBe(true)
  })
})
```

Run: `cd auth-worker && npm test -- knowledge-gate` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement `auth-worker/src/lib/knowledge/gate.ts`** (modeled on `lib/aquifer/gate.ts`, but simpler — no derivation, explicit true only):

```ts
// knowledgeBaseEnabled gate — derive-on-read from project_settings, default
// false. Gates DRAFTING injection only; agent KB tools are never gated.
import type { AquillaDb } from "../../../../db/shim/postgres"

export async function isKnowledgeBaseEnabled(db: AquillaDb, projectId: string): Promise<boolean> {
  const enabled = await db.prepare(
    `SELECT settings::jsonb ->> 'knowledgeBaseEnabled' AS enabled
     FROM project_settings WHERE project_id = ?`,
  ).bind(projectId).first<string>("enabled")
  return enabled === "true"
}
```

- [ ] **Step 4: Run to verify pass** — `cd auth-worker && npm test -- knowledge-gate`; also `pnpm test src/lib/sync` from root (settings type change compiles). Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sync/project-settings.ts auth-worker/src/lib/knowledge/gate.ts auth-worker/src/__tests__/knowledge-gate.test.ts
git commit -m "feat(kb): knowledgeBaseEnabled settings key + server gate"
```

---

### Task 6: Agent harness tools (kb_search / kb_read / kb_retrieve) + draft-tool block

**Files:**
- Create: `auth-worker/src/lib/agent/tools/knowledge.ts`
- Modify: `auth-worker/src/routes/agent.ts` — `buildTools` (~L149-385): three new tool defs, unconditional; `executeToolCall` (~L1240): three new cases; context-prep (~L640-720): KB doc listing appended to the augment prompt when docs exist.
- Modify: `auth-worker/src/lib/agent/tools/draft.ts` — `DraftContext` gets `knowledgeBlock?: string`; `draftSystemPrompt` renders it; `runDraftTool` in `agent.ts` (~L1186) populates it behind `isKnowledgeBaseEnabled`.
- Test: `auth-worker/src/__tests__/agent-kb-tools.test.ts`

**Interfaces:**
- Consumes: Task 2 (`searchKnowledge`, `listProjectDocs`, `getDocTree`, `getDocText`), Task 3 prompt helpers, Task 5 gate.
- Produces (in `tools/knowledge.ts`):

```ts
export interface KbToolCtx { db: AquillaDb; projectId: string; env: { OPENROUTER_API_KEY?: string; OPENROUTER_BASE_URL?: string; KB_INDEX_MODEL?: string } }
export async function kbSearch(ctx: KbToolCtx, q: string, limit?: number): Promise<string>
export async function kbRead(ctx: KbToolCtx, docId?: string, nodeId?: string): Promise<string>
export async function kbRetrieve(ctx: KbToolCtx, question: string): Promise<string>
export async function kbDocsPromptBlock(db: AquillaDb, projectId: string): Promise<string | null>  // null when no docs
```

All four return the model-facing TEXT (the convention of `harness-tools.ts`).

- [ ] **Step 1: Read the wrapper conventions**

Read `auth-worker/src/routes/agent.ts:1070-1240` (`budgetedCall`, `runSearchTool`, `runDocsTool` and the `t` context they receive) and `auth-worker/src/lib/agent/harness-tools.ts:1-60`. The pure logic goes in `tools/knowledge.ts`; the thin `t.send(code_start/code_result)` framing wrappers go in `agent.ts` exactly like `runSearchTool` does. Extract from `t` whatever fields give you the db handle, projectId, and env (they exist — every existing tool queries the project db).

- [ ] **Step 2: Write the failing tests**

`auth-worker/src/__tests__/agent-kb-tools.test.ts` — test the pure functions directly (no SSE harness):

```ts
import { env } from "cloudflare:test"
import { describe, it, expect, vi, afterEach } from "vitest"
import { kbSearch, kbRead, kbRetrieve, kbDocsPromptBlock } from "../lib/agent/tools/knowledge"
import { createDoc, setIndexResult } from "../../../db/shared/knowledge"

afterEach(() => vi.unstubAllGlobals())

const CTX = { db: env.AQUILLA_PG, projectId: "proj-akt", env: { OPENROUTER_API_KEY: "k" } }

async function seed() {
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by) VALUES ('proj-akt','P',1)").run()
  await createDoc(env.AQUILLA_PG, {
    id: "99999999-9999-9999-9999-999999999999", scope: { projectId: "proj-akt" }, name: "style.md",
    contentType: "text/markdown", sizeBytes: 30, sha256: "s", r2Key: "kb/project/proj-akt/9",
    extractedText: "# Names\nRender YHWH as 'the LORD'.", createdBy: "ryder",
  })
  await setIndexResult(env.AQUILLA_PG, "99999999-9999-9999-9999-999999999999", "ready",
    [{ id: "n1", title: "Names", summary: "Divine name policy", charStart: 0, charEnd: 33 }], "Style guide")
}

describe("agent kb tools", () => {
  it("kbSearch returns doc-attributed snippets; no match → explicit 'no results' text", async () => {
    await seed()
    expect(await kbSearch(CTX, "YHWH")).toContain("style.md")
    expect(await kbSearch(CTX, "zzzz")).toMatch(/no .*results/i)
  })

  it("kbRead lists docs (no args), returns tree (docId), returns node text (docId+nodeId)", async () => {
    await seed()
    const list = await kbRead(CTX)
    expect(list).toContain("style.md")
    expect(list).toContain("Style guide")
    const tree = await kbRead(CTX, "99999999-9999-9999-9999-999999999999")
    expect(tree).toContain("n1")
    const node = await kbRead(CTX, "99999999-9999-9999-9999-999999999999", "n1")
    expect(node).toContain("the LORD")
    expect(await kbRead(CTX, "99999999-9999-9999-9999-999999999999", "nope")).toMatch(/not found/i)
  })

  it("kbRetrieve asks the model for node ids, then returns those nodes' text", async () => {
    await seed()
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ nodes: [{ docId: "99999999-9999-9999-9999-999999999999", nodeId: "n1" }] }) } }],
    }))))
    const out = await kbRetrieve(CTX, "how do we render the divine name?")
    expect(out).toContain("the LORD")
  })

  it("kbRetrieve upstream failure degrades to an error text, never throws", async () => {
    await seed()
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x", { status: 500 })))
    expect(await kbRetrieve(CTX, "q")).toMatch(/unavailable|failed/i)
  })

  it("kbDocsPromptBlock is null with no docs, and lists names + summaries with docs", async () => {
    await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by) VALUES ('proj-empty','P',1)").run()
    expect(await kbDocsPromptBlock(env.AQUILLA_PG, "proj-empty")).toBeNull()
    await seed()
    expect(await kbDocsPromptBlock(env.AQUILLA_PG, "proj-akt")).toContain("style.md")
  })
})
```

Run: `cd auth-worker && npm test -- agent-kb-tools` — Expected: FAIL.

- [ ] **Step 3: Implement `auth-worker/src/lib/agent/tools/knowledge.ts`**

`kbSearch`: `searchKnowledge(ctx.db, ctx.projectId, q, limit ?? 5)`; format as `[docName] …snippet…` lines; empty → `"no knowledge base results for that query"`.

`kbRead`: no docId → `listProjectDocs`, one line per doc: `docId | name (scope, indexStatus) — docSummary`; docId only → `getDocTree`, render nodes recursively as `id title — summary` indented lines (fall back to `"(no index; use kb_read with no nodeId to get full text via content)"`… actually: when tree null, return the full text via `getDocText` truncated to 8000 chars); docId+nodeId → `getDocText`, `"node not found"` on null. Truncate every response to 8000 chars with a `[truncated]` marker.

`kbRetrieve`: gather all docs' trees (`listProjectDocs` + `getDocTree` each, ready only); build a prompt: question + per-doc `docId / node id / title / summary` outline; call OpenRouter (same fetch shape as Task 3, `response_format: json_object`, model `env.KB_INDEX_MODEL || DEFAULT_KB_INDEX_MODEL`) asking for `{"nodes":[{"docId":"…","nodeId":"…"}]}` (max 5); then `getDocText` each and concatenate `## docName › nodeTitle\n<text>` sections (cap 12000 chars). try/catch → `"knowledge retrieval is temporarily unavailable; use kb_search or kb_read instead"`. No docs / no trees → fall back to `kbSearch(ctx, question)`.

`kbDocsPromptBlock`: `listProjectDocs`; null if empty; else:

```
KNOWLEDGE BASE — background documents for this project (not translation pairs).
Tools: kb_search {q} (string search), kb_read {docId?, nodeId?} (list/outline/section),
kb_retrieve {question} (finds + returns the relevant sections). Documents:
- <name> (<scope>): <docSummary ?? first 100 chars of name-only line>
```

- [ ] **Step 4: Run to verify pass** — `cd auth-worker && npm test -- agent-kb-tools`. Expected: PASS.

- [ ] **Step 5: Wire into the agent route**

In `agent.ts` `buildTools`, append three defs (unconditional, after `read_memory`):

```ts
{
  type: "function",
  function: {
    name: "kb_search",
    description:
      "String-search the project knowledge base (background documents: style guides, cultural notes, entity info — not translation pairs). Returns doc-attributed snippets.",
    parameters: { type: "object", properties: {
      q: { type: "string" }, limit: { type: "number", description: "Max snippets (default 5, cap 20)." },
    }, required: ["q"] },
  },
},
{
  type: "function",
  function: {
    name: "kb_read",
    description:
      "Knowledge base reader. No args: list documents with summaries. {docId}: the document's section outline (node ids). {docId, nodeId}: that section's full text.",
    parameters: { type: "object", properties: {
      docId: { type: "string" }, nodeId: { type: "string" },
    } },
  },
},
{
  type: "function",
  function: {
    name: "kb_retrieve",
    description:
      "Ask a question of the knowledge base; a fast model picks the relevant sections across all documents and returns their text. Use for 'what does the style guide say about X'-shaped needs.",
    parameters: { type: "object", properties: { question: { type: "string" } }, required: ["question"] },
  },
},
```

`executeToolCall` cases: wrap each with the same `t.send(code_start/code_result)` framing as `runSearchTool` (write small `runKbSearchTool`/`runKbReadTool`/`runKbRetrieveTool` wrappers next to it; `kb_retrieve` goes through `budgetedCall` since it is LLM-shaped). Context prep (~L676, next to `buildMemoryContext`): `const kbBlock = await kbDocsPromptBlock(db, projectId).catch(() => null)` and append `kbBlock` to the augment system message when non-null (same degrade-to-absent posture as memory).

`draft.ts`: add `knowledgeBlock?: string` to `DraftContext`; in `draftSystemPrompt` append, after the examples/preceding blocks:

```ts
if (ctx.knowledgeBlock) parts.push(`Background knowledge (from the project knowledge base):\n${ctx.knowledgeBlock}`)
```

(match the file's actual string-assembly style). In `runDraftTool` (agent.ts ~L1186): `if (await isKnowledgeBaseEnabled(db, projectId))` → `searchKnowledge(db, projectId, sourceText, 3)` in try/catch → join snippets as the block; failures → undefined.

- [ ] **Step 6: Full suite + typecheck**

Run: `cd auth-worker && npm test` — Expected: PASS (existing `agent-route.test.ts` / `agent-schema-card.test.ts` may assert the tool list; update their expected tool arrays to include the three kb tools — that is a legitimate intent change, not test-weakening).

- [ ] **Step 7: Commit**

```bash
git add auth-worker/src/lib/agent/tools/knowledge.ts auth-worker/src/routes/agent.ts auth-worker/src/lib/agent/tools/draft.ts auth-worker/src/__tests__/agent-kb-tools.test.ts auth-worker/src/__tests__/*.test.ts
git commit -m "feat(kb): agent kb_search/kb_read/kb_retrieve tools + toggle-gated draft-tool block"
```

---

### Task 7: External Agent API (sync-worker) — REST reads, MCP tools, discovery, docs

**Files:**
- Modify: `sync-worker/src/external/read-routes.ts` (route regexes ~L66-72 + dispatcher ~L472-500 + handlers)
- Modify: `sync-worker/src/external/mcp-tools.ts` (two tool defs)
- Modify: `sync-worker/src/external/mcp-handlers.ts` (two `callTool` cases delegating via `runRead`)
- Modify: `sync-worker/src/external/discovery-route.ts` (`apiMap()` endpoints + quickstart mention)
- Modify: `docs/api/agent-api.md`, `docs/api/openapi.yaml`
- Test: `sync-worker/src/__tests__/external-knowledge.test.ts`; add rows to `sync-worker/src/__tests__/external-permission-parity.test.ts`

**Interfaces:**
- Consumes: Task 2 shared module; existing `authenticateAndScope` (`read-routes.ts:118-160`), `runRead` (`mcp-handlers.ts:224`), `delegatedError` (`mcp-handlers.ts:61`).
- Produces REST routes (all GET, all ≥ VIEWER live role, same JSON shapes as Task 4's reads):
  - `GET /api/v1/external/projects/:id/knowledge`
  - `GET /api/v1/external/projects/:id/knowledge/search?q=&limit=`
  - `GET /api/v1/external/projects/:id/knowledge/:docId`
  - `GET /api/v1/external/projects/:id/knowledge/:docId/content?nodeId=`
- MCP tools: `search_knowledge { projectId, q, limit? }`, `read_knowledge { projectId, docId?, nodeId? }`.

- [ ] **Step 1: Write the failing tests**

`sync-worker/src/__tests__/external-knowledge.test.ts` — copy the harness of an existing external read test (find the test file covering `search_project`/`read_content`; reuse its credential-minting + project-seeding helpers exactly). Cases:

1. Credential with VIEWER role on the project: `GET …/knowledge` lists a seeded doc (seed via `createDoc` directly against the test db); `…/knowledge/search?q=` returns a snippet; `…/knowledge/:docId/content?nodeId=n1` returns node text.
2. Credential scoped to a DIFFERENT project → `scope_denied`.
3. No membership → `permission_denied`.
4. MCP: `tools/list` includes `search_knowledge` + `read_knowledge`; `tools/call search_knowledge` returns the same snippet payload; `read_knowledge` with unknown docId → `not_found` error code.
5. Unknown doc on REST → 404 `not_found` envelope.

Run: `cd sync-worker && npm test -- external-knowledge` — Expected: FAIL.

- [ ] **Step 2: Implement REST reads in `read-routes.ts`**

Add regexes next to the existing ones (~L66):

```ts
const KNOWLEDGE_LIST_RE = /^\/api\/v1\/external\/projects\/([^/]+)\/knowledge$/
const KNOWLEDGE_SEARCH_RE = /^\/api\/v1\/external\/projects\/([^/]+)\/knowledge\/search$/
const KNOWLEDGE_DOC_RE = /^\/api\/v1\/external\/projects\/([^/]+)\/knowledge\/([^/]+)$/
const KNOWLEDGE_CONTENT_RE = /^\/api\/v1\/external\/projects\/([^/]+)\/knowledge\/([^/]+)\/content$/
```

Dispatcher: match SEARCH and CONTENT before DOC (same capture-order trap as Task 4). Each handler: `authenticateAndScope` (≥ VIEWER), then call the Task 2 functions and return the same shapes as auth-worker (`{ docs }`, `{ snippets }`, `{ doc, tree }`, `{ text }`); missing doc/node → `externalError("not_found", …, 404)`. The `/original` binary route is intentionally NOT exposed externally in v1 (extracted text is the API surface; keep parity simple).

- [ ] **Step 3: MCP tools + handlers**

`mcp-tools.ts` — append (descriptions are public docs; follow the house voice):

```ts
{
  name: 'search_knowledge',
  description:
    'String-search the project knowledge base — background documents (style guides, ' +
    'cultural/entity notes) that inform translation but are not translation pairs. ' +
    'Returns up to `limit` (default 5, cap 20) doc-attributed snippets ' +
    '{ docId, docName, snippet }. Errors: permission_denied, scope_denied, not_found ' +
    '(unknown project). For structured navigation use read_knowledge.',
  inputSchema: {
    type: 'object',
    properties: { ...projectIdProp, q: { type: 'string' }, limit: { type: 'number' } },
    required: ['projectId', 'q'],
    additionalProperties: false,
  },
},
{
  name: 'read_knowledge',
  description:
    'Read the project knowledge base. With only projectId: list documents ' +
    '(id, name, scope project|org, indexStatus, docSummary). With docId: the document ' +
    'section tree (node ids, titles, summaries, char ranges). With docId+nodeId: that ' +
    'section\'s text. Org-level documents are inherited automatically. Errors: ' +
    'permission_denied, scope_denied, not_found (unknown project/doc/node).',
  inputSchema: {
    type: 'object',
    properties: { ...projectIdProp, docId: { type: 'string' }, nodeId: { type: 'string' } },
    required: ['projectId'],
    additionalProperties: false,
  },
},
```

`mcp-handlers.ts` — two cases in the `callTool` switch delegating over `runRead` (mirror how `search_project` builds its path + query string; `read_knowledge` picks list/doc/content path from which args are present).

- [ ] **Step 4: Discovery + docs**

`discovery-route.ts` `apiMap()`: add the four endpoints under a `knowledge` group with one-line descriptions. `docs/api/agent-api.md`: a "Knowledge base (read-only)" section — what it is, the four REST routes, both MCP tools, org inheritance, statement that uploads are UI-only in v1. `docs/api/openapi.yaml`: four GET paths with response schemas matching the shapes above.

- [ ] **Step 5: Parity matrix**

Open `sync-worker/src/__tests__/external-permission-parity.test.ts`, add the four REST paths + two MCP tools to whatever structure enumerates surfaces (each read requires VIEWER, honors credential scope). Follow the file's existing row format exactly.

- [ ] **Step 6: Run to verify pass**

Run: `cd sync-worker && npm test -- external-knowledge` then `cd sync-worker && npm test`
Expected: PASS, including parity.

- [ ] **Step 7: Commit**

```bash
git add sync-worker/src/external docs/api sync-worker/src/__tests__
git commit -m "feat(kb): external agent API knowledge reads (REST + MCP) with discovery + docs"
```

---

### Task 8: SPA API client `src/lib/knowledge/knowledge-api.ts`

**Files:**
- Create: `src/lib/knowledge/knowledge-api.ts`
- Test: `src/lib/knowledge/knowledge-api.test.ts`

**Interfaces:**
- Consumes: same plumbing as `src/lib/agent/memory-api.ts` (open it and copy its `AUTH_BASE` resolution, `fetchWithTimeout` import, bearer-JWT header helper, and error-parsing shape).
- Produces:

```ts
export interface KnowledgeDocMeta { /* mirror db/shared/knowledge.ts KnowledgeDocMeta verbatim */ }
export interface KnowledgeNode { /* mirror */ }
export interface KnowledgeSnippet { docId: string; docName: string; snippet: string }
export class KnowledgeApiError extends Error { code: string; status: number }
export async function listKnowledgeDocs(jwt: string, projectId: string): Promise<KnowledgeDocMeta[]>
export async function uploadKnowledgeDoc(jwt: string, scope: { projectId: string } | { orgId: number }, file: File): Promise<KnowledgeDocMeta>
export async function getKnowledgeDoc(jwt: string, projectId: string, docId: string): Promise<{ doc: KnowledgeDocMeta; tree: KnowledgeNode[] | null }>
export async function getKnowledgeDocText(jwt: string, projectId: string, docId: string, nodeId?: string): Promise<string>
export async function deleteKnowledgeDoc(jwt: string, scope: { projectId: string } | { orgId: number }, docId: string): Promise<void>
export async function reindexKnowledgeDoc(jwt: string, scope: { projectId: string } | { orgId: number }, docId: string): Promise<void>
export async function searchKnowledgeApi(jwt: string, projectId: string, q: string, limit?: number): Promise<KnowledgeSnippet[]>
export async function fetchKnowledgeOriginalBlob(jwt: string, scope: { projectId: string } | { orgId: number }, docId: string): Promise<Blob>
export const MAX_KB_UPLOAD_BYTES = 25 * 1024 * 1024
export const KB_ACCEPT = ".md,.txt,.docx,.pdf"
```

`uploadKnowledgeDoc` sends raw bytes with `x-doc-name: encodeURIComponent(file.name)` and the file's `type` as Content-Type (the `artifact-upload.ts` pattern — read it first). Scope picks the URL root: `/api/v2/projects/{projectId}/knowledge` vs `/api/v2/orgs/{orgId}/knowledge`. `fetchKnowledgeOriginalBlob` fetches `/original` with the bearer header and returns `res.blob()` — the UI turns it into an object URL (this is how "open in new tab" works without putting tokens in URLs).

- [ ] **Step 1: Write failing tests** (`vi.stubGlobal("fetch", …)` asserting URL, method, headers, error mapping for a `{ error: { code } }` 403 → `KnowledgeApiError` with that code; upload sends bytes not multipart). 4-6 focused cases.

Run: `pnpm test src/lib/knowledge` — Expected: FAIL.

- [ ] **Step 2: Implement** per the interface, copying memory-api's internals.

- [ ] **Step 3: Run to verify pass** — `pnpm test src/lib/knowledge`. Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/knowledge
git commit -m "feat(kb): SPA knowledge API client"
```

---

### Task 9: Living Memory tab — Knowledge Base section

**Files:**
- Create: `src/components/living-memory/KnowledgeBaseSection.tsx`
- Modify: `src/components/LivingMemoryPage.tsx` (render the section between the brief block and the Instructions section, ~L535-681; pass `projectId`, `settings`, `patchSettings`, `canEdit`, `roleLevel`, and the session JWT the page already has access to — check how it obtains auth for `extractBriefFromDocument` and reuse that)
- Test: `src/components/living-memory/KnowledgeBaseSection.test.tsx`

**Interfaces:**
- Consumes: Task 8 client; `useProjectSettings`'s `patchSettings`; `ROLE` from `@/lib/sync/role-policy`.
- Produces: `<KnowledgeBaseSection projectId={…} orgId={…} jwt={…} knowledgeBaseEnabled={…} onToggle={(v) => patchSettings({ knowledgeBaseEnabled: v })} canEditSettings={…} roleLevel={…} orgRoleLevel={…} />`.

Component behavior (use existing shadcn primitives from `@/components/ui` — `Card`, `Switch`, `Badge`, `Button`, `Dialog`, `Skeleton`; lucide icons `FileText`, `FileType`, `Upload`, `Trash2`, `ExternalLink`, `RefreshCw`):

- Header row: "Knowledge Base" title + the toggle (`Switch`) labeled "Use in drafting" — disabled unless `canEditSettings`, with the page's existing tooltip-on-disabled affordance. Helper copy: "Background documents the agent can always read. When enabled, drafting also searches them."
- Load docs on mount via `listKnowledgeDocs` (plain `useState` + race-guarded `useEffect` — the codebase's read-hook convention; NEVER `useQuery`).
- Upload button (hidden `<input type="file" accept={KB_ACCEPT}>`) shown when `roleLevel >= ROLE.PROJECT_LEAD`; client-side reject over `MAX_KB_UPLOAD_BYTES`; optimistic "uploading…" row; refetch on success; while any doc is `pending`, poll `listKnowledgeDocs` every 4s until none are (clear the interval on unmount).
- Doc rows: extension icon, name, `sizeBytes` humanized, scope badge (`Org` when `scope === "org"`), status chip (pending = pulsing badge, failed = destructive badge with a retry button calling `reindexKnowledgeDoc` when the user's floor allows), delete (project docs at `roleLevel >= PROJECT_LEAD`; org docs only when `orgRoleLevel >= 600`, else hidden).
- Row click → `Dialog`: `docSummary` paragraph, scrollable extracted text (`getKnowledgeDocText`), footer buttons "Open original" and "Delete". "Open original": `fetchKnowledgeOriginalBlob` → `URL.createObjectURL` → `window.open(url, "_blank")` → `URL.revokeObjectURL` after a tick.
- Every mutation follows optimistic-with-revert (the `AgentMemoryTab.tsx` pattern — read it first).

- [ ] **Step 1: Write failing tests** — pure-logic level, matching how `LivingMemoryPage.tsx` exports `addEntry`/`updateEntry` helpers for tests: export from the component file `humanSize(bytes): string`, `canDeleteDoc(doc, roleLevel, orgRoleLevel): boolean`, `canUpload(roleLevel): boolean` and test those (org doc + project lead → false; org doc + org maintainer → true; project doc + contributor → false; project doc + project lead → true; 500 → canUpload true, 400 → false). Plus one render test with mocked client module verifying the toggle fires `onToggle` and is disabled when `canEditSettings` is false.

Run: `pnpm test src/components/living-memory` — Expected: FAIL.

- [ ] **Step 2: Implement the component**, then wire it into `LivingMemoryPage.tsx` (one import + one JSX block; derive `orgId`/`orgRoleLevel` from the `project` object the page already loads — check `useProject`'s shape for the org fields; if org role isn't client-available, pass `orgRoleLevel={undefined}` and hide org-doc management, leaving org docs read-only in this view — server enforces regardless).

- [ ] **Step 3: Run to verify pass** — `pnpm test src/components/living-memory`; `pnpm lint`; `pnpm build` (type-checks the SPA). Expected: PASS.

- [ ] **Step 4: Verify live** — invoke the `verify-dev-change` skill: as the seeded dev user, open a project → Memory tab → upload a small `.md`, see it index (mock-openrouter answers in the dev stack), toggle "Use in drafting", open the modal, open the original. Screenshot as proof.

- [ ] **Step 5: Commit**

```bash
git add src/components/living-memory src/components/LivingMemoryPage.tsx
git commit -m "feat(kb): knowledge base section in Living Memory tab (upload, toggle, viewer modal)"
```

---

### Task 10: Completion (predictions/generation) integration

**Files:**
- Modify: `src/lib/completion/completion-service.ts` — add exported `formatKnowledgeBlock(snippets: KnowledgeSnippet[]): string | undefined`
- Modify: `src/hooks/useCompletion.ts` — new optional param + gather step in `completeSingle`, batch, and paragraph paths
- Modify: `src/components/ProjectWorkspace.tsx` (~L2142-2149) — supply the new param
- Test: `src/lib/completion/completion-service.test.ts` (extend), `src/hooks/useCompletion` tests if present (check for an existing test file and extend it; if none exists, the service-level test carries the contract)

**Interfaces:**
- Consumes: Task 8 `searchKnowledgeApi`; existing `buildPrompt` `preSourceBlock` option (`completion-service.ts:221,270`).
- Produces: `useCompletion` gains a final optional param:

```ts
knowledgeContext?: { enabled: boolean; search: (q: string) => Promise<KnowledgeSnippet[]> }
```

`ProjectWorkspace.tsx` passes `{ enabled: settings?.knowledgeBaseEnabled === true, search: (q) => searchKnowledgeApi(jwt, projectId, q, 3) }` (reusing whatever jwt/session accessor the workspace already threads to other API calls).

- [ ] **Step 1: Write the failing tests**

In `completion-service.test.ts` (or a new `knowledge-block.test.ts` beside it if that file is organized per-feature):

```ts
import { buildPrompt, formatKnowledgeBlock } from "./completion-service"

it("formatKnowledgeBlock renders labelled doc-attributed snippets, capped at 1200 chars", () => {
  const block = formatKnowledgeBlock([
    { docId: "d1", docName: "style.md", snippet: "Render YHWH as 'the LORD'." },
  ])
  expect(block).toContain("Background knowledge")
  expect(block).toContain("style.md")
  expect(formatKnowledgeBlock([])).toBeUndefined()
  const long = formatKnowledgeBlock([{ docId: "d", docName: "n", snippet: "x".repeat(5000) }])
  expect(long!.length).toBeLessThanOrEqual(1300)
})

it("the knowledge block lands in the user message before the final Source line, never in the system prompt", () => {
  const messages = buildPrompt({
    sourceText: "In the beginning",
    sourceLanguage: "en", targetLanguage: "es",
    validatedPairs: [], examples: [],
    preSourceBlock: formatKnowledgeBlock([{ docId: "d1", docName: "style.md", snippet: "snip" }]),
  } /* match buildPrompt's actual options shape — read L195-290 first */)
  const user = messages[messages.length - 1].content
  expect(user.indexOf("Background knowledge")).toBeLessThan(user.lastIndexOf("Source:"))
  expect(messages[0].content).not.toContain("Background knowledge")
})
```

Run: `pnpm test src/lib/completion/completion-service` — Expected: FAIL (`formatKnowledgeBlock` not exported).

- [ ] **Step 2: Implement `formatKnowledgeBlock`** in `completion-service.ts` (near `buildBriefBlock`):

```ts
/** KB snippets → the preSourceBlock label block (spec 2026-08-07-knowledge-base).
 *  Hard cap ~1200 chars: KB context must never crowd out examples. */
export function formatKnowledgeBlock(snippets: KnowledgeSnippet[]): string | undefined {
  if (!snippets.length) return undefined
  const lines: string[] = ["Background knowledge (project reference documents — not translation examples):"]
  let budget = 1200
  for (const s of snippets) {
    const line = `[${s.docName}] ${s.snippet.replace(/\s+/g, " ").trim()}`
    const clipped = line.slice(0, Math.max(0, budget))
    if (!clipped) break
    lines.push(clipped)
    budget -= clipped.length
  }
  return lines.join("\n")
}
```

- [ ] **Step 3: Wire `useCompletion`**

In `completeSingle` (~L216-400), alongside the existing search step (fire concurrently — `Promise.all` with the branching search where structure allows, otherwise immediately after):

```ts
let knowledgeBlock: string | undefined
if (knowledgeContext?.enabled) {
  try {
    knowledgeBlock = formatKnowledgeBlock(await knowledgeContext.search(sourceText))
  } catch { /* KB must never break drafting (spec §Error handling) */ }
}
```

then pass `preSourceBlock: knowledgeBlock` into the `buildPrompt` call (L309). Mirror in the batch path (~L535) using the FIRST cell's source text for one shared lookup per batch, and the paragraph path (~L809) likewise. Update the `ProjectWorkspace.tsx` call site.

- [ ] **Step 4: Run to verify pass** — `pnpm test src/lib/completion src/hooks`; `pnpm build`. Expected: PASS.

- [ ] **Step 5: Verify live** — `verify-dev-change` skill again: enable the toggle on the seeded project (with the doc from Task 9's verification), draft a cell, and confirm via the mock-openrouter request log (`preview_logs` on the dev stack) that the outgoing prompt contains "Background knowledge". Then disable the toggle and confirm it doesn't.

- [ ] **Step 6: Commit**

```bash
git add src/lib/completion src/hooks/useCompletion.ts src/components/ProjectWorkspace.tsx
git commit -m "feat(kb): toggle-gated knowledge snippets in draft prompts (preSourceBlock)"
```

---

### Task 11: E2E smoke spec

**Files:**
- Create: `e2e/knowledge-base.spec.ts` (location/naming: read `e2e/JOURNEYS.md` and AGENTS.md first and conform — if journeys are registered in a manifest, register this one)

**Interfaces:**
- Consumes: the seeded-project helper (`e2e/…/seed-project.ts` — replaces the UI create+import prologue) and existing page-object conventions.

- [ ] **Step 1: Read `AGENTS.md` + `e2e/JOURNEYS.md`** and one recent spec that uses `seed-project` to copy the harness exactly.

- [ ] **Step 2: Write the spec** — one journey: seeded project → Memory tab → upload `e2e/fixtures/kb-style-guide.md` (create a 5-line fixture) → row appears with status chip reaching `ready` (mock-openrouter serves the enrichment) → toggle "Use in drafting" on → reload → toggle persisted → open modal → extracted text visible → delete → row gone. Use accessible selectors per the page-object style.

- [ ] **Step 3: Run** — `pnpm test:e2e -- knowledge-base` (single stack only — never run while another e2e stack is up on this machine). Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add e2e
git commit -m "test(kb): knowledge base e2e journey (upload, index, toggle, modal, delete)"
```

---

### Task 12: Final verification sweep

- [ ] **Step 1: Full suites** — `pnpm test` (root), `cd auth-worker && npm test`, `cd sync-worker && npm test`, `pnpm lint`, `pnpm build`. Expected: all PASS. Surface any skip loudly — do not report done past a red suite.
- [ ] **Step 2: Spec conformance read-through** — reread `docs/superpowers/specs/2026-08-07-knowledge-base-design.md` top to bottom against the diff (`git diff main...HEAD --stat`); confirm each spec section is implemented or explicitly listed as out-of-scope.
- [ ] **Step 3: Commit any stragglers and stop** — hand back for human review before any deploy or Neon migration apply.
