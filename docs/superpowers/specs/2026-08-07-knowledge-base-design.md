# Knowledge Base — design spec

Date: 2026-08-07
Status: approved design, pending implementation plan

## Purpose

Give projects and orgs a **knowledge base**: a repository of documents that provide
context for translation work even though they are not translation pairs (style guides,
cultural background, entity/terminology notes, source commentary, etc.). Surfaced in the
**Living Memory tab**. Consumed three ways:

1. **Agent chat (always on)** — the in-app translation agent can search and read KB docs.
2. **External agents (always on)** — third-party agents with PAT credentials get the same
   read access via the Agent API (REST + MCP).
3. **Drafting (toggle-gated)** — when the project toggle is on, translation generation and
   inline predictions inject KB snippets (found by plain string search) into draft prompts.

Indexing is **PageIndex-style** (github.com/VectifyAI/PageIndex): each document gets a
hierarchical section tree with LLM-written node summaries, built once at upload time by a
lightweight model (Haiku via the existing OpenRouter plumbing). Retrieval for agents is
reasoning-based (navigate the tree), not vector search. No vector DB.

## Decisions (locked with Ryder, 2026-08-07)

- **One toggle** (`knowledgeBaseEnabled` in `project_settings`) covers both translation
  generation and predictions. The agent's access is NOT gated by the toggle.
- **Predictions/generation use naive string search** over extracted text (no LLM in the
  hot path). **Agent uses agentic retrieval** — navigates the tree itself via tools, plus
  a `kb_retrieve` tool that does a single Haiku sub-call over the trees.
- **Org docs auto-inherit**: every project in the org sees org-level KB docs alongside its
  own. The project toggle still controls drafting injection.
- **Formats v1**: `.md`/`.txt` stored as-is; `.docx`/`.pdf` extracted via the existing
  `parse-document` machinery (2 MB extraction cap; PDF extraction is rudimentary —
  accepted for v1). **Originals are always kept in R2** and viewable: file-type thumbnail
  icon in the list, extracted text + summary in a modal, "open original" in a new tab
  (streamed from R2) for inspection/download.
- **Role floors**: project KB doc writes (upload/delete/reindex) = **PROJECT_LEAD (500)**;
  org KB doc writes = **org MAINTAINER (600)**. Reads = VIEWER / org member. The toggle
  rides `project_settings`, so flipping it keeps the settings floor (MAINTAINER).
- **New table, not `artifacts`**: artifacts are project-only with import/provenance
  semantics (`credential_id NOT NULL`); org-level docs don't fit. KB gets its own table.
- **External API is read-only in v1** (list/search/read). Third-party upload is a later
  slice.

## Data model

New migration in `db/postgres/migrations/`, table:

```sql
CREATE TABLE knowledge_docs (
  id UUID PRIMARY KEY,
  org_id BIGINT REFERENCES organizations(id) ON DELETE CASCADE,
  project_id TEXT,                    -- exactly one of org_id/project_id set (CHECK)
  name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  sha256 TEXT NOT NULL,
  r2_key TEXT NOT NULL,               -- original file: kb/{org|project}/{scopeId}/{docId}
  extracted_text TEXT NOT NULL,
  doc_summary TEXT,                   -- LLM top-level summary; shown in lists, fed to retrieval
  index_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (index_status IN ('pending','ready','failed')),
  index_tree JSONB,                   -- PageIndex tree, see below
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((org_id IS NULL) <> (project_id IS NULL))
);
CREATE INDEX knowledge_docs_project ON knowledge_docs (project_id) WHERE project_id IS NOT NULL;
CREATE INDEX knowledge_docs_org ON knowledge_docs (org_id) WHERE org_id IS NOT NULL;
```

Tree node shape (JSONB): `{ id, title, summary, charStart, charEnd, children: [...] }` —
char ranges index into `extracted_text`, so `read node` is a substring, no re-extraction.
Documents are segmented **heuristically first** (markdown headings / page breaks / blank-line
blocks); the Haiku call only writes titles-where-missing, node summaries, and `doc_summary`
(the PageIndex-"Flash" approach — structure without LLM, enrichment with LLM). Cap tree
depth at 3 and node count at ~200; oversize docs get coarser nodes.

R2: same `aquilla-snapshots` bucket (`SNAPSHOTS` binding), key prefix `kb/`.

Settings: `knowledgeBaseEnabled?: boolean` added to the `ProjectWideSettings` allowlist
(`src/lib/sync/project-settings.ts`), default false. Server reads it derive-on-read like
`bibleResourcesEnabled` (`auth-worker/src/lib/aquifer/gate.ts` pattern).

## Shared logic

`db/shared/knowledge.ts` — used by both workers (same Hyperdrive Postgres):

- `createDoc`, `listDocs(projectId)` (project docs + inherited org docs via the project's
  `org_id`), `listOrgDocs(orgId)`, `getDoc`, `deleteDoc`, `setIndexResult`.
- `searchKnowledge(db, projectId, q, limit)` — plain-text search (`ILIKE`; upgrade to
  `tsvector` later if needed) over project + inherited org docs, returning snippets
  `{ docId, docName, nodeId?, snippet }` with a context window around each match.
- `resolveNode(tree, nodeId)` + `readNodeText(doc, nodeId)`.
- Validation: name, content-type allowlist, size caps (25 MB original like artifacts;
  2 MB for docx/pdf extraction per parse-document), secret-pattern scan on extracted text
  reusing `SECRET_PATTERNS` from `db/shared/agent-memory.ts`.

## auth-worker

New router `auth-worker/src/routes/knowledge.ts`, mounted at
`/api/v2/projects/:projectId/knowledge` and `/api/v2/orgs/:orgId/knowledge`
(agent-memory router style: `requireRole` live resolution, `{ error: { code, message } }`
envelope):

| Route | Floor |
|---|---|
| `GET /` list (project scope includes inherited org docs, flagged `scope: 'org'`) | VIEWER / org member |
| `GET /search?q=&limit=` | VIEWER / org member |
| `GET /:docId` metadata + tree | VIEWER / org member |
| `GET /:docId/content?nodeId=` extracted text or one node | VIEWER / org member |
| `GET /:docId/original` stream original from R2 (Content-Disposition inline; browser tab renders or downloads) | VIEWER / org member |
| `POST /` upload (raw bytes + `x-doc-name` header, agent-artifacts style) | PROJECT_LEAD (project) / MAINTAINER (org) |
| `DELETE /:docId` (also deletes R2 object) | PROJECT_LEAD / MAINTAINER |
| `POST /:docId/reindex` | PROJECT_LEAD / MAINTAINER |

Upload flow: validate → extract text inline (md/txt passthrough; docx/pdf via the
parse-document extraction functions, refactored to be callable in-process rather than
HTTP) → R2 put → insert row (`index_status='pending'`) → `ctx.waitUntil(indexDoc(...))`.
`indexDoc` builds the heuristic tree, makes ONE OpenRouter call
(model: `platform_settings.kbIndexModel` → default `anthropic/claude-haiku-4-5`, resolved
like `resolveAgentModel`) asking for node titles/summaries + doc summary as JSON, then
`setIndexResult('ready', tree, summary)`; any failure → `'failed'` (docs remain
searchable by string even when `failed` — the tree is an enhancement, not a gate).
Response 201 returns the row immediately; the UI polls/refetches while `pending`.

### Agent harness (always on)

In `buildTools` (`auth-worker/src/routes/agent.ts`) add, unconditionally:

- `kb_search { q }` → `searchKnowledge` snippets.
- `kb_read { docId?, nodeId? }` → no args: list docs with `doc_summary`; docId: tree;
  docId+nodeId: node text. (One tool, three shapes — mirrors `read_memory`.)
- `kb_retrieve { question }` → single Haiku sub-call: prompt = question + all doc trees
  (titles/summaries only), model returns the node ids worth reading; tool returns those
  nodes' text. Budgeted like other LLM-shaped tools.

System prompt: when the project has ≥1 KB doc, append a short KB contract block in
`schema-card.ts` (the `AQUIFER_CONTRACT` gating pattern) listing doc names + one-liners.

### Draft tool (server-side)

`auth-worker/src/lib/agent/tools/draft.ts`: when `knowledgeBaseEnabled`, add a
`knowledgeBlock` to `DraftContext`, populated in `runDraftTool` via `searchKnowledge`
on the source text, rendered in `draftSystemPrompt`.

## sync-worker (external Agent API, read-only v1)

- REST (`external/read-routes.ts` route regexes + handlers): `GET /api/v1/external/projects/:id/knowledge`,
  `/knowledge/search?q=`, `/knowledge/:docId`, `/knowledge/:docId/content?nodeId=`.
  Standard three-layer gate (credential validity → scope → live role ≥ VIEWER).
- MCP (`mcp-tools.ts` + `mcp-handlers.ts`): two tools, `search_knowledge` and
  `read_knowledge` (same three-shape contract as `kb_read`), delegating to the REST
  handlers via `runRead` like the other read tools. Descriptions are the public docs.
- Discovery: add endpoints to `discovery-route.ts` `apiMap()`; document in
  `docs/api/agent-api.md` + `docs/api/openapi.yaml`; add rows to the external
  permission-parity test matrix.

No changeset machinery needed — reads only.

## Client (SPA)

### Living Memory tab

New section component `src/components/living-memory/KnowledgeBaseSection.tsx` rendered by
`LivingMemoryPage.tsx` between the brief and the authored-entries sections:

- Header with the **toggle** ("Use knowledge base in drafting") — persisted via
  `patchSettings({ knowledgeBaseEnabled })`, disabled below the settings floor with the
  existing `reasonCannotEdit` affordance.
- Upload button (file picker, client-side size/type validation) → POST; list refetches.
- Doc list: file-type thumbnail icon (lucide per content-type), name, size, scope badge
  ("Org" for inherited docs), index status chip (pending spinner / ready / failed+retry).
- Row click → **modal**: `doc_summary` + extracted text (scrollable), buttons
  "Open original" (new tab → `/original` URL with auth — use a short-lived signed link or
  token-in-query pattern consistent with existing R2 streaming in the app) and Delete
  (role-gated; org docs deletable only with org MAINTAINER).
- Upload/delete enabled at PROJECT_LEAD for project docs (client mirrors server floor,
  like `SETTINGS_EDIT_ROLE_FLOOR` mirroring).

API client: `src/lib/knowledge/knowledge-api.ts` (memory-api.ts style: typed fetches,
typed errors, `AUTH_BASE`).

### Predictions / generation (toggle-gated)

`src/hooks/useCompletion.ts` `completeSingle` (and batch/paragraph): when
`knowledgeBaseEnabled`, fire `searchKnowledge` fetch **in parallel** with the existing
branching search; inject top snippets (cap ~3 snippets / ~1200 chars) via `buildPrompt`'s
existing **`preSourceBlock`** slot, labelled `Background knowledge:` — never spliced into
`sourceText` (per the D4/D6 prompt-ordering rules in `completion-service.ts`). KB fetch
failure degrades silently to no block (drafting must never break on KB).

## Error handling

- Indexing failures are non-fatal everywhere: `failed` docs still string-search.
- KB search failures in the draft path degrade to no KB block.
- Agent KB tools return the standard tool-error shape; missing doc/node → not_found.
- Upload errors: oversize, unsupported type, extraction failure (docx/pdf that yields
  empty text → 422 with a clear message; the original is not stored).
- R2 orphan handling mirrors agent-artifacts: delete R2 object if the row insert fails.

## Testing

- `db/shared/knowledge.test.ts`: CRUD, org inheritance in `listDocs`, search snippeting,
  node resolution, validation + secret scan.
- Tree builder unit tests: heading/page segmentation, depth/node caps, Haiku response
  parsing against `scripts/mock-openrouter.ts` fixtures, failure → `failed` status.
- auth-worker route tests: role floors (PROJECT_LEAD project / MAINTAINER org / VIEWER
  reads), upload→extract→index lifecycle, reindex, delete cleans R2.
- sync-worker: external read routes + MCP tools added to the permission-parity matrix.
- SPA: knowledge-api client tests; KnowledgeBaseSection helpers; completion-service test
  asserting the KB block lands in `preSourceBlock` position only when toggled on; toggle
  persistence through `useProjectSettings`.

## Out of scope (v1)

- Third-party (external API) uploads and deletes.
- Vector embeddings of any kind.
- Improved PDF extraction (existing rudimentary extractor accepted).
- Per-doc enable/disable; per-project opt-in of individual org docs.
- Re-ranking or caching of retrieval results.
