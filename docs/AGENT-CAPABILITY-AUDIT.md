# Agent Capability Audit

**What the in-app agent and API-token agents can do today, mapped against everything managers
and operators can do in the UI — and how to close the gap without bloating the agent's context.**

Audited 2026-08-17 against `dev` (`9890424c`). Method: four parallel code audits (in-app agent
harness, external Agent API, manager UI + permission model, operator UI + event vocabulary),
each grounded in file:line citations, plus a survey of how Claude Code / OpenAI Codex / Cursor
structure large capability surfaces. Related docs: `docs/AGENT-API.md`, `docs/AGENT-SANDBOX.md`.

---

## 1. Executive summary

Humans can reach **~150 distinct actions** through the UI (~30 client-emitted event kinds for
operators plus ~90 manager-level REST/settings actions). Against that:

- The **in-app agent** has **15 tools**. Its read side is excellent (aligned passage reads,
  FTS search, validated exemplars, a guarded read-only SQL escape hatch, docs cookbooks, a
  no-network code sandbox). Its write side is narrow: everything stages for human apply
  (correct), but the client Apply path supports only **5 of the 20+ stageable event kinds** —
  and it has **zero** reach into settings-shaped state (rules, termbase, brief PUT, project
  settings) or the identity plane (members, invites, scopes, assignments).
- The **external Agent API** (PAT/MCP) has 13 tools but only **5 write command kinds**
  (SetTranslation, PlanImport, CreateProject, UpdateProjectSettings, LinkMedia) against an
  internal event vocabulary of ~40 kinds. No checks, no export, no comments, no memory, no undo.

Three structural findings explain nearly every itemized gap:

1. **The three-write-planes problem.** App writes live in (a) the event log, (b) the
   settings blobs (project/org), and (c) auth-worker identity tables (members, invites,
   scopes, assignments, orgs). Agents partially reach plane (a) only. Managers live in
   (b) and (c) — which is why the agent can do fragments of translator work but almost no PM work.
2. **The apply gap.** The in-app server can stage most event kinds, but the review UI can
   apply only 5; everything else renders as raw JSON with Apply disabled. The external surface
   has the opposite: a real server-side commit engine (digest, receipts, idempotency, provenance)
   but a tiny command vocabulary. **Each side has the half the other needs.**
3. **No job primitive.** Bulk work (draft a book, batch BT, synth-all, big imports) is
   client-driven loops or capped agent iterations (draft = 10 cells/call, 12 write
   iterations/run). "Thorough" agent work needs server-side jobs with progress and resume.

**Recommendation in one line:** converge both agents on a single **command registry** built by
extending the external changeset engine — every user-reachable action becomes a registered,
role-floored, risk-tiered, display-renderable command; the agent tool count stays ~10 forever
(new capability = new registry entry + cookbook, not a new tool); discovery is role-filtered
and on-demand. This is the same architecture Claude Code/Codex/Cursor use (few composable
verbs + progressive disclosure + policy-gated writes), and Aquilla already has every seed of it.

---

## 2. The permission foundation (already right — build on it)

"Everything the user does checks permissions" is **true server-side**, with a short list of
exceptions. The foundation to inherit:

- **One 7-level ladder everywhere**: VIEWER 100 / COMMENTER 200 / REVIEWER 300 /
  CONTRIBUTOR 400 / PROJECT_LEAD 500 / MAINTAINER 600 / OWNER 700, defined in lock-step in
  four places (`src/lib/frontier/roles.ts`, `auth-worker/src/types.ts`,
  `sync-worker/src/events/role-policy.ts`, `src/lib/sync/role-policy.ts`).
- **AD-12 max-wins resolution** over direct membership, group grants, org-wide oversight
  (≥600 only), creator fallback, platform admin (`auth-worker/src/services/project-permissions.ts:122-214`).
- **Subtractive lane/file member scopes** minted into the sync token and enforced per event
  (`sync-worker/src/events/authorize.ts:243-252`).
- **Both agents act as a real user at their live role.** In-app: session JWT + per-run role
  resolution + three-layer gating (role-filtered prompt card → stage-time floor check →
  apply-time + ingest re-authorization). External: PAT never carries a role; live role
  re-resolved per call, commands re-checked at apply, events replayed through the same
  `/events` perimeter as human writes (`sync-worker/src/external/token-bridge.ts:62-101`),
  with permission-parity tests (`sync-worker/src/__tests__/external-permission-parity.test.ts`).
- **Risk tiers already sketched**: the proposal-card registry distinguishes "prepared" kinds
  (accept-all-able) from "testimony" kinds (per-item human click, exempt from any future
  auto-apply — `src/components/agent/cards/registry.ts:20-37`). Ask-mode changeset approval is
  identity-based (only the credential-owning human), orthogonal to roles.

**UI-only gates to backstop before agent expansion** (found by the audit):

| Gate | Today | Fix when agentized |
|---|---|---|
| Client-side export formats (everything except USFM/zip) | affordance-gated only; unset org floor treated as "no gate" client-side vs 600 server default (`sync-worker/src/events/export-floor.ts:10-14`, `src/hooks/useOrgSettings.ts:229-237`) | export becomes a server command honoring `exportMinRole` for all formats |
| Lane switcher (≥600) | client-only (`src/lib/sync/role-policy.ts:144-160`) | irrelevant if agent writes carry explicit `laneId` (server validates lanes already) |
| Bulk repin ≥500 | UI gate only; per-event floor is 300 | encode bulk floor in the command, not the panel |
| `UpdateProjectSettings` (external) | whole-blob replace at 600 — can rewrite `agentMemoryAutonomy`, `validationRoleFloor`, rules, terminology in one shot (`sync-worker/src/external/commands.ts:73-78`) | replace with field-scoped settings commands with per-key floors (§6.2) |

---

## 3. What each surface can do today

### 3.1 In-app agent — 15 tools (`auth-worker/src/routes/agent.ts:149-384`)

| Tool | R/W | What it does |
|---|---|---|
| `read` | R | Aligned source/target rows by file/ref/filter (untranslated/stale/flagged/validated/drafted), ≤200 rows, alias-compressed |
| `search` | R | FTS over cells + comments + termbase |
| `examples` | R | Validated-only translation pairs, similarity-ranked (few-shot fuel) |
| `sql` | R | Guarded single-SELECT escape hatch: project-scoped, read-only txn, 4s/200-row caps, RLS backstop |
| `docs` | R | Cookbooks: drafting, checking, terminology, validation, history, assignments, files-and-refs, aquifer, brief |
| `read_memory` | R | Approved agent-memory index + full docs |
| `aquifer` | R+W | Scholarly-resource search/read; `publish` stages a Q&A (feature-gated per project) |
| `draft` | W(stage) | Two-pass grounded drafting; stages `target.cell.commit`s; **caps at 10 cells/call** (schema text says 20/50 — drift, `src/…/tools/draft.ts:55-56`) |
| `propose` | W(stage) | Stage arbitrary role-allowed events — but see the apply gap |
| `propose_memory` / `propose_brief_update` | W(stage) | Memory/brief proposals (blocked while untrusted content in scope) |
| `run_code` / `load_artifact` / `read_sandbox_file` | R | Per-run container, no network, no secrets; artifact → sandbox → analysis |
| `execute` | — | Deprecated v1 shim |

Acts as the signed-in user; 12 write-iterations / 30 rounds / 100k tokens / ~500¢ per run; org
credit rails. Human applies via ProposalCard / Workbench working set (accept / edit-then-accept /
reject / accept-all for prepared tier / undo via compensating commits). **Appliable kinds: only**
`target.cell.commit`, `source.cell.create`, `target.cell.create`, `comment.create`,
`cell.validate` (`src/lib/agent/role-floors.ts:32-44`). Everything else stages as un-appliable JSON.

### 3.2 External Agent API — 13 MCP tools / 5 commands (`sync-worker/src/external/`)

Reads: `get_capabilities`, `get_identity_and_scope`, `list_projects`, `get_project`,
`search_project` (300 req/15min), `read_content` (delta + lane filters), `read_history`,
`get_changeset`, plus REST artifact upload (25MB) / inspect / server-side parse of text formats.

Writes — five command kinds, all through the changeset engine (prepare → digest → ask-mode human
approval on `/approve/:id` → idempotent commit with receipts + provenance, 1h TTL):

| Command | Floor | Notes |
|---|---|---|
| `SetTranslation` (batch) | 400 | compiles to `target.cell.commit`; lane-aware |
| `PlanImport` (≤5000 cells) | 500 | `file.create` + `source.cell.create`; text formats server-parseable, DOM formats (docx/pptx/idml/usx…) not |
| `CreateProject` | org 600 | forced ask-mode always |
| `UpdateProjectSettings` | 600 | whole-blob + version guard (see §2 fix) |
| `LinkMedia` | 400 | attach uploaded audio artifact to a cell |

PAT model: `aqk_` tokens minted in Preferences → API tokens; ask|act modes (act requires ≥600 on
scope); project/org/unscoped; live-role re-resolution per call. **No undo post-commit, no jobs,
no webhooks, no changeset/artifact listing, no memory access.** Discovery is genuinely good:
unauthenticated API map, teaching 401/404/405s, `/me` bootstrap, `get_capabilities` publishing
live limits (`sync-worker/src/external/discovery-route.ts`).

### 3.3 What humans can do (condensed)

**Operators** (~30 client-emitted event kinds + flows, see §4 rows): edit/commit target cells
(TipTap, chained, staleness-pinned, lane-scoped), per-cell + paragraph + translate-as-read AI
drafts (auto-commit, no review step), validate/unvalidate (incl. batch, minus AI-drafted cells),
waive/unwaive rule violations, back-translation generate/edit, footnotes, comments
(threads/mentions/resolve/email), search & replace (drops validations by design), full audio
suite (record/upload/takes/TTS/clone/voice-together/transcribe/correct/denoise/diarize + batch
transcribe-all/synth-all), retime/timeline, repin upstream changes, file rename, target-side
import (400), client-side exports, history promote, outbox inspector.

**Managers** (~90 actions): org CRUD/members (700) /invites/teams/matrix/billing/credits/
provider keys/knowledge base/Monday; project create (600 into org), 19-screen import wizard
(500), DCS/Door43 link + catalog + delta + repair, source-project linking, member add/roles
(500/600), lane/file scopes (500), invite + access links, brief PUT + memory/brief proposal
review (500), rules + org rules + promotions (600), termbase manage (500 default) + publish/
subscribe (600), voices/cast, lanes add/archive (600), deadline/PM/lifecycle (600/500),
archive/delete (700), ~30-key settings blob (600), assignments create/unassign (500; reassign
has **no UI**), autopilot runs, harmonize sweep (**Apply is a stub** — `RulesPage.tsx:120`),
changeset approval, comment moderation (600), exports + org export floor (700), platform admin
console (allowlist + email-code sudo).

---

## 4. Capability matrix

✅ full · 🟡 partial (see note) · ❌ none · — not applicable by design.
"stage-only" = agent can stage the event but the review UI cannot apply it.

| # | Capability | Operator UI | Manager UI | In-app agent | API agent |
|---|---|---|---|---|---|
| **Observe** |
| 1 | Read cells/source/target/history | ✅ | ✅ | ✅ | ✅ |
| 2 | Search project (cells/comments/terms) | ✅ | ✅ | ✅ | 🟡 cells only, rate-limited |
| 3 | Progress / health / completion rollups | ✅ | ✅ | 🟡 via `sql` | ❌ |
| 4 | Knowledge base (org/project docs) | ✅ read | ✅ manage | ❌ no tool | ❌ |
| 5 | Usage / credits / billing view | — | ✅ | ❌ | ❌ |
| **Translate & edit** |
| 6 | Commit target cell text | ✅ | ✅ | ✅ staged→apply | ✅ SetTranslation |
| 7 | AI-draft cells | ✅ auto-commits, no review | ✅ | 🟡 staged + 10-cell cap | 🟡 agent-side gen + batch SetTranslation |
| 8 | Edit source text (≥500) | ✅ | ✅ | 🟡 stage-only | ❌ |
| 9 | Search & replace (bulk) | ✅ | ✅ | 🟡 manual per-cell proposals | 🟡 same |
| 10 | Harmonize/consistency sweep | 🟡 UI stub | 🟡 stub | ❌ | ❌ |
| 11 | Back-translation set | ✅ per-cell | ✅ | 🟡 stage-only | ❌ |
| **Review & QA** |
| 12 | Validate / unvalidate (testimony) | ✅ | ✅ | 🟡 stages queue; human clicks each — **by design** | ❌ |
| 13 | Waive / unwaive rule violations | ✅ | ✅ | 🟡 stage-only | ❌ |
| 14 | Run deterministic checks | ✅ client-side | ✅ | 🟡 stage-time lint only | ❌ |
| 15 | Repin / upstream-changes accept | ✅ | ✅ | 🟡 stage-only | ❌ |
| 16 | Audio QA sign-off (`cell.audio.validate`) | ❌ no UI! | ❌ | ❌ | ❌ |
| **Comments** |
| 17 | Create comment | ✅ | ✅ | ✅ staged→apply | ❌ |
| 18 | Edit / resolve / delete / moderate | ✅ | ✅ | 🟡 stage-only | ❌ |
| **Files, import, export** |
| 19 | Import source files | 🟡 target-side only | ✅ 19 formats | ❌ forbidden by prompt; file.create not appliable | 🟡 PlanImport (text formats) |
| 20 | File rename/delete/restore | ✅/🟡 | ✅ | 🟡 stage-only | ❌ |
| 21 | DCS/Door43 link, delta import, repair | — | ✅ | ❌ | ❌ |
| 22 | Export (16 formats) | ✅ | ✅ | ❌ | ❌ |
| **Audio** |
| 23 | Record/upload/manage takes | ✅ | ✅ | ❌ | 🟡 LinkMedia attach |
| 24 | TTS / clone / voice-together / denoise | ✅ | ✅ | ❌ | ❌ |
| 25 | Transcribe / diarize | ✅ | ✅ | ❌ | ❌ |
| **Configure (settings plane)** |
| 26 | Project settings (~30 keys) | — | ✅ | ❌ read-only | 🟡 whole-blob @600 |
| 27 | Rules (project + org) | — | ✅ | ❌ | 🟡 via blob |
| 28 | Termbase concept CRUD / share | 🟡 occurrence fixes | ✅ | 🟡 read + occurrence commits | 🟡 via blob |
| 29 | Brief edit / review proposals | — | ✅ | 🟡 propose-only | 🟡 via blob |
| 30 | Agent memory curation | — | ✅ review | 🟡 propose-only | ❌ |
| **Identity & orchestration plane** |
| 31 | Members add/roles/remove, scopes | — | ✅ | ❌ | ❌ |
| 32 | Invites / access links | — | ✅ (access links: no mint UI) | ❌ | ❌ |
| 33 | Assignments create/unassign/reassign | 🟡 self-assign | ✅ (reassign: no UI) | ❌ effectively (bypasses outbox) | ❌ |
| 34 | Teams / org membership / org settings | — | ✅ | ❌ | ❌ |
| 35 | Project lifecycle (create/deadline/PM/archive/delete) | — | ✅ | ❌ | 🟡 CreateProject only |
| 36 | Monday.com setup + sync | — | ✅ | ❌ | ❌ |
| 37 | Billing / plans / org policy floors / PATs / platform admin | — | ✅ | ❌ **keep** | ❌ **keep** |
| 38 | Approve changesets / proposals | — | ✅ human gate | — **keep human** | — **keep human** |

**Score**: in-app agent — full on 6 rows, partial on 15, absent on 15 (of 36 agent-eligible).
External — full on 3, partial on 9. The absences cluster precisely on planes (b) and (c) plus
audio/jobs.

---

## 5. Gap analysis

### 5.1 The five structural gaps

1. **Write-plane coverage** (§1). Event-log writes are half-reachable; settings-blob and
   identity-plane writes are unreachable in-app. No amount of prompt engineering fixes this —
   it needs command vocabulary.
2. **The apply gap.** `propose` can stage ~20 kinds; Apply supports 5
   (`src/lib/agent/role-floors.ts:32-44` vs `schema-card.ts:25-54`). The staged-changeset
   engine on the external side already solves apply correctly (server-side commit of compiled
   events with receipts) — the in-app path re-emits through the client outbox instead, which is
   why every new kind needs bespoke client apply code.
3. **Two parallel staging apparatuses.** In-app proposals (client outbox re-emission,
   user-authored events, per-run undo) vs external changesets (digest, idempotent commit,
   receipts, provenance, approval page, no undo). Two gates, two provenance stories, two
   review UIs to maintain.
4. **No job primitive.** Draft cap 10 cells/call and 12 write-iterations/run make book-scale
   work a babysitting exercise; audio batch runners are client-side loops; imports/exports are
   synchronous. The contextual-autopilot panel (start/pause/resume/stop, floor 400) is the
   seed of the right primitive.
5. **Read gaps are small but real**: no health-rollup/progress tool (SQL suffices but is
   awkward for the 80% case), no KB tool, no credits visibility, external has no SQL analog.

### 5.2 Top itemized gaps (from the matrix, priority-ordered)

1. Rows 26–29: settings/rules/termbase/brief — the PM configuration core.
2. Rows 31–33: members, scopes, invites, assignments — the PM staffing core (incl. the
   UI-less `assignment.reassign` and access-link minting, which an agent could cover with zero
   new UI).
3. Row 19: import — the single highest-friction setup flow (19 screens); external PlanImport
   + server parsers + sandbox already do 80% of the work.
4. Row 22: export — pure server render + floor check; trivially commandable.
5. Rows 12–15: QA loop completion (appliable waive/repin/BT; checks-as-command so the agent
   can run the same deterministic suite the "Check file" button runs).
6. Rows 23–25: audio production (batch transcribe/synth/denoise as jobs; LinkMedia parity
   in-app; the server-ready-but-unwired `cell.audio.validate`).
7. Row 10: harmonize — UI stub + agent-shaped job; wire once, both benefit.
8. Rows 3–5: read parity (progress/health rollup tool or cookbook'd SQL views; KB search tool;
   credits read for MAINTAINER+).

### 5.3 Efficiency gaps — tedious human loops that are natural agent jobs

From the operator/PM audits (each is a "need-to-click" pain today):

- **AI-draft review debt**: bulk validate deliberately excludes AI-drafted cells
  (`src/lib/review/review-eligibility.ts:7-20`) — reviewing a 500-cell drafted book is 500
  clicks. Agent job: pre-screen drafts against rules/health/exemplars, stage a validation
  queue of exceptions only.
- **Replace-all revalidation debt**: replace drops validations by design; agent can diff-check
  affected cells and stage re-validation candidates.
- **Cast labeling round-trip** (CSV export → hand-fill → re-import) — agent + diarization
  output + script does this in one changeset.
- **Per-cell BT, per-cell repin (<500), comment triage, per-(cell,rule) waivers, legacy audio
  measure backfill, rename-suggestion application** — all batch-shaped.
- **PM onboarding pipeline**: create → import → configure → invite → assign spans 4+ surfaces
  and dozens of clicks; ideal playbook (§6.6).
- **DCS upkeep sweep**: check release → review delta → import → repin stale — a scheduled
  agent job with one review gate.

### 5.4 Safety asymmetries to fix while expanding

- Field-scope `UpdateProjectSettings`; move `agentMemoryAutonomy`, `validationRoleFloor`,
  `harmonize_min_role`, org policy floors into a **policy tier** no agent path can write.
- Server-enforce export floors for all formats once export is agent-reachable.
- Keep testimony tier human-per-item (validate, audio-validate, changeset/proposal approval);
  keep identity-based approval (no self-approval; approver = credential owner).
- Note the UI/agent asymmetry worth *keeping* pointed the other way: the UI's own AI-draft
  button auto-commits at 400 with no review, while agent drafts stage. That precedent argues
  for an **auto-apply tier for `ai_draft`-tagged commits** (they reset validation state and
  are already provenance-tagged) — parity with what humans can already unleash, still short of
  testimony.

---

## 6. Target architecture: everything reachable, context stays small

### 6.1 What the leaders converge on (research summary)

Claude Code (~a dozen core tools), Codex CLI (essentially exec + apply_patch + plan), and
Cursor (~9 tool groups) all ship **few generic composable verbs**, not one-tool-per-feature.
Long-tail capability rides on: skills/rules whose *names+descriptions* are ambient but whose
bodies load on demand; deferred tool loading (Anthropic: definitions beyond ~10 tools/10k
tokens should defer; measured accuracy degrades past ~30–50 resident tools; tool-search cut
77k→8.7k definition tokens and *raised* MCP eval accuracy); subagents for context isolation;
and an exec escape hatch. Writes are gated by **policy engines outside the model**
(permission modes / sandbox+approval / allowlist+classifier), reads are free. Sources in §8.

Aquilla's analogs already exist: `docs` cookbooks (skills), `get_capabilities` + teaching
errors (discovery), guarded `sql` (read escape hatch), changeset gate (permission mode),
sandbox (exec), role-filtered prompt card (ambient context). The architecture below is an
extension, not an invention.

### 6.2 One spine: the command registry

Promote the external changeset command pattern to the app-wide write vocabulary. Each
**command** = typed params + role floor + risk tier + display/diff renderer + undo strategy +
one-line description, registered once, server-side:

- **Plane (a)** — `EmitEvents` generalizes SetTranslation: any batch of role-allowed event
  kinds (the in-app `propose` semantics, but committed server-side like external changesets).
- **Plane (b)** — field-scoped settings commands with per-key floors: `PatchSettings{keyPath,
  value, ifMatchVersion}` plus named commands for hot paths (`UpsertRule`, `UpsertTermConcept`,
  `SetBrief`, `AddLane`, `SetDeadline`, `SetLifecycle`). Whole-blob replace is deleted.
- **Plane (c)** — identity commands: `AddMember`, `SetMemberRole`, `SetMemberScopes`,
  `CreateInvite`, `AssignWork`, `ReassignWork`, `UnassignWork`, `PublishTermbase`,
  `SubscribeTermbase`, `LinkSourceProject`…
- **Ops** — job-starting commands: `RunImport(artifactId,…)`, `RunExport(format,…)`,
  `RunChecks(scope)`, `RunBatchDraft`, `RunBatchBacktranslate`, `RunTts`, `RunTranscribe`,
  `RunDiarize`, `RunHarmonize`, `RunDcsDeltaSync`.

One registry then drives **everything**: in-app proposal cards (generic renderer from the
command's display spec — the apply gap disappears because commit happens server-side exactly
like external changesets), the external MCP surface (commands exposed 1:1), role-filtered
discovery, docs, and the permission-parity test suite. In-app and external staging converge on
the changeset engine; the `/approve/:id` page and the workbench working-set become two skins of
the same review surface; receipts/provenance/undo get one implementation. (Undo generalizes
the current compensating-commit pattern: each command declares its inverse or "irreversible".)

### 6.3 The context-cache tiering (why this never bloats)

- **L1 — ~10 resident tools, frozen.** `read`, `search`, `examples`, `sql` (in-app), `docs`,
  `draft`, `propose` (stages *any* registered command), `status` (run/job/changeset state),
  memory read/propose, sandbox trio (in-app). External mirrors minus sql/sandbox. **Adding a
  capability never adds a tool** — it adds a registry entry. Keep resident definitions under
  ~10k tokens; keep investing in L1 output compression (alias tables, verdict lines) and
  consequence-reporting (the stage-time lint that feeds `NEEDS REVIEW` lines back is exactly
  right — extend it to every command's diff).
- **L2 — role-filtered, on-demand capability card.** The schema card already filters event
  kinds by role so a VIEWER never sees commit kinds; do the same for commands: the prompt
  carries only command *names grouped by domain* (one line each); `docs("commands/import")`
  or `describe_command("RunExport")` fetches full params + gotchas + a worked example on
  demand. This is MCP tool-search / SKILL.md semantics applied to commands. Cookbooks stay the
  place for multi-step recipes.
- **L3 — escape hatches.** Reads: guarded `sql` (exists; add cookbook'd views for
  progress/health so the 80% case doesn't hand-write joins). Writes: `EmitEvents` +
  `PatchSettings` reach anything not yet promoted to a named command — the agent is never
  stuck, just slower and more heavily reviewed. Compute: the sandbox. External keeps
  commands-only (no raw API tool) — safety over ergonomics there is correct.

### 6.4 Autonomy ladder (policy, not prompt)

Per-command **risk tiers**, enforced server-side; project/org settings choose the mode:

| Tier | Examples | suggest (default) | auto-apply | act (external) |
|---|---|---|---|---|
| prepared | target commits, drafts, BT, waives, file rename, comment create | stage → human applies | ✅ allowed when enabled (start with `ai_draft` commits — human parity, §5.4) | ✅ ≥600-scoped act PATs |
| structural | import, settings patches, rules/termbase, members/scopes/assignments, export | stage → human applies | ❌ | forced ask unless explicitly whitelisted per command |
| testimony | validate, audio-validate, memory/brief approval, changeset approval | human per-item, always | never | never |
| destructive/governance | archive/delete, org floors, billing, PATs, platform admin | not agent-reachable | never | never |

This is the Claude Code permission-mode spectrum (plan → acceptEdits → allowlist) mapped onto
Aquilla's existing gates — the changeset digest/approval flow already implements "ask"; the
registry's prepared/testimony split already anticipates auto-apply.

### 6.5 Jobs

One server-side job primitive (start/status/pause/resume/cancel + progress events streamed as
agent frames and DO broadcasts) behind the `Run*` commands. Fixes at once: the 10-cell draft
cap, batch BT/TTS/transcribe, diarize, big imports/exports, harmonize sweeps, DCS delta syncs
— and gives the external surface its missing async story (job status via `status`, webhooks
later). Build it where autopilot already lives.

### 6.6 Playbooks (skills for the app domain)

Parameterized L2 recipes for multi-surface journeys, each ending in one reviewable changeset
per logical decision: **project-bootstrap** (create → import → lanes → rules → termbase seed →
brief → invites → assignments), **dcs-sync-sweep**, **qa-sweep** (checks → triage → staged
fixes + validation queue), **cast-labeling**, **release-export**. Named/versioned in the repo
like `docs` topics; surfaced as slash commands in the composer (`/setup`, `/qa`, …) alongside
the existing `/draft /check /find /status`.

### 6.7 Explicit non-goals (keep the agent out)

Billing/checkout, org policy floors, PAT mint/revoke, platform admin, changeset/proposal
self-approval, foreign unvalidate, hard deletes. These stay human-only regardless of tier —
enumerate them in the registry as `agentReachable: false` so the exclusion is code, not vibes.

---

## 7. Roadmap

**P0 — converge the spine (unblocks everything else)**
1. Registry module in sync-worker: command defs = params schema + floor + tier + display +
   inverse; port the 5 external commands onto it; add `EmitEvents`.
2. In-app agent stages **commands** (prepare) instead of client-side proposals; workbench
   working-set + ProposalCard render from server display specs; commit server-side (external
   commit path). Legacy apply path retired. Undo = inverse commands.
3. Replace `UpdateProjectSettings` with `PatchSettings` + per-key floors; carve out the policy
   tier. Fix the `draft` schema-text/implementation cap drift (10 vs 20/50).
4. Role-filtered command index in the prompt (names only) + `describe_command`/docs-on-demand.

**P1 — PM parity (highest-leverage new commands)**
Members/scopes/invites/assignments (incl. `ReassignWork` — capability exists today with no
UI), `RunImport` (artifact + server parsers + sandbox for DOM formats), `RunExport` (floors
server-side), rules/termbase/brief commands, `SetDeadline`/`SetLifecycle`, `RunChecks`
(deterministic-check as a command), project-bootstrap playbook.

**P2 — operator throughput**
Jobs primitive (fold autopilot in); `RunBatchDraft`/`RunBatchBacktranslate`/`RunTts`/
`RunTranscribe`/`RunDiarize`/`RunHarmonize` (wire the FixReviewPanel stub); AI-draft
pre-screen queue; bulk waive; comment triage; cast-labeling playbook; audio-validate surfaced
(agent stages, reviewer clicks); KB + progress/health read tools; auto-apply tier for
`ai_draft` commits behind a project setting.

**P3 — external + ecosystem**
Expose the full registry over MCP with deferred schemas (names in `tools/list`, bodies via
`describe_command` — the tool-search pattern); job status + webhooks; changeset/artifact
listing; consider scoped memory read for external agents; agent-runs ledger dashboard for PMs
(`GET /api/v1/ai/agent/runs` exists today with **no SPA consumer**).

**Success criteria**: every matrix row ≥🟡 for the in-app agent except §6.7 exclusions; tool
count still ≤ ~12; resident tool+command-index tokens ≤ ~10k; permission-parity tests green
across both surfaces; zero client-only gates on agent-reachable writes.

---

## 8. Sources (industry research)

- Anthropic: tools reference, permission modes, MCP tool search (77k→8.7k tokens; accuracy
  gains), skills, "Writing tools for agents", "Advanced tool use" (degradation past ~30–50
  tools), "Code execution with MCP" (98.7% token cut) — code.claude.com/docs,
  anthropic.com/engineering.
- OpenAI Codex: exec+apply_patch core, sandbox × approval-policy matrix, AGENTS.md, skills —
  github.com/openai/codex, developers.openai.com/codex/security.
- Cursor: ~9 tool groups, apply-model split, .cursor/rules four disclosure modes, run modes
  (allowlist → OS sandbox → classifier) — cursor.com/docs.

*Detailed per-surface inventories (file:line-cited) live in the four audit reports this
document synthesizes; regenerate or extend them against the tree as the code moves.*
