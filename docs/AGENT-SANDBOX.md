# Agent sandbox — architecture (AQU-AGENT)

Status: **in progress** (AQU-AGENT swarm, started 2026-07-21) · authoritative contracts:
[`docs/swarm/AQU-AGENT-CONTRACTS.md`](swarm/AQU-AGENT-CONTRACTS.md) (read-only for builders;
this doc narrates the same shapes in prose and links back rather than duplicating the normative
TypeScript/SQL). Orchestration log / STOP criteria:
[`docs/swarm/AQU-AGENT-ORCHESTRATION.md`](swarm/AQU-AGENT-ORCHESTRATION.md).

This document describes **the new stack** — sandboxed code execution, artifact loading, staged
imports, and living memory — layered on top of the **existing** agent harness
(`auth-worker/src/routes/agent.ts`, `src/lib/agent/`, `AgentWorkbench`) and the **existing**
Agent API changeset/command layer (`docs/AGENT-API.md`). It does not replace either. If you're
looking for credentials, commands, or the ask/act changeset model, read `docs/AGENT-API.md`
first — this doc assumes it.

## Why: what the sandbox adds

The existing harness can read project state, draft translations, and stage changesets, but it
cannot **run code**. A real translation org's uploads are messy in ways no fixed set of parsers
anticipates (see `e2e/fixtures/agent/README.md` for concrete examples: merged header rows,
delimiter drift, swapped source/target columns, mixed scripts, inconsistent transcript
formatting). The sandbox gives the agent a **Project-Think-style ladder**:

- **Tier 0** — built-in parsers (`src/lib/parsers/*`) handle known formats deterministically.
  No sandbox involved.
- **Tier 1** — the agent writes small JS to inspect/reshape data it can't fully trust to a fixed
  parser (e.g. "does this CSV's row 1 look like a real header, or a merged title cell?").
- **Tier 2** — the agent writes Python (pandas/openpyxl/lxml/chardet/beautifulsoup4) for shapes
  Tier 1 can't handle cleanly — spreadsheets, encoding-ambiguous text, HTML-ish exports.

v1 runs both Tier 1 and Tier 2 inside the **same sandbox container**, not as separate dynamic
worker isolates — true Code-Mode-style dynamic isolates for Tier 1 are traced as future work
(see `docs/swarm/AQU-AGENT-TRACES.md` `tier1-isolates`).

## Components

```
SPA (AgentWorkbench / ImportDialog)
  │  SSE agent transport / dedicated import request
  ▼
auth-worker  ── agent.ts + /api/v1/import/parse (OpenRouter)
  │  agent tools: run_code, load_artifact, read_sandbox_file,
  │               propose_memory, propose_brief_update, read_memory
  │
  ├──HTTP (Bearer AGENT_SANDBOX_KEY)──▶  agent-worker (NEW, aquilla-agent-sandbox)
  │                                       Cloudflare Sandbox container per session
  │                                       exec / files / fetch-artifact / destroy
  │
  ├──validated normalized result──▶ ImportDialog preview ──▶ ImportService
  │                                            (ordinary source/target-lane commit path)
  │
  └──Postgres (Neon)──▶  agent_memories, project_briefs, project_brief_proposals
```

- **Harness** (`auth-worker/src/routes/agent.ts` + `auth-worker/src/lib/agent/*`) — unchanged
  transport and run loop; extended with the new tools above.
- **agent-worker** (new) — sandbox-execution-only. No model keys, no LLM loop, no business
  logic. Chat uses one Cloudflare Container per run, started by a `Sandbox` Durable Object of
  our own (see "Runtime" below); a fallback import uses a unique one-request session. Both are
  destroyed at the end (or idempotently on retry). See contracts §1 for the exact HTTP surface.
- **Import writes** — the sandbox route writes no project state. It stores the upload only under
  a temporary R2 key, validates the normalized output, destroys the session, and deletes that
  object. The browser shows the ordinary Import preview and, only after confirmation, commits
  through `ImportService`; originals, target lanes, manifests, and bindings therefore use the
  same path as every deterministic adapter. General chat intentionally has no import tool.
- **Memory / brief** (new Postgres tables + auth-worker routes + SPA review UI) — see "Memory
  gating" below.

### Runtime (Sandbox SDK 1.x)

`agent-worker` is on `@cloudflare/sandbox` 1.x, which is not a newer 0.x but a different shape:
there is no `Sandbox` base class and no `getSandbox()`. The package contributes only `Files`
(file I/O through the `sandbox-shim` helper baked into the image); everything else is our code
against the native Container API.

- **`Sandbox` Durable Object** (`agent-worker/src/sandbox-do.ts`, bound in `wrangler.toml` with
  `scheduling_policy = "durable_object"`) — one instance per session. It starts its container
  with `ctx.container.start({ image: images.sandbox, instance: "standard-1", enableInternet: false })`,
  sets the 10-minute inactivity timeout (the old `sleepAfter`; AQU-1848 pool semantics) after
  `start()` and again in its constructor when a restarted object finds the container running, and
  exposes `runCode` / `writeFile` / `readFile` / `destroy` over RPC. The Worker reaches it through
  `env.Sandbox.getByName(sessionId)`; `resolve-sandbox.ts` adapts the stub to the `SandboxLike`
  seam the routes and their tests are written against. The policy constants live in
  `src/container-exec.ts`, and `test/runtime-policy.test.ts` asserts them.
- **`/exec` is one process per call.** 1.x has no code interpreter, so each call runs a fresh
  `python3` or `node` under GNU `timeout --kill-after=5` — the deadline is enforced *inside* the
  container and stops everything the code started — with the code on stdin and
  `cwd=/workspace`. A small runner (`agent-worker/runner/run.py` and `run.mjs`, at `/opt/aquilla`
  in the image) ends stdout with a sentinel line and one JSON line carrying the last expression's
  value and the exception, so the wire contract (`ok`, `stdout`, `stderr`, `resultJson`) is
  unchanged. Nothing but files under `/workspace` carries over between calls; the harness's
  `run_code` tool and the import route already treat every call as a standalone program.
- **Image** (`agent-worker/Dockerfile`): `python:3.13-slim-trixie` plus Debian `nodejs`, the pinned
  Python packages, the runners, and `sandbox-shim` copied from
  `docker.io/cloudflare/sandbox:<version>` — a donor image that is not runnable on its own. The
  donor tag must equal the npm package version (the shim protocol is versioned; the runtime-policy
  test enforces it, and Dependabot bumps both in one PR because the donor is a `FROM … AS` stage).
- **Deploying the image.** The container application is created by the first
  `wrangler deploy --env <development|production>` of this configuration (containers config is
  per-env; the applications are named `aquilla-agent-sandbox-dev-sandbox` and
  `aquilla-agent-sandbox-sandbox`). Moving a class to the `durable_object` policy is one-way:
  after that deploy, 0.x code can no longer start containers for it, even via `wrangler rollback`.
  No agent-sandbox container application had ever been deployed on the account before this
  migration, so nothing was switched in place.

### Local and deployed runtime

`pnpm dev` continues to run the auth and sync Workers locally through Wrangler/workerd; those
Workers do not require Docker. Code execution is an optional, separately isolated capability:

- If `AGENT_SANDBOX_URL` and `AGENT_SANDBOX_KEY` are configured together in the process
  environment or `auth-worker/.dev.vars`, the local auth Worker uses that endpoint and no local
  container is started.
- Otherwise, `scripts/dev-stack.ts` may start `agent-worker` on port 8790 when a compatible local
  container engine is available. This path remains available for developers who use it.
- `--no-sandbox` disables both choices. The rest of the stack still starts, and code-execution
  tools report a clear unavailable result.
- Deployed auth Workers must use a stable deployed sandbox URL. A `127.0.0.1` URL in deployed
  Wrangler configuration points back at that Worker runtime, not at a developer's machine.

## Security model

- **No secrets in the container.** The sandbox never receives an OpenRouter key, a sync
  credential, or any project secret in its environment. It receives only: code to execute,
  files explicitly pushed to it (`POST /sessions/:id/files`, `fetch-artifact`), and returns
  stdout/stderr/a result value. The harness — outside the container — is the only thing that
  ever holds the ephemeral `aqk_` credential, and it is never passed into the sandbox.
- **Default-deny egress.** `agent-worker`'s `Sandbox` Durable Object starts its container with
  `enableInternet: false` (`src/container-exec.ts`, asserted by `test/runtime-policy.test.ts`),
  so the container has no outbound network and no DNS resolution at all. It cannot
  exfiltrate data to an external host, cannot fetch a credentialed third-party URL on the
  user's behalf (contrast with the client-side agent pattern in `docs/AGENT-API.md` §5's
  "External-asset wrinkle" — that's a *different*, browser-context agent; the sandbox is
  deliberately more restricted), and cannot phone home anywhere except through the harness's
  own tool calls.
- **Path safety.** All container paths are constrained under `/workspace`; `..`/absolute paths
  outside it are rejected at the agent-worker HTTP boundary (contracts §1).
- **Auth.** Every sandbox route requires `Authorization: Bearer ${AGENT_SANDBOX_KEY}` (a shared
  secret between auth-worker and agent-worker, never exposed to the browser or the model).
- **Untrusted-content memory lockout.** While a run is parsing bytes it loaded from an artifact
  (`load_artifact`) or has executed sandbox code that touched artifact bytes in the current
  model turn, `propose_memory`/`propose_brief_update` are **read-only**: calls return
  `validation_failed` with the message "memory writes disabled while processing untrusted
  content." This closes the most direct prompt-injection path — a malicious cell value or
  uploaded file cannot get itself written into the project's persistent living memory in the
  same turn it was read. The lock resets only after a subsequent model turn that touches no
  untrusted-content tool. This is a **turn-scoped** flag, not a whole-session lock: the agent
  can still propose memory later in the same run, once it's reasoning from its own summary
  rather than directly from raw untrusted bytes.
- **Human-edit protection** (memory, not sandbox, but part of the same trust boundary): once a
  human edits a memory row (`PATCH .../agent-memory/:id`, setting `human_edited=true`), the
  **agent channel** (requests carrying `x-aquilla-agent-run: <runId>`) can never overwrite that
  row again — a subsequent agent-originated PATCH gets `403 human_edit_protected`. The agent
  may propose a *new* memory or ask about the discrepancy in conversation, but it cannot
  silently clobber a human's correction. See contracts §3 for the full route/permission table.
- **No parser-to-project write capability.** Generated parser code receives no token, database,
  R2 binding, or network. It can only write `/workspace/result.json`; the auth worker treats
  that output as untrusted, validates it, and returns it for a separate human preview.

## Memory gating (autonomy)

Every project has an `agentMemoryAutonomy` setting, default `'human'`:

- **`'human'`** (default) — every memory proposal and every brief proposal requires a human
  review action (`POST .../agent-memory/:id/review`, PROJECT_LEAD+). The agent can never
  self-approve anything it wrote.
- **`'agent-low-risk'`** — the agent channel MAY self-approve, but only for proposals whose
  `path` starts with `observations/` (a namespace reserved for low-stakes, easily-revised notes
  — e.g. "this org's exports occasionally swap source/target columns"). Anything outside that
  path prefix — glossary decisions, style rules, anything under the brief — still requires a
  human, unconditionally.
- **The project brief is always human-approval-only**, in both autonomy modes. `PUT
  /api/v2/projects/:projectId/brief` returns `403 brief_human_only` on the agent channel no
  matter the setting; `POST /brief/proposals/:id/review` is never reachable from the agent
  channel either. This is a deliberate asymmetry from memory: the brief is the project's
  highest-oversight artifact (glossary/style/audience — the project's "CLAUDE.md," see
  `docs/AGENT-API.md`'s Claude Code analogy table), so it does not get the low-risk carve-out
  memory has.

## Cost caps

The harness accumulates OpenRouter's reported `usage.cost` across a run. When the running total
would exceed `AGENT_RUN_COST_CAP_CENTS` (env, default 500 = $5.00), the run halts gracefully:
it emits a `budget.exhausted` SSE frame and stops issuing further model calls, rather than
erroring mid-tool-call or silently truncating output. The SPA renders a running `budget` frame
(spent/cap) so a human watching the session sees the meter before it trips, not just after.

## Frontend surfaces

- **Run timeline** (`AgentDockView` / `AgentRunView`) gains new frame renderers: a code-activity
  block (stdout/stderr, collapsed by default, `codePreview` shown inline), a staged-changeset
  card linking to `approvalUrl`, and a memory-proposal toast/card.
- **`AgentWorkbench`** gains a `sessions | memory` tab slot; the memory tab lazy-imports
  `AgentMemoryTab` (proposed-memory review, approved-memory list with human-edit affordance and
  provenance display) and a `BriefEditor` (view/edit with optimistic-concurrency `ifMatchVersion`,
  proposal review).
- Import approval uses the existing Import-dialog preview; it is not mixed into agent chat or
  the changeset approval page.

## Testing

- `e2e/specs/agent-import.spec.ts` — container-gated Import-dialog golden path (enable with
  `AGENT_SANDBOX_E2E=1` when provisioned; see the spec's header comment and
  [`e2e/JOURNEYS.md`](../e2e/JOURNEYS.md)).
- `e2e/fixtures/agent/` — three deliberately messy fixtures (mixed-delimiter/BOM/swapped-column
  CSV, a hand-built legacy-shaped XLSX + CSV twin, a bilingual timestamped interview transcript)
  with a README documenting each trap and the expected importer behavior.
- Worker-side: PGlite for the new Postgres tables/routes (`db/shared/agent-memory.ts`,
  `auth-worker/src/routes/agent-memory.ts`); agent-worker gets its own package test suite:
  the routes against an injected fake sandbox (exec/files/fetch-artifact/pool), the runner
  scripts run with the host's `python3`/`node` (`test/runner.test.ts`), and the policy
  constants (`test/runtime-policy.test.ts`). The Durable Object itself is exercised by `pnpm dev`
  against Docker, not in CI.

## Known gaps (traced, not built in v1)

See [`docs/swarm/AQU-AGENT-TRACES.md`](swarm/AQU-AGENT-TRACES.md) for the live list. Notable
ones from this doc's perspective:

- True dynamic-worker isolates for Tier 1 (v1 runs Tier 1 JS in the same sandbox container as
  Tier 2 Python).
- agent-worker's zone route claim and first `wrangler deploy` (CI's Cloudflare token can't
  mutate zone routes — this is a human/local task, same constraint as `sync-worker`/`auth-worker`
  per `CLAUDE.md`).
- `e2e/specs/agent-import.spec.ts` remains container-gated until a sandbox endpoint is available
  in CI; unit and worker route tests cover the same trust boundaries without a live container.
