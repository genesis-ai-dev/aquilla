# AQU-AGENT Wave-1 contracts (READ-ONLY for builders — orchestrator-owned)

All Wave-1 agents code against these exactly. Deviations require a SWARM-TODO trace +
note in your report; do NOT silently change a contract. TS snippets are normative shapes;
copy types locally where imports can't cross (SPA ↔ workers). Workers share `db/shared/`.

## 0. Revised architecture (post-recon)

The existing agent stack is the base — we EXTEND it:
- Harness = `auth-worker/src/routes/agent.ts` SSE loop (OpenRouter, staged proposals). We add
  tools: sandboxed code exec, artifact loading, PlanImport staging, memory.
- Writes = existing external changeset layer (`sync-worker/src/external/`): the harness stages
  PlanImport changesets via an ephemeral internal ask-mode `aqk_` credential → human approves
  at existing `/approve/:changesetId`.
- NEW worker `agent-worker/` = sandbox execution service ONLY (Cloudflare Sandbox container).
  No model keys, no LLM loop, no business logic.
- Memory/brief = new Postgres tables + auth-worker routes + SPA review UI.

## 1. Sandbox worker HTTP API (owner: W1A; consumed by W1B)

Worker name `aquilla-agent-sandbox`, local dev port **8790**. All routes require
`Authorization: Bearer ${AGENT_SANDBOX_KEY}` (shared secret; 401 otherwise). JSON unless noted.
Sandbox instance id = `sessionId` (one container per agent session). No arbitrary egress:
default-deny network; NO secrets in container env.

- `POST /sessions/:sessionId/exec` body `{language: "js"|"python", code: string, timeoutMs?: number}` →
  `200 {ok: boolean, stdout: string, stderr: string, resultJson?: string, durationMs: number, truncated?: boolean}`
  (stdout/stderr capped at 64KB each, `truncated` flag; timeout default 60s, max 300s → `{ok:false, stderr:"timeout"}`)
- `POST /sessions/:sessionId/files` body `{path: string, contentBase64: string}` → `{ok: true}` (≤25MB)
- `GET /sessions/:sessionId/files?path=<urlencoded>` → raw bytes (`application/octet-stream`) or 404
- `POST /sessions/:sessionId/fetch-artifact` body `{key: string, path: string}` →
  `{ok: true, bytes: number}` — worker reads R2 object `key` from `SNAPSHOTS` binding
  (bucket `aquilla-snapshots`) and writes it into the container at `path`. 404 if missing.
- `DELETE /sessions/:sessionId` → `{ok: true}` (destroy container; idempotent)
- `GET /health` → `{ok: true}` (no auth)

Error envelope: `{error: {code: "unauthorized"|"not_found"|"validation_failed"|"exec_failed"|"too_large", message}}`.
Dockerfile: base `docker.io/cloudflare/sandbox:0.7.0` + `pip install pandas openpyxl lxml python-docx chardet beautifulsoup4`.
Path safety: reject `..`/absolute paths outside `/workspace`; all container paths under `/workspace`.

## 2. New harness tools (owner: W1B; schemas normative)

Registered alongside existing `read|examples|search|draft|emit|sql|docs|aquifer` tools:

- `run_code {language: "js"|"python", code: string, timeoutMs?: number}` → sandbox exec result.
  First use in a run lazily "opens" the session container.
- `load_artifact {artifactId: string, path: string}` → resolves artifact row (project-scoped,
  via sync-worker external artifacts GET) → `fetch-artifact` into sandbox. Returns `{ok, bytes, path}`.
- `read_sandbox_file {path: string, maxBytes?: number}` → returns text (utf-8, capped 48KB) for
  the model to inspect outputs.
- `plan_import {fileName: string, fileType: string, sourceLanguage?: string, targetLanguage?: string,
  cells: Array<{id?: string, original: string, translated?: string, context?: string, group?: string, type?: string}>}`
  → stages a PlanImport changeset via changeset-bridge (below) →
  `{changesetId, approvalUrl, summary, cellCount}`. Hard limit 5000 cells (PLAN_IMPORT_MAX_CELLS);
  reject larger with a clear message telling the model to split files, not chunk silently (trace v2).
- `propose_memory {path: string, content: string, rationale: string}` → creates proposed memory
  (memory API §3) → `{memoryId, status}`. Path must match `^[a-z0-9-/]+\.md$`, ≤10KB content.
- `propose_brief_update {content: string, rationale: string}` → brief proposal → `{proposalId}`.
- `read_memory {path?: string}` → without path: approved-memory index (path + first line);
  with path: full content of one approved memory.

**changeset-bridge** (`auth-worker/src/lib/agent/changeset-bridge.ts`, W1B): mints an ephemeral
internal credential — insert into `api_credentials` via `db/shared/api-credentials.ts` helpers
(`mintApiToken()`), `mode='ask'`, project-scoped, `expires_at = now()+2h`, name
`agent-run:<runId>` — then calls sync-worker `POST /api/v1/external/projects/:projectId/changesets`
(base = env `SYNC_WORKER_URL`) with the plaintext token. Best-effort revoke at run end.
NEVER act-mode. NEVER return the token in SSE frames or persist plaintext.

**Prompt assembly** (W1B, using W1C's `buildMemoryContext`): system prompt sections in English —
project brief (verbatim, marked human-authored) → approved-memory index (JIT detail via
`read_memory`) → tool guidance → language rule: "All internal scaffolding is English. Reply to
the user in the project's working language: <lang>." While a run is parsing untrusted artifact
content, memory tools are READ-ONLY (`propose_memory`/`propose_brief_update` return
`validation_failed` "memory writes disabled while processing untrusted content") — flag is set
when `load_artifact`/`run_code` has touched artifact bytes in the current model turn; resets
only after a turn with no untrusted-content tool use. Cost cap: accumulate OpenRouter
`usage.cost`; halt gracefully at `AGENT_RUN_COST_CAP_CENTS` (env, default 500) with a
`budget.exhausted` frame.

## 3. Memory & brief API (owner: W1C; auth-worker, mounted under /api/v2)

Tables → `db/postgres/migrations/0066_agent_memory.sql` + additive `db/postgres/schema.sql`:

```sql
CREATE TABLE agent_memories (
  id uuid PRIMARY KEY,
  project_id text NOT NULL,
  path text NOT NULL,
  content text NOT NULL,
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','rejected','archived')),
  human_edited boolean NOT NULL DEFAULT false,
  rationale text,
  provenance jsonb,             -- {runId?, sessionId?, credentialId?}
  created_by text,              -- username
  reviewed_by text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX agent_memories_approved_path ON agent_memories(project_id, path) WHERE status='approved';
CREATE INDEX agent_memories_project ON agent_memories(project_id, status);

CREATE TABLE project_briefs (
  project_id text PRIMARY KEY,
  content text NOT NULL DEFAULT '',
  updated_by text,
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE project_brief_proposals (
  id uuid PRIMARY KEY,
  project_id text NOT NULL,
  content text NOT NULL,
  rationale text,
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','rejected')),
  created_by text,
  reviewed_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz
);
CREATE INDEX project_brief_proposals_project ON project_brief_proposals(project_id, status);
```

Routes (session JWT via authMiddleware; role via `resolveProjectRole`):
- `GET  /api/v2/projects/:projectId/agent-memory?status=` → `{memories: AgentMemory[]}` (VIEWER+)
- `POST /api/v2/projects/:projectId/agent-memory` `{path, content, rationale?, provenance?}` →
  proposed (CONTRIBUTOR+). Server rejects paths not matching `^[a-z0-9-/]+\.md$`, content >10KB,
  and content matching secret patterns (`aqk_`, `sk-`, `-----BEGIN`, `AKIA[0-9A-Z]{16}`, `password\s*[:=]`).
- `POST /api/v2/projects/:projectId/agent-memory/:id/review` `{action: "approve"|"reject"}` (PROJECT_LEAD+).
  Approving when another approved row holds the same path → supersede: old row → `archived`.
- `PATCH /api/v2/projects/:projectId/agent-memory/:id` `{content}` — human edit: sets
  `human_edited=true`, `version+1` (PROJECT_LEAD+, or CONTRIBUTOR on own proposal).
- **Agent-channel enforcement**: requests carrying header `x-aquilla-agent-run: <runId>` are
  agent-originated. On such requests: PATCH to a row with `human_edited=true` → 403
  `{error:{code:"human_edit_protected"}}`; review endpoints → allowed ONLY when project setting
  `agentMemoryAutonomy === 'agent-low-risk'` AND path starts with `observations/`; else 403.
  Default autonomy: `'human'` (stored in project settings JSON; read via loadProjectSettings).
- Brief: `GET /api/v2/projects/:projectId/brief` (VIEWER+) · `PUT` `{content, ifMatchVersion}`
  (PROJECT_LEAD+, humans only — agent channel 403 `brief_human_only`; version conflict 409) ·
  `POST /brief/proposals` `{content, rationale}` (agent or human) ·
  `POST /brief/proposals/:id/review` `{action}` (PROJECT_LEAD+, NEVER agent channel).

Shared module `db/shared/agent-memory.ts` (W1C owns): `buildMemoryContext(db, projectId)` →
`{brief: string, memoryIndex: Array<{path, firstLine}>, readMemory(path): Promise<string|null>}`
— used by W1B's prompt assembly. Pure functions + parameterized SQL, PGlite tests.

## 4. SSE protocol additions (owner: W1D; `src/lib/agent/protocol.ts`)

New `AgentFrame` variants (additive — do not break existing consumers):
- `{type:"tool.code.start", runId, language, codePreview}` (first 400 chars)
- `{type:"tool.code.output", runId, stdout, stderr, truncated, durationMs}`
- `{type:"changeset.staged", runId, changesetId, approvalUrl, summary, cellCount}`
- `{type:"memory.proposed", runId, memoryId, path, preview}`
- `{type:"brief.proposed", runId, proposalId, preview}`
- `{type:"budget", runId, spentCents, capCents}`
- `{type:"budget.exhausted", runId, spentCents, capCents}`

W1B emits these server-side with the exact same field names (copy shapes; server file
`auth-worker/src/lib/agent/frames.ts` if a local type home is needed).

## 5. SPA surfaces

- W1D owns: `src/lib/agent/protocol.ts`, `agent-client.ts`, `run-state.ts` extensions;
  `src/components/agent/**` EXCEPT `memory/`; renders new frames (code activity block with
  stdout/stderr disclosure, staged-changeset card linking `approvalUrl`, memory-proposal toast,
  budget meter). Adds tab slot in AgentWorkbench: `sessions | memory` where the memory tab
  lazy-imports `@/components/agent/memory/AgentMemoryTab` (W1E's file — W1D writes ONLY the
  import + tab registration).
- W1E owns: `src/components/agent/memory/**` (AgentMemoryTab: proposed-memory review list
  approve/reject, approved list with edit (PATCH), provenance display, human-edited badge;
  BriefEditor: view/edit brief (PUT with version), proposal review) + `src/lib/agent/memory-api.ts`
  (fetch client for §3 routes, session JWT from existing auth lib) + tests.
- Neither touches App.tsx (route `/project/:id/agent` already exists).

## 6. Env & dev-stack (owner: W1A)

- agent-worker wrangler.toml: container class `Sandbox` (from `@cloudflare/sandbox`), DO binding
  `Sandbox`, R2 `SNAPSHOTS`=`aquilla-snapshots` (+ per-env -dev/-staging blocks mirroring
  sync-worker), secret `AGENT_SANDBOX_KEY`. NO routes at top level. `instance_type: "standard-1"`.
- auth-worker additions (W1B applies in auth-worker wrangler/env only — vars `AGENT_SANDBOX_URL`,
  `SYNC_WORKER_URL` (exists in dev), secret `AGENT_SANDBOX_KEY`).
- `scripts/dev-stack.ts` (W1A): boot agent-worker on :8790 with
  `--var AGENT_SANDBOX_KEY:dev-sandbox-key WRANGLER_LOCAL:1`; pass
  `AGENT_SANDBOX_URL:http://127.0.0.1:8790 AGENT_SANDBOX_KEY:dev-sandbox-key` to auth-worker;
  skip gracefully with a warning if Docker unavailable (`--no-sandbox` flag + auto-detect) —
  the rest of the stack must still boot (harness tools return a clear "sandbox unavailable" error).

## 7. Cross-cutting rules (all builders)

- English for all prompts/scaffolding; user-facing strings follow existing i18n conventions.
- No `any`; files <500 lines (split modules); match hono/route/test conventions of the host worker.
- Tests: PGlite for worker DB code; vitest happy-dom for SPA; do not touch other agents' files.
- Append open items to `docs/swarm/AQU-AGENT-TRACES.md` + `SWARM-TODO(aqu-agent): ...` comments.
- NEVER push, NEVER merge, NEVER touch main/dev. Commit to your own branch only.
- Every git command: explicit `cd <your worktree>` prefix.
