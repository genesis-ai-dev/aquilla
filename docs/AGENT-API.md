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
| 10 | Cold-start test | **Not run** — no evidence of an executed cold-start session in this repo |

Also not yet implemented, called out explicitly rather than left silent: `run_checks`, jobs
(`get_job`), export (`prepare_export`/`get_export`), OAuth 2.1, rate limiting, and an MCP staging
tool for `PlanImport` (REST-only). Full detail in `docs/api/agent-api.md` §8 and the running list
in `docs/swarm/AGENT-API-TRACES.md`.

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
(`events.provenance` JSONB on Postgres; JSON column via the shim on D1):

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

---

## 3. Commands, changesets, confirmation, and jobs

### Commands, not events

External callers never submit raw outbox-shaped events. They submit **stable domain
commands**; Aquilla validates them (permissions, invariants, preconditions) and
compiles them into canonical internal events. This decouples the public contract from
event internals and makes provenance forgery or invariant bypass structurally
impossible rather than merely prohibited.

Initial command set:

- `CreateProject`, `UpdateProjectSettings`
- `PlanImport` (produces an import changeset from an artifact + recipe, §5)
- `SetTranslation` (batch; compiled to `target.cell.commit` chained per AD-9 —
  pinned to `sourceEventId`, parented on the prior target event)
- `LinkMedia` (attach audio/alignment relationships)

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
| Projects | `list_projects`, `get_project`, `create_project`, `update_project` |
| Artifacts | `create_artifact_upload`, `inspect_artifact` |
| Ingestion | `preview_import`, `prepare_import` |
| Reading | `search_project`, `read_content`, `read_history` |
| Translation | `prepare_translations` |
| Verification | `run_checks` — structured, actionable failures (e.g. `"term 'covenant' rendered 3 ways: [refs]"`), never a bare 400 |
| Changesets | `get_changeset`, `confirm_changeset`, `discard_changeset` |
| Jobs | `get_job` |
| Export | `prepare_export`, `get_export` |

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

- **Changesets, jobs, credentials → Postgres (Neon).** These are greenfield tables:
  starting them on Postgres avoids a later migration and D1's single-writer ceiling
  for large plans and job bookkeeping. Dependency note: if the Postgres migration
  isn't production-ready when AQU-533 builds, the identical schema runs through the
  existing D1-compatible shim (`db/shim/d1-postgres.ts`) as a stopgap — this decision
  must not silently block the API on the migration finishing.
- **Uploaded source artifacts and large immutable manifests → R2** (object storage),
  referenced by digest.

---

## 5. Ingestion and artifact model

Aquilla's parsers largely run client-side today; the server import endpoint receives
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
| D9 | Changesets/jobs/credentials on Postgres (D1-shim fallback if migration timing forces it); artifacts/manifests on R2 |
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
