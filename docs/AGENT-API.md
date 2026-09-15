# Agent API — trusted commands, changesets, and autonomy modes (AQU-533)

Status: **draft v2, post-review** · 2026-07-13 · Ryder + Claude
Linear: [AQU-533](https://linear.app/frontierrandd/issue/AQU-533/expose-a-public-permission-checked-api-agentic-import-admin-partner)
Related: AQU-550 (Biblica), AQU-525 / AQU-532 (WAHA JSON import)

## Implementation status (2026-07-17)

This document is the **design spec**. For what is actually implemented and callable today, see
the practitioner guide: [`docs/api/agent-api.md`](api/agent-api.md) (plus
[`docs/api/examples/blackfoot-import.md`](api/examples/blackfoot-import.md) and
[`docs/api/openapi.yaml`](api/openapi.yaml)). The v1.1 follow-on slice (token UI, the three
remaining commands, commit idempotency) is tracked in
[`docs/superpowers/specs/2026-07-17-agent-api-v1.1-design.md`](superpowers/specs/2026-07-17-agent-api-v1.1-design.md).
Status against the §6 release gates:

| # | Gate | Status |
| --- | --- | --- |
| 1 | Credential creation, scoping, expiry, revocation | **Done** — `auth-worker/src/routes/credentials.ts`. As of v1.1, also mintable/revocable from the UI (Preferences → Account → "API tokens", `src/components/settings/ApiTokensSection.tsx`) — see the v1.1 design doc §1. |
| 2 | Read project state via MCP and REST | **Done** — `sync-worker/src/external/read-routes.ts`, `mcp-handlers.ts` |
| 3 | Update translations via commands + changesets | **Done.** `SetTranslation`/`PlanImport` since v1; as of v1.1, `CreateProject`, `UpdateProjectSettings`, and `LinkMedia` are also implemented and MCP-stageable (via the same `prepare_translations`/`confirm_changeset` tools) — see the v1.1 design doc §2 and `docs/api/agent-api.md` §4.1. `PlanImport` remains the only command with no MCP staging tool (REST-only). |
| 4 | Upload and preserve a source artifact | **Done**, but worker-proxied bytes, not signed URLs (D10 not yet built). As of v1.1, artifact upload also accepts `kind: audio` (for `LinkMedia`) via `x-artifact-kind: audio` — see the v1.1 design doc §3. |
| 5 | One supported end-to-end import: Blackfoot / USFM | **Done** via `PlanImport` (REST only, capped 5,000 cells/changeset) — see the worked example |
| 6 | Ask/act changeset behavior incl. one-time approval + `plan_stale` | **Done** — `sync-worker/src/external/{prepare,commit}.ts`, `auth-worker/src/routes/changeset-approvals.ts`, `src/pages/ApproveChangeset/`. As of v1.1, commit is also crash-safe: prepare-time ids + a `committing` status let a mid-commit retry resume without duplicating events/files — see the v1.1 design doc §4. |
| 7 | Permission-parity tests | **Done for the shipped command set** — `sync-worker/src/__tests__/external-permission-parity.test.ts` covers reads, `SetTranslation`, `PlanImport`, and (v1.1) `LinkMedia`; `CreateProject`/`UpdateProjectSettings` role/scope gates are covered in `external-project-commands.test.ts` instead of the shared parity matrix. |
| 8 | Provenance envelope + execution receipts | **Done.** Envelope stamped on every changeset-committed event (`SetTranslation`/`PlanImport`/`LinkMedia`); `channel` now distinguishes `"mcp"` vs `"rest"` (v1.1 — no longer hardcoded). `CreateProject`/`UpdateProjectSettings` are receipt-only and carry their provenance in the receipt itself (no `events.provenance` row — see `docs/api/agent-api.md` §6). There is still no separate audit ledger for reads/searches/discarded plans. |
| 9 | Minimal REST + MCP docs with one worked example | **Done** — `docs/api/agent-api.md`, `docs/api/openapi.yaml`, `docs/api/examples/blackfoot-import.md`, kept current through v1.1. |
| 10 | Cold-start test | **Not run** — no evidence of an executed cold-start session in this repo. Cold-start hardening landed 2026-07-21 after real-world agent feedback: unauthenticated discovery root (`GET /api/v1/external` — machine-readable API map), REST bootstrap pair (`GET /me`, `GET /projects`), JSON 404s with hints on unmatched external paths, teaching 401/405 messages, a `quickstart` in `get_capabilities`, and a hand-to-your-agent [`docs/api/QUICKSTART.md`](api/QUICKSTART.md). |

Also not yet implemented, called out explicitly rather than left silent: `run_checks`, jobs
(`get_job`), the job-shaped export pair (`prepare_export`/`get_export`), OAuth 2.1, and an MCP
staging tool for `PlanImport` (REST-only). Single-file **round-trip export ships** (AQU-858) as
one synchronous call instead of that pair — `export_file` (MCP) and
`GET .../files/:fileId/export` (REST), gated at the org export floor; a whole-project bundle
and target-format writers beyond the imported original are still open. Full detail in `docs/api/agent-api.md` §8 and the running list
in `docs/swarm/AGENT-API-TRACES.md`. Rate limiting is now complete: `/search` (2026-07-30 pen
test), changeset prepare/commit, and artifact upload (2026-08-20 pen test), plus `/me`,
`/projects`, project/file/cell GETs, artifact meta/content/inspect, and changeset GET/discard
(2026-08-27 pen test) are all throttled per credential.

---

## 1. Product thesis and user outcomes

Aquilla exposes a **trusted command and changeset API**: one authenticated domain
command layer, with MCP as the agent-facing adapter and REST as the integration-facing
adapter. External agents (Claude Code, Codex, WAHA's Hermes) and partner systems drive
translation projects end-to-end — discover capabilities, read, stage, verify, commit,
export — with every mutation permission-checked against the caller's credential and
recorded with server-stamped provenance.

The goal is not "an API." It is making a translation team plus an agent strictly more
capable than either alone: the agent does the coordination and drafting at machine
speed; the human holds authority, reviews staged work in plain language, and can always
answer *who did what, under whose authority, and why*.

### The Claude Code analogy (orientation, not architecture)

Claude Code worked because it dropped an agent into an environment with five
properties: a legible workspace (read/grep), safe composable verbs (edit/run), a
verification loop (tests), history with attribution (git), and permission boundaries.
Aquilla's internals already have the equivalents; this API packages them for external
callers.

| Claude Code | Aquilla equivalent | Status |
| --- | --- | --- |
| read / grep | search cells, concordance, cell history | primitives exist — expose |
| edit a file | `SetTranslation` command → target-cell event | exists internally |
| run tests | rules/health checks, structured failures | primitives exist — **key gap to expose** |
| git log / blame | append-only event log: history, attribution, compensating operations | exists for cell/file operations |
| plan mode / accept-edits | **ask mode / act mode** (§2–3) | new |
| CLAUDE.md | project brief: glossary, style, audience | partial (project settings) |
| MCP servers | Aquilla as a remote MCP server | new |
| hooks / CI | webhooks on events → continuous localization | deferred |

The analogy is load-bearing only where scoped precisely: the append-only event model
provides history, attribution, and compensating operations **for event-backed
operations** (cells, files). Project creation, settings, and administrative operations
currently write directly to tables; §2 defines how v1 handles that honestly.

### User outcomes (lifecycle function map)

Design principle: **the agent coordinates; Aquilla's deterministic primitives
execute.** An agent should never parse USFM with ad-hoc code; it should drive the
ingestion workflow (§5).

1. **Onboard** — create project, upload source artifacts, import with round-trip
   fidelity, apply human-readable labels.
2. **Ingest heterogeneous shapes** — e.g. USFM + per-chapter audio + phrase-level
   timestamp alignment. The agent recognizes the moving parts, selects/authors mapping
   recipes, and wires them together; parsers and jobs do the mechanical work.
3. **Translate the next logical chunk** — the agent assembles context (prior
   renderings via search, glossary, adjacent cells) and stages drafts. Judgment lives
   in context assembly; search is the tool.
4. **Verify** — run rules/health/consistency checks, iterate until green. Without this
   an agent can only *write*, never *finish*.
5. **Hand off for review** — staged changesets, comments, approval. Humans review
   summarized diffs, not walls of text.
6. **Round-trip export** — reconstruct the original format, deliver.
7. **Keep in sync** — upstream change → staleness (AD-9) → re-translate deltas →
   re-verify. (Deferred; validation scenario in §7.)
8. **Migrate in** — Crowdin → Aquilla and similar (§7).

### Why now

The single highest-frequency ask of the 2026-07-09 sessions: WAHA's Matthew (Hermes
agent, Crowdin migration dry-run), Biblica (AQU-550), and Ryder's own need to script
the Blackfoot import. One prospect's evaluation question verbatim: *"do you have an
API I can just point my agent at?"* Discovery detail (Crowdin pricing, migration
economics) lives in the AQU-533 comment thread, not here.

---

## 2. Trust model: identity, permissions, autonomy, provenance

### Credentials

- **Hashed, revocable API credentials**, minted per user in auth-worker. Internal
  sync tokens are never exposed externally.
- Scoped to **org and/or project**. Language-level authorization is deferred until a
  real use case requires it.
- Carry an **autonomy ceiling** (`ask` or `act`, below), expiry, last-used metadata,
  rotation, and emergency revocation.
- **Live role/membership resolution on every call** — a credential never outlives or
  exceeds the user's current role. Every command passes the same per-action permission
  checks as the in-app path.

Invariant: **the agent can never exceed the credential, and the credential can never
exceed the user.**

Auth transport: personal access tokens for the initial developer preview; OAuth 2.1
for broadly compatible remote MCP (connector directories) as a fast follow.

### Autonomy modes

The credential defines a **ceiling**, not a suggestion. A request may downgrade `act`
to `ask`; nothing can upgrade `ask` to `act`.

- **Ask mode** — the agent prepares work as a staged changeset and *cannot commit it*.
  Commitment requires a one-time human approval assertion (§3). The human both
  authorized the credential and approved this specific changeset.
- **Act mode** — commits flow through the same validated pipeline, auto-confirmed. The
  human granted persistent autonomy when issuing the credential, and that grant is
  itself recorded.

This gives "human provenance" a precise, two-tier meaning rather than a vague claim.

### Provenance — server-stamped envelope, not caller payload

Trusted provenance never lives solely inside caller-controlled business payloads. The
server stamps an envelope on every externally-originated event
(`events.provenance` JSONB on Postgres):

```json
{
  "origin": "agent" | "integration",
  "human_authority": { "user_id": "…", "credential_id": "…" },
  "agent": {
    "run_id": "…",
    "session_id": "…",
    "provider": "caller_declared",
    "model": "caller_declared"
  },
  "channel": "mcp" | "rest",
  "autonomy_mode": "ask" | "act",
  "changeset_id": "…",
  "confirmation_id": "…"    // present iff ask-mode approval consumed
}
```

- **Verified fields** (stamped by Aquilla): `human_authority`, `channel`,
  `autonomy_mode`, `changeset_id`, `confirmation_id`, `origin`.
- **Caller-declared fields** (recorded, not verified): agent provider/model/run
  metadata. A partner claiming a particular model is testimony, not fact, and the
  schema says so.

### What goes in the event log vs the audit ledger

- **State-changing domain actions** → the event log, with the provenance envelope.
- **Reads, searches, check runs, tool failures, discarded plans** → a separate
  bounded-retention **agent-run audit ledger**. Forcing reads into the domain event
  stream would make it noisy and expensive; keeping them out keeps "the event log is
  the project's history" true and useful.

### Scope honesty for v1

Some operations (project creation/settings, admin) mutate tables directly today,
outside the event log. v1 therefore:

- limits the **event-provenance promise** to event-backed operations (cells, files);
- covers non-event operations with **execution receipts + audit-ledger entries**
  carrying the same envelope fields;
- treats unifying admin operations under event coverage as explicitly deferred (§8).

The doc promises universal *auditability* in v1, and universal *event* provenance only
where events exist.

**Org-scoped reads (AQU-1236).** Credentials have always been scoped org-**or**-project,
but the read tier only ever exposed the single scoped project, so a console managing a
partner's whole workspace had to mint and juggle one token per project. An org-scoped
credential can now enumerate its orgs (`GET …/orgs`), list a given org's projects
(`GET …/orgs/:orgId/projects`, or `GET …/projects?orgId=`), and search an explicit list
of projects in one call (`GET …/search?q=&projectIds=a,b`). Three invariants hold:

- **Scope narrows, never widens.** Every query runs through the credential's own scope.
  A *project*-scoped credential sees exactly its one project and that project's org — it
  cannot reach the org's siblings. Naming a resource outside the scope returns
  `scope_denied`, not an empty list, so "not yours" never reads as "empty".
- **Cross-project search is all-or-nothing.** Every listed project is gated before any of
  them is searched; one unauthorized id fails the whole call. A partial result set would
  otherwise be indistinguishable from a complete one, and diffing result sets would leak
  which project ids exist. Fan-out is bounded (10 projects) and charges the search rate
  limit once per project searched.
- **No new PII.** These routes expose ids, names, and the *caller's own* role level.
  Org member lists, emails, and owner identities stay on the in-app surfaces.

---

## 3. Commands, changesets, confirmation, and jobs

### Commands, not events

External callers never submit raw outbox-shaped events. They submit **stable domain
commands**; Aquilla validates them (permissions, invariants, preconditions) and
compiles them into canonical internal events. This decouples the public contract from
event internals and makes provenance forgery or invariant bypass structurally
impossible rather than merely prohibited.

Initial command set:

- `CreateOrg` (create an organization owned by the credential's minting user — always
  human-approved, unscoped credentials only, default tier, rate-limited)
- `CreateProject`, `UpdateProjectSettings`
- `PlanImport` (produces an import changeset from an artifact + recipe, §5)
- `SetTranslation` (batch; compiled to `target.cell.commit` chained per AD-9 —
  pinned to `sourceEventId`, parented on the prior target event)
- `LinkMedia` (attach audio/alignment relationships)

### Multi-language projects: target-language lanes

A project can hold several target languages at once via AQU-538 **lanes** — a lane is
a language tag (e.g. `es`, `pt`) registered in the project settings array
`settings.targetLanes`; every cell keeps one shared source plus one independent
target row/chain per lane. The external surface is lane-aware end to end:

1. **Register lanes** (once): `UpdateProjectSettings` writing `settings.targetLanes:
   ["es", "pt"]` (merge into the existing blob; pass the live `ifMatchVersion`).
2. **Write per lane**: `SetTranslation` takes an optional `laneId` — the compiled
   `target.cell.commit` is stamped `payload.targetLang` and lands on that lane's row
   and chain slot. An unregistered `laneId` is rejected at prepare
   (`validation_failed`). Omitted `laneId` = the default lane (unchanged behavior).
3. **Read per lane**: `GET .../files/:fileId/cells?lane=es` (and the MCP
   `read_content` `lane` argument) filters target cells to one lane; source cells are
   always included. Without `lane`, every lane's targets are returned, each carrying
   its `targetLang`.
4. **Import several lanes at once**: each `PlanImport` cell takes
   `variants: [{ laneId, languageTag?, content, contentHtml? }]` sharing that cell's
   source.

Preconditions and drift are lane-scoped — the same cell edited concurrently in two
different lanes never triggers `plan_stale` across lanes. The self-discovery
surfaces teach this workflow: `GET /api/v1/external` (`multiLanguage` section) and
the MCP `get_capabilities` tool (`multiLanguage` field).

### Changesets: immutable execution plans

A changeset is not a bag of proposed writes; it is an **immutable execution plan**:

- normalized commands, or an immutable **import manifest reference** (digest + object
  storage pointer — never thousands of proposed operations inlined in one JSON value)
- resource/version **preconditions** (e.g. "cell X's target head is event E")
- required permissions, resolved at prepare time
- **deterministic effect summary** — counts and descriptions computed by the server
  from the plan itself: "creates 1 file (Genesis.usfm), adds 1,533 source cells,
  modifies 12 translations, removes nothing"
- warnings and skipped items (no silent truncation — anything dropped is listed)
- content digest, expiration, status, and (after commit) an **execution receipt**

Rules:

- The effect summary is **server-computed, never agent-narrated**. The agent may add
  phrasing *around* the fixed facts; the facts come from the plan.
- If relevant state changes between prepare and confirm, the commit returns
  **`409 plan_stale`**. Aquilla never silently recomputes and applies something other
  than what was approved.
- **One pipeline for both modes:**

```
prepare → validate permissions → resolve operations → summarize
    ask → human approval assertion → commit
    act → automatic confirmation      → commit
```

Act mode is the same machinery with confirmation auto-granted — one code path, and
every agent action (including autonomous ones) leaves a changeset record and receipt.

### Ask-mode confirmation: enforced, not requested

A summary hash proves which plan was referenced; it does not prove a human saw it. So:

- **Ask-mode credentials can prepare but cannot commit. Period.**
- Confirmation requires a **one-time approval assertion** from an authenticated
  Aquilla browser session: `get_changeset` returns an approval URL; the human opens
  it (already signed in or signing in), sees the server-computed effect summary and
  warnings, and approves or rejects.
- The assertion **binds**: human identity, changeset digest, credential id, timestamp,
  and expiry. The server **consumes it exactly once**; the agent's next
  `confirm_changeset` (or a poll) observes the committed status.
- A trusted-agent-host assertion path (the host performs a real user confirmation
  interaction and attests to it) is a designed extension, not v1.

This preserves the claim that matters: Aquilla *enforces* "ask before acting" —
it does not trust the agent, or the agent's host, to behave.

v1 ships the minimal approval page (summary, warnings, approve/reject). A full
pending-changesets review surface with cell-level diffs is deliberate v2 UI — the
changeset shape already carries everything it needs.

### Jobs

Long-running work (imports, exports, large check runs) executes as **resumable async
jobs**: commit returns a job id; callers poll `get_job` (event streaming later). Job
completion produces the execution receipt: counts, generated event IDs, warnings,
export/artifact IDs.

---

## 4. Interfaces: one command layer, two adapters

```
MCP tools ──────┐
                ├── authenticated domain commands ── permissions / events / jobs
REST API ───────┘
```

Both adapters ship in v1 against the same command layer. Neither has capabilities the
other lacks; they differ in shape, not power.

- **MCP** — the agent-facing adapter: high-level, outcome-oriented tools with rich
  descriptions (the tool descriptions are the agent's documentation). Remote MCP
  hosted on Workers, mounted under `aquilla.app/api/*` (Safari drops `*.workers.dev`;
  same constraint as SYNC.md).
- **REST** — uploads/downloads, resources, jobs, pagination, and direct partner
  integrations, with OpenAPI. Minimal but real in v1: the command endpoints, artifact
  signed-URL flows, changeset/job resources.
- **Binary transfer always via signed HTTP upload/download URLs** — never inside MCP
  messages.

Design discipline retained from draft v1: the tool-shaped workflows are authored
first, and REST exposes the same commands — the failure mode to avoid is a generic
CRUD surface with MCP bolted on.

### MCP tool surface (organized by outcome)

| Outcome | Tools |
| --- | --- |
| Discovery | `get_capabilities`, `get_identity_and_scope` |
| Orgs | `list_orgs` — **implemented** (AQU-1236): the orgs a credential covers, `{ id, name, role, role_source }`. REST: `GET …/orgs` and `GET …/orgs/:orgId/projects` |
| Projects | `list_projects` (optional `orgId` filter — AQU-1236), `get_project`, `create_project`, `update_project` |
| Artifacts | `create_artifact_upload`, `inspect_artifact` |
| Ingestion | `preview_import`, `prepare_import` — **implemented**: both parse an already-uploaded source artifact server-side with the built-in DOM-free parsers (txt, md, json, po, properties, obs, vtt, srt, sbv, csv, tsv, usfm, docx; 5000-cell cap) — preview returns cells without staging, prepare stages a `PlanImport` changeset linking the artifact. Upload stays REST-only (`POST …/artifacts`, 25MB). REST equivalent: `POST …/artifacts/:artifactId/parse` (body `{ "stage": true }` to stage). `docx` is parsed by the SAME `extractDocxStrings` the in-app Import dialog runs (AQU-1237 moved it off `DOMParser`/JSZip onto the platform-only `xml-lite`/`zip-lite` readers), so an agent import and a browser import of one file yield identical cells. Still DOM-bound and not yet server-parseable: pptx, html, xliff, tmx, usx, idml. |
| Reading | `search_project`, `search_projects` (cross-project, explicit id list, max 10 — AQU-1236), `read_content`, `read_history`, `find_similar_cells`, `get_prompt_preview`, `list_memory`, `read_cell_memory` |
| Quality | `read_quality`, `read_term_consistency` — **implemented (AQU-1231)**: per-file health (0-100) + coverage (total/filled/validated + percentages) and the project rollup; and the term-consistency drift list (per active concept: occurrences, consistent count/percent, which approved rendering was used in which cells, and the cells that used none). Both are PARITY reads — `read_quality` delegates to the internal `health-rollup` and `files/:fileId/progress` routes the in-app health ring and progress surfaces read, and `read_term_consistency` runs the SPA's own scan (`src/lib/check/term-consistency-scan.ts`, shared with the in-app "Check file" pass). Whatever counting rules the progress projection applies (e.g. AQU-1083's headings/paratextual exclusion) the API inherits by construction — there is no second denominator to keep in step. REST equivalents: `GET …/projects/:projectId/quality` and `GET …/projects/:projectId/terms/consistency` (both take optional `fileId`, `lane`; the latter also `onlyDrift=1`). |
| Translation | `prepare_translations` |
| Verification | `run_checks` — structured, actionable failures (e.g. `"term 'covenant' rendered 3 ways: [refs]"`), never a bare 400. The term-consistency half of this now exists as `read_term_consistency` (above); `run_checks` remains unimplemented for the RULE pass. |
| Changesets | `get_changeset`, `confirm_changeset`, `discard_changeset` |
| Jobs | `get_job` |
| Export | `prepare_export`, `get_export` — shipped instead as the synchronous `export_file` (AQU-858); the job-shaped pair is still open |

`get_capabilities` + `get_identity_and_scope` are what make the cold-start test (§6)
passable: an agent must be able to learn what it may do before trying to do it.

### Operational contract

- **Idempotency keys on all mutations** (UUIDv7, consistent with the outbox design)
- **Cursor pagination** on all list endpoints
- **Optimistic concurrency** via preconditions; `plan_stale` on violation
- **Stable, machine-actionable error codes**: `permission_denied`, `scope_denied`,
  `plan_stale`, `confirmation_required`, `validation_failed`, `job_failed`,
  `rate_limited` — each with a human-readable message and, where applicable, the
  data an agent needs to self-correct
- **Rate limits** and maximum file/job sizes, published in `get_capabilities`
- **API versioning** (`/api/v2/…` convention already in place) and MCP tool
  compatibility policy: additive changes are free; breaking changes version the tool
- **Execution receipts** on every commit and job: counts, generated event IDs,
  warnings, artifact/export IDs

### Storage decisions

- **Changesets, jobs, credentials → Postgres (Neon).** These are greenfield tables,
  avoiding a later migration off D1's single-writer ceiling for large plans and job
  bookkeeping.
- **Uploaded source artifacts and large immutable manifests → R2** (object storage),
  referenced by digest.

---

## 5. Ingestion and artifact model

Aquilla's DOM-bound parsers run client-side; the worker-safe text parse core
(`src/lib/parsers/parse-text-formats.ts`) now ALSO runs server-side behind
`preview_import` / `prepare_import`, and the raw import endpoint still accepts
already-parsed cells. A magical server-side `import_file` would overpromise. Ingestion
is instead an **explicit workflow** the agent drives:

```
upload artifact (signed URL)
→ inspect / detect format
→ select or create a mapping recipe
→ preview extracted entities and relationships
→ prepare import changeset (manifest digest, not inlined operations)
→ confirm (ask) / auto-confirm (act)
→ execute as resumable job
→ execution receipt
```

This one pipeline covers:

- **Known formats** (USFM, XLIFF, subtitles) — first-party recipes backed by the
  existing parsers.
- **Custom JSON** (WAHA's ~6 differently-shaped files) — the agent authors a **mapping
  recipe** once; thereafter it is a deterministic, reusable, versionable asset. No
  ad-hoc production code, and the customer's second file of the same shape imports
  with zero agent judgment. Recipes are the "agent coordinates, primitives execute"
  principle made into a product object.
- **Source-file preservation** for round-trip export (original artifact in R2, keyed
  to the file).
- **Human-readable labels** applied at import time.
- **Multimodal relationships** — text, audio, and alignment artifacts linked via
  `LinkMedia` in the same changeset.

Large imports reference an **immutable manifest** in object storage by digest; the
changeset stays small, the plan stays immutable, and a Biblica-scale migration doesn't
try to squeeze tens of thousands of operations through one JSON value.

External-asset wrinkle (from the Hermes case): Crowdin XLIFF exports contain
session-cookie-authenticated image URLs. The *client-side agent* fetches such assets
under the user's session and uploads them as artifacts; Aquilla never pulls
credentialed third-party URLs.

---

## 6. v1 release gates (AQU-533 ships when these pass)

1. External credential creation, scoping (org/project), expiry, revocation
2. Read project state (search, content, history) via MCP and REST
3. Update translations and project state via commands + changesets
4. Upload and preserve a source artifact (signed URL → R2)
5. **One supported end-to-end import: Blackfoot / USFM** (the dogfood case)
6. Ask/act changeset behavior, including the one-time approval assertion and
   `plan_stale`
7. **Permission-parity tests** — for every exposed command, an API caller can do
   exactly what the same user can do in-app, and nothing more
8. Provenance envelope stamped on all event-backed mutations; execution receipts on
   all commits and jobs
9. Minimal REST + MCP documentation with one worked example (the Blackfoot import)
10. **Cold-start test** — a fresh Claude Code or Codex session, given only the MCP URL
    and a credential, completes a toy project end-to-end (create → import → translate
    → check → export) unassisted. Metric: **agent onboarding time**. If an agent can't
    learn the API from `get_capabilities` and the tool descriptions alone, the API
    isn't done.

---

## 7. Design validation scenarios (shape the architecture; do not gate v1)

These become evaluation fixtures as they land:

- **WAHA / Crowdin migration** — Hermes dry-runs a real Crowdin project into a
  disposable Aquilla project as staged changesets; the approval/review surface is the
  demo. Exercises: recipes, manifests, external-asset handling, ask-mode at scale.
- **Six arbitrary JSON structures** (AQU-525/532) — recipe authoring and reuse.
- **Biblica-scale migration** (AQU-550) — manifest/job limits, partner REST shape.
- **Multimodal USFM + audio + alignment** — `LinkMedia`, multi-artifact changesets.
- **Continuous external synchronization** — webhooks, staleness-driven re-translation
  loops.

Dry-run migrations deserve product framing: a disposable project plus staged
changesets means a prospect can point their agent at Aquilla, migrate real data,
inspect the staged result, and throw it away — the evaluation path *is* the switching
path.

---

## 8. Decisions and deferred questions

### Decided (this doc)

| # | Decision |
| --- | --- |
| D1 | One authenticated domain command layer; MCP and REST are adapters, both in v1 |
| D2 | External callers submit commands, never raw events |
| D3 | Autonomy mode is a credential ceiling; downgrade allowed, upgrade impossible |
| D4 | Changesets are immutable execution plans; `plan_stale` over silent recompute |
| D5 | Ask-mode commit requires a one-time human approval assertion from an authenticated Aquilla session; ask credentials cannot commit |
| D6 | Provenance is a server-stamped envelope; verified vs caller-declared fields are distinguished |
| D7 | Reads and agent telemetry go to a bounded-retention audit ledger, not the event log |
| D8 | v1 event-provenance promise limited to event-backed operations; non-event ops get receipts + audit coverage |
| D9 | Changesets/jobs/credentials on Postgres; artifacts/manifests on R2 |
| D10 | Binary transfer via signed URLs, never MCP message bodies |
| D11 | Ingestion is an explicit workflow with mapping recipes; no magical server-side `import_file` |
| D12 | PATs for developer preview; OAuth 2.1 for remote MCP distribution |

### Deferred

- Trusted-agent-host approval assertions (approval without an Aquilla browser session)
- In-app pending-changesets review UI with cell-level diffs (v2; shape supports it)
- Bringing project/settings/admin operations under event coverage
- Language-level credential scoping
- Webhooks / event streaming for jobs and continuous sync
- MCP connector-directory listing (needs OAuth 2.1)

### Open for feedback

1. Approval-assertion UX: is a bare approval page enough for v1, or does the Hermes
   demo pull cell-diff review forward?
2. Recipe format: declarative mapping DSL vs sandboxed transform — where's the line
   before recipes become ad-hoc code again?
3. Rate-limit and job-size numbers for `get_capabilities`.
4. Credential UX in the app (mint/scope/revoke screens) — v1 gate or CLI-first?

---

## Status addendum (2026-07-21, AQU-AGENT swarm)

This section is additive — nothing above is superseded. The **AQU-AGENT** work added an
**in-app agent harness** (Cloudflare Sandbox containers for code execution + living memory),
while file importing remains a separate, purpose-built product workflow.

The in-app chat does **not** expose `plan_import` and does not mint an internal API credential.
Users select files in the Import dialog. Deterministic adapters run first; unsupported or malformed
inputs may be inspected and parsed in an isolated, default-deny sandbox. The sandbox route writes
no project state: it returns a validated normalized manifest to the ordinary preview, and a human
confirmation commits through the browser's `ImportService` path. This prevents chat and generated
parser code from becoming a second, ambiguous import pipeline.

`PlanImport` remains part of this document's external REST/MCP command layer for authorized
integrations. Those callers still receive the changeset, permission, provenance, `plan_stale`, and
ask-mode approval guarantees described above. Historical chat timelines may also render an older
`changeset.staged` frame, but the current chat harness no longer creates one.

What's genuinely new (out of scope for this document, covered in
[`docs/AGENT-SANDBOX.md`](AGENT-SANDBOX.md)): the sandbox code-execution service
(`agent-worker/`, no model keys, default-deny egress), the chat harness tool surface
(`run_code`/`load_artifact`/memory tools), the dedicated sandbox-assisted import route, and the
living-memory/brief tables and review UI. None of it changes the external credential, command,
changeset, or provenance model documented above — read `docs/AGENT-SANDBOX.md` for the sandbox
architecture and come back here for what an external `PlanImport` changeset is once staged.

## Status addendum (2026-08-17, AQU-926 — command registry P0)

The command layer is now the **shared write spine for both agent surfaces** (see
`docs/COMMAND-REGISTRY.md` for the binding contract and `docs/AGENT-CAPABILITY-AUDIT.md`
§6–7 for the rationale and roadmap):

- **Shared catalog** — `db/shared/command-catalog.ts`: kind/tier/floor metadata + on-demand
  `paramsDoc`s. Drives the in-app agent's role-filtered prompt index (`describe_command` serves
  the bodies) and `get_capabilities`' new `commands` index. `commandKinds` stays at the v1.1
  five for compatibility; the `commands` index is the authoritative vocabulary.
- **New commands** — `PatchSettings` (field-scoped settings write, per-key floors, sole
  command, one op per key; `POLICY_SETTINGS_KEYS` are never agent-writable) and `EmitEvents`
  (≤200 role-allowed events per sole-command changeset from `ALLOWED_EMIT_KINDS`: comments,
  waives, validations (testimony-flagged), back-translation, repin, file rename/delete/restore,
  assignments incl. reassign; head pins are server-resolved, whole-plan rejection on any bad
  reference). `UpdateProjectSettings` is deprecated and now rejects policy-key changes.
- **Living Memory writes (AQU-1228)** — `AddExample` / `AddDecision` / `AddNote` (CONTRIBUTOR)
  and `RetireExample` (PROJECT_LEAD), each a sole-command receipt-only changeset writing the
  `agent_memories` table (Living Memory is not event-sourced, so these do NOT ride
  `EmitEvents`). The changeset's human confirmation stands in for the in-app Memory review,
  but only when the APPROVING user's live role is PROJECT_LEAD+; otherwise the entry lands
  `proposed` and the receipt's `memoryStatus` says so. Retirement archives (out of retrieval,
  still auditable); human-edited entries are never overwritten or retired through this
  surface. See `docs/COMMAND-REGISTRY.md` §2.
- **Session principal** — the in-app agent stages changesets through the same engine via
  session sync-token routes (`/api/v1/changesets/:projectId[...]` on the sync host), with
  `credential_id = 'session'`, forced ask mode, `channel: "app"` provenance, and the existing
  `/api/v2/changesets/:id/approval|approve|reject` human gate; the SPA's live ChangesetCard
  commits after approval (per-item confirmation for testimony kinds).

## Status addendum (2026-09-09, AQU-1222 — the read half of the settings surface)

Live verification of AQU-1176 found its write half (`PatchSettings`) deployed but its
reads missing, which left the command unusable from outside: `ifMatchVersion` is a hard
equality check against the live settings version, and nothing published that number.
Three gaps closed:

- **`GET /api/v1/external/projects/:projectId`** — new REST read returning
  `{ id, name, org_id, archived, role, settings, settingsVersion, settingsUpdatedAt }`.
  `settingsVersion` is what `PatchSettings.ifMatchVersion` must equal (0 before the
  project's first settings write). The MCP `get_project` tool returns the identical
  payload — both call `external/project-detail.ts`, the single shared read, the way
  `projects-list.ts` is shared by the list adapters. Scope/role gating is unchanged:
  credential scope first, then live project role >= VIEWER, so a wrong-project
  credential gets `scope_denied` rather than a leak.
- **`describe_command` on the external surface** — the shared catalog's `paramsDoc` was
  reachable only from the in-app harness even though `get_capabilities.commands` pointed
  external agents at it. Now an MCP tool (`describe_command({ kind })`, no `kind` returns
  the index) and a REST pair (`GET /api/v1/external/commands`,
  `GET /api/v1/external/commands/:kind`). All three surfaces read
  `db/shared/command-catalog.ts`, so they cannot disagree; `agentReachable: false` kinds
  stay indistinguishable from unknown. The REST pair is unauthenticated for the same
  reason the discovery root is — static documentation, no project data.
- **`docs` link** — the API map advertised
  `github.com/genesis-ai-dev/aquilla/blob/main/docs/api/QUICKSTART.md`, a private repo
  that 404s for every external caller. `DOCS_URL` is now `/api/v1/external/docs`, served
  unauthenticated by the discovery route as a Markdown rendering **generated from the
  API map itself**, so the prose cannot drift from the machine-readable map.

## Status addendum (2026-09-10, AQU-1230 — effective-prompt preview)

Prompt tuning through the Agent API was write-only: `PatchSettings` can change
`systemPrompt`, `completionSettings`, `translationBrief` and `rules`, and the terminology
path can add concepts, but nothing showed what the copilot actually receives after
injection. An agent had to change a setting, draft a cell, and infer.

- **New read** — `GET /api/v1/external/projects/:projectId/cells/:cellId/prompt-preview`
  (optional `targetLang=<lane>`, `fileId=<id>`), MCP tool `get_prompt_preview`. Returns
  the assembled `messages` (system + user, exactly as sent) alongside `parts` — base
  instructions after language substitution, the brief block, the compiled rules block,
  `injectedTerms`, the retrieved `examples`, and the preceding approved-target discourse
  window — plus `generation` (the project's provider/model/temperature/maxTokens/topK)
  and `retrieval` (primitive, corpus size, upstream project). VIEWER floor, standard
  external rate limit; it drafts nothing and spends no credits.
- **Fidelity by construction, not by re-implementation.** The pure prompt builders moved
  out of `src/lib/completion/completion-service.ts` (browser-bound: `import.meta.env`,
  `window`, storage, i18n) into `src/lib/completion/prompt-build.ts`, and concept→rule
  compilation into `src/lib/terminology/compile-core.ts`. Both are alias-free and
  worker-importable — the same contract as `src/lib/parsers/parse-text-formats.ts` — so
  the preview calls the builders the editor calls, over the same AD-13 branching-search
  retrieval and the same compiled terminology rules. `completion-service.ts` re-exports
  them, so no SPA call site changed.
- **What a read cannot reproduce is named, not omitted.** `warnings` flags an empty
  effective source (an untranscribed media section) and USFM footnote markers, whose
  output contract the live call derives from the open editor buffer. Per-device provider
  overrides (user Settings, `localStorage`) are invisible server-side, so `generation`
  reports the project's configuration.

## Status addendum (2026-09-10, AQU-1229 — Living Memory read model)

Living Memory — the human-authored project brief plus the path-keyed entries the copilot
learns from — is now **readable by an external agent**, at parity with the in-app Memory
surface (AQU-932). Two GETs, `sync-worker/src/external/memory-read-routes.ts`, mirrored as
the MCP tools `list_memory` / `read_cell_memory`:

- `GET /api/v1/external/projects/:projectId/memory?status=&kind=&limit=&cursor=` — the brief
  plus every entry with its full content, status, `humanEdited`, and `kind` (derived from the
  path prefix: `examples/` → example, `decisions/` → decision, `notes/` → note,
  `observations/` → observation). Same rows and same ordering (most-recently-updated first)
  as the in-app page.
- `GET /api/v1/external/projects/:projectId/files/:fileId/cells/:cellId/memory` — what
  retrieval would inject for that cell's draft, produced by calling `buildMemoryContext`,
  the copilot's own retrieval path.

Three properties of this surface are contract, not implementation detail:

- **`inRetrieval` / `retrieval.*` report reality, not intent.** Only *approved* entries reach
  a prompt, and only the most-recently-updated `MEMORY_INDEX_RENDER_CAP` of them; the rest are
  reachable but not injected. The cap now lives in `db/shared/agent-memory.ts` and is imported
  by both the prompt assembly (`auth-worker/src/lib/agent/prompt-augment.ts`) and this read
  model, so the number an agent is told cannot drift from the prompt it describes.
- **Retrieval is project-scoped today.** There is no per-cell ranking or filtering — every
  cell in a project gets the same brief and the same index. The per-cell route therefore
  reports `retrieval.scope: "project"` rather than implying a narrowing that does not happen.
  If per-cell retrieval lands later (AQU-1232's similarity search being the likely vehicle),
  `scope` is how a caller detects it.
- **Author identities are pseudonymous (AQU-1180 default).** `created_by`/`reviewed_by`/
  `updated_by` hold usernames; agent-facing reads replace each with a keyed per-project
  pseudonym (`author_<hex>`), and `provenance.credentialId` is dropped. Stable within a
  project (so "one person made these decisions" survives), uncorrelatable across projects.
  Keyed HMAC rather than a bare hash because usernames are low-entropy and the projectId is
  already known to the caller.

## Status addendum (2026-09-10, AQU-1234 — cell-structure commands)

The command layer could write a cell's TEXT (`SetTranslation`) and create a whole file
(`PlanImport`), but not restructure an existing one. Three commands close that gap,
implemented in `sync-worker/src/external/commands-structure.ts` (shapes, validation,
floor) and `structure-engine.ts` (prepare/commit):

- **`InsertCell`** `{ fileId, value, afterCellId?, cellId?, type?, canonicalRef?, startMs?,
  endMs?, metadata? }` → `source.cell.create` plus a `source.cell.reorder` for whatever was
  anchored at that position. `afterCellId: null`/omitted inserts at the file head.
- **`DeleteCell`** `{ fileId, cellId }` → a `source.cell.reorder` per following row, a
  `target.cell.delete` per translated lane, then `source.cell.delete`.
- **`SplitCell`** `{ fileId, cellId, offset, targets, targetOffsets?, newCellId? }` →
  `source.cell.commit` truncating the original, `source.cell.create` for the second half,
  reorders, and either `target.cell.delete` per lane (`targets: 'blank'`) or a pair of
  `target.cell.commit`s per lane (`targets: 'divide'`).

All three use the SAME cell-lifecycle events the workspace emits, so the event log after an
agent restructure is indistinguishable from a human one. Each must be the **sole command** in
its changeset (a structural edit is one indivisible rewrite of a file's anchor chain; two in
one plan would have to be ordered and re-pinned against a chain the first one moved), and each
floors at **PROJECT_LEAD** — the same reasoning `emitEventsFloor` applies to `source.cell.*`:
this surface never runs the app's per-event `allowLineCreation` carve-out, so restructuring
source rows stays a re-import-shaped act.

Unlike the other engines these pin their own heads in `plannedIds.structure` rather than the
shared `preconditions` list: the shared drift gate compares both the source head and the lane's
target head for every precondition it holds, and pinning through it would fail a perfectly good
insert because somebody translated the successor cell in the meantime. A split's cut text is
computed at prepare too, so commit applies exactly what was approved rather than re-cutting
whatever the cell says at commit time.

**Validation:** both halves of a split come out unvalidated. `'blank'` removes the target rows
that held the validation; `'divide'` re-commits them, which resets `validated` because the
chain head moved. This is stated in `describe_command`.

### Round-trip safety — refusal, not repair

Structural edits are **refused** on a file whose cells carry a preserved export slot (an IDML
v2 / OOXML package-block locator), with `validation_failed` and
`details.reason = "preserved_export_slots"`. Those exporters address cells BY locator and throw
on any cell without one: inserting makes `cellContract` throw, deleting a rejoin sibling makes
`mergeSlicedUnit` throw ("N of them are missing from this export"), and splitting would need
consistent rejoin index/count/ranges plus a protected-HTML cut that no plain-text offset can
make safely. Refusing keeps the hard requirement true by construction — a file that
round-tripped before a structure command still round-trips after it. Both failure modes are
pinned by tests in `src/lib/export/exporters/idml.rejoin.test.ts`.

USFM's lossless bundle export overlays translations onto the preserved original **by canonical
ref**, so it needs narrower guards instead:

- `InsertCell` rejects a `canonicalRef` already used in the file (a duplicate silently drops
  one of the two from the deliverable).
- `SplitCell` is refused on a cell that has a canonical ref in a file with a preserved source
  blob — the second half cannot reuse the ref, so it would vanish from the export.
- `DeleteCell` is safe: the ref's override simply disappears and the original text stands.

`SplitCell` also refuses cells carrying structured source or target HTML
(`details.reason = "structured_source_html"` / `"structured_target_html"`) — a plain-text
offset cannot cut markup without unbalancing it.

**`DeleteCell` orphan guard:** `source.cell.delete`'s projection removes exactly one `cells`
row and cleans up nothing else, so prepare refuses a cell that still owns validators, waivers,
comments, back-translations, audio takes, cell links or assignment rows, naming them in
`details.dependents`. This is the same reasoning the workspace's remove-line applies
(`src/lib/timeline/user-lines.ts` `isLineEmpty`), generalized from "the line is empty" to "the
line owns nothing" so an agent can still remove a stray imported row that has text.

### MergeCells (deferred)

`MergeCells` is deliberately **not** shipped. The issue scoped it as "include only if the
semantics for combining validation state and history are clean" — they are not, and each corner
is a product call rather than an implementation detail:

1. **History.** Two cells are two independent event chains. A merge has to pick one chain to
   survive and tombstone the other, or invent a join event the projection has no concept of.
   Either way one cell's per-cell history stops being reachable from the surviving row, which
   is a durable loss of the audit trail Aquilla's whole model rests on.
2. **Validation.** If A is validated and B is not, the merged cell is neither validated nor
   cleanly unvalidated: dropping A's validation discards real testimony, and keeping it claims
   somebody checked text they never saw. `SplitCell` escapes this because BOTH halves honestly
   lose validation; a merge has no equivalently honest answer.
3. **Everything hanging off the losing cell** — validators, waivers, comments,
   back-translations, audio takes, links, assignment rows — has to be re-pointed or dropped.
   `DeleteCell` refuses rather than guess; a merge cannot refuse, because re-pointing is the
   whole point of merging.
4. **Lanes.** Merging cells translated in different lane sets means choosing, per lane, between
   concatenation, one side, and blank — four commands' worth of policy inside one verb.

The agent-reachable path in the meantime: `SetTranslation` the combined text onto the cell you
want to keep, then `DeleteCell` the other once it owns nothing. That is two reviewable
changesets with no invented semantics, and it is what the workspace does today.
