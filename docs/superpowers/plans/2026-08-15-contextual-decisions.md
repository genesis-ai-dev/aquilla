# Contextual Decisions (agent → user channel) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give autopilot a way to ask the user a question it cannot answer alone, and to stop asking once the question answers itself.

**Architecture:** A new `contextual_decisions` table plus a shared data module in `db/shared/`, following the same guarded-UPDATE discipline as `contextual-runs.ts`. A run that raises a blocking decision moves to a new `waiting` status; it leaves `waiting` when the decision is answered *or* when a deterministic supersession sweep finds the underlying readiness gap already filled. Surfacing is capped and ranked read-side, so the user sees a few well-argued questions rather than a queue.

**Tech Stack:** TypeScript, Hono (auth-worker), Postgres via `db/shim/postgres.ts` (Hyperdrive), Vitest with `cloudflare:test` (real Postgres in worker tests), React 19 + Tailwind v4 + shadcn/ui.

**Spec:** [`docs/superpowers/specs/2026-08-15-agent-onboarding-seam-design.md`](../specs/2026-08-15-agent-onboarding-seam-design.md) — implements sequencing step 1 (§9). Read §4.3 (Decision), §4.5 (run status machine), and §4.6 (surfacing policy) before starting.

## Global Constraints

- **TypeScript, no `any`.** Project rule (`CLAUDE.md` → Code style).
- **Target files under ~500 lines.**
- **Worker tests run per-package:** `cd auth-worker && npm test`. The root `pnpm test` **excludes** all worker packages. Tests touching `db/shared/*` from the worker live in `auth-worker/src/__tests__/`.
- **Every status transition is a guarded UPDATE** (`WHERE id = ? AND status IN (…)`), returning `{status:"ok", …}` / `{status:"invalid_state"}` / `{status:"not_found"}`. Two racing writers must never both win. This is the house convention in `db/shared/contextual-runs.ts`.
- **Schema changes go in BOTH** `db/postgres/schema.sql` and a new numbered file in `db/postgres/migrations/`. `scripts/check-schema-migrations.ts` fails the build otherwise.
- **Migrations are NOT auto-applied to Neon.** Each migration file carries the by-hand apply command in its header comment.
- **Ids are uuidv7** (time-ordered; stores compare lexicographically). `db/shared/contextual-runs.ts:237` has a local `uuidv7()` — the new module gets its own copy of that same helper rather than exporting it across modules.
- **`waiting` must NEVER be added to the `claimStrandedRuns` predicate** (`db/shared/contextual-runs.ts:1726`). A blocked run that gets adopted is re-ticked forever. Task 5 has the regression test.
- **Surfacing cap starts at 3** (`OPEN_DECISION_SURFACE_CAP`). Spec §11 open question 1 — deliberately low, raised only on evidence.
- **Commit after every task.** The commit hook warns when no `AQU-###` appears in the message or branch; include one if the work has a ticket.

---

## File Structure

**Create:**
- `db/postgres/migrations/0076_contextual_decisions.sql` — table, `waiting` status, indexes
- `db/shared/contextual-decisions.ts` — types, raise/read, guarded transitions, supersession/expiry writes
- `auth-worker/src/lib/contextual/supersede.ts` — the **pure** supersession predicate (no DB, no HTTP)
- `auth-worker/src/routes/contextual-decisions.ts` — HTTP surface
- `auth-worker/src/__tests__/contextual-decisions.test.ts` — data layer + transitions
- `auth-worker/src/__tests__/contextual-supersede.test.ts` — pure predicate
- `auth-worker/src/__tests__/contextual-decisions-routes.test.ts` — routes
- `src/components/contextual/DecisionCard.tsx` — one decision, its reason, its actions
- `src/components/contextual/DecisionCard.test.tsx`

**Modify:**
- `db/postgres/schema.sql` — mirror the migration
- `db/shared/contextual-runs.ts` — `waiting` in `ContextualRunStatus` + `ACTIVE_STATUSES`; `blockRunOnDecision` / `unblockRun`
- `auth-worker/src/lib/contextual/readiness.ts` — export `MIN_EXAMPLES` and `MIN_BRIEF_FIELDS`
- `auth-worker/src/index.ts` — mount the new route module
- `src/lib/contextual/transport.ts` — client fetch/act helpers
- `src/components/contextual/AutopilotActivityInspector.tsx` — render the decisions region
- `src/lib/i18n/namespaces/autopilot.ts` — new keys

**Why this split:** the pure predicate lives apart from the data module so supersession logic unit-tests with plain values and no database. Routes stay separate from `contextual.ts`, which is already ~1200 lines.

---

### Task 1: Schema — `contextual_decisions` and the `waiting` status

**Files:**
- Create: `db/postgres/migrations/0076_contextual_decisions.sql`
- Modify: `db/postgres/schema.sql` (append beside the contextual block, ~line 1200)

**Interfaces:**
- Consumes: nothing
- Produces: table `contextual_decisions`; `contextual_runs.status` accepts `'waiting'`; `contextual_runs.blocked_on_decision_id`

- [ ] **Step 1: Write the migration**

Create `db/postgres/migrations/0076_contextual_decisions.sql`:

```sql
-- 0076: contextual decisions — the agent → user channel (seam design §4.3).
--
-- A decision is a question autopilot cannot answer alone. It closes exactly
-- two ways (a human answers, or the agent researches it into a memory
-- proposal); routing only ASSIGNS it and leaves it open. Two further terminal
-- states are bookkeeping, and are deliberately distinct: `superseded` means the
-- underlying gap got filled by other means (healthy), `expired` means nobody
-- ever answered (unhealthy). Merging them would let the healthy case hide the
-- warning the unhealthy one exists to give.
--
-- NOT applied automatically to live Neon branches. Apply by hand:
--   set -a; . ./.env; set +a
--   npx tsx scripts/pg.ts db/postgres/migrations/0076_contextual_decisions.sql

CREATE TABLE IF NOT EXISTS contextual_decisions (
  id text PRIMARY KEY,                  -- uuidv7
  project_id text NOT NULL,
  run_id text,                          -- NULL once the owning run ends
  file_id text NOT NULL,
  span_id text,
  cell_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- WHY the agent cannot proceed, in the user's words. Never "review this".
  reason text NOT NULL,
  -- Which readiness item this gap belongs to; NULL for free-text ambiguities,
  -- which the deterministic sweep can never close.
  readiness_item text
    CHECK (readiness_item IS NULL OR
           readiness_item IN ('terminology','brief','examples','rules','languages')),
  -- Set only for terminology decisions: the concept whose rendering is missing.
  concept_id text,
  -- How many later passages the answer affects. Drives surfacing rank (§4.6)
  -- and belongs in the reason text too, because it is what makes a card
  -- answerable.
  blast_radius integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','researching','resolved','dismissed','superseded','expired')),
  -- Routing is an ASSIGNMENT, not a resolution: an assigned decision is still
  -- `open`, and anyone who joins later can answer it.
  assigned_user_id integer,
  assigned_invite_id text,
  resolution jsonb,                     -- {kind:'answered'|'researched', …}
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

-- Surfacing reads the open set per project, ranked by blast radius then age.
CREATE INDEX IF NOT EXISTS contextual_decisions_open
  ON contextual_decisions(project_id, blast_radius DESC, created_at ASC)
  WHERE status IN ('open','researching');

-- The supersession sweep and the run-unblock path both look up by run.
CREATE INDEX IF NOT EXISTS contextual_decisions_run
  ON contextual_decisions(run_id)
  WHERE status IN ('open','researching');

-- `waiting` = something left to do, but it needs a human. Distinct from
-- `parked` (nothing left to do). A waiting run is ACTIVE, so it participates
-- in the one-active-run-per-lane unique index below.
ALTER TABLE contextual_runs DROP CONSTRAINT IF EXISTS contextual_runs_status_check;
ALTER TABLE contextual_runs ADD CONSTRAINT contextual_runs_status_check
  CHECK (status IN ('running','pausing','paused','parked','waiting','done','failed','terminated'));

ALTER TABLE contextual_runs
  ADD COLUMN IF NOT EXISTS blocked_on_decision_id text;

DROP INDEX IF EXISTS contextual_runs_active;
CREATE UNIQUE INDEX IF NOT EXISTS contextual_runs_active
  ON contextual_runs(project_id, file_id, target_lang)
  WHERE status IN ('running','pausing','paused','parked','waiting');
```

- [ ] **Step 2: Mirror it into `schema.sql`**

Append the same `CREATE TABLE contextual_decisions`, both `CREATE INDEX` statements, and the `blocked_on_decision_id` column to `db/postgres/schema.sql` immediately after the existing contextual block. Update the inline `contextual_runs.status` CHECK and the `contextual_runs_active` index there to include `'waiting'`. `schema.sql` declares the live schema directly (no `ALTER`), so write the final state, not the diff.

- [ ] **Step 3: Verify schema and migrations agree**

Run: `npx tsx scripts/check-schema-migrations.ts`
Expected: PASS, and the table count in its output goes up by one.

- [ ] **Step 4: Commit**

```bash
git add db/postgres/migrations/0076_contextual_decisions.sql db/postgres/schema.sql
git commit -m "feat(db): contextual_decisions table and waiting run status"
```

---

### Task 2: Data layer — raise and read decisions

**Files:**
- Create: `db/shared/contextual-decisions.ts`
- Test: `auth-worker/src/__tests__/contextual-decisions.test.ts`

**Interfaces:**
- Consumes: Task 1's table; `AquillaDb` from `db/shim/postgres`
- Produces:
  - `type DecisionStatus = "open" | "researching" | "resolved" | "dismissed" | "superseded" | "expired"`
  - `type DecisionReadinessItem = "terminology" | "brief" | "examples" | "rules" | "languages"`
  - `type DecisionResolution = { kind: "answered"; answer: string; byUserId: number } | { kind: "researched"; memoryProposalId: string }`
  - `interface ContextualDecision`
  - `raiseDecision(db, input: RaiseDecisionInput): Promise<ContextualDecision>`
  - `getDecision(db, id): Promise<ContextualDecision | null>`
  - `listOpenDecisions(db, projectId, limit): Promise<ContextualDecision[]>`
  - `countOpenDecisions(db, projectId): Promise<number>`
  - `const OPEN_DECISION_SURFACE_CAP = 3`
  - `const DECISION_REASON_MAX_BYTES = 2000`

- [ ] **Step 1: Write the failing test**

Create `auth-worker/src/__tests__/contextual-decisions.test.ts`:

```ts
// Contextual decisions (db/shared/contextual-decisions.ts, seam design §4.3).
// WHY these tests: the decision channel is only trustworthy if (1) surfacing is
// ranked by blast radius so the ONE question worth interrupting for is the one
// shown, and (2) a reason can never be silently truncated into nonsense — a
// card whose reason is cut mid-sentence is worse than no card.

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import {
  raiseDecision,
  getDecision,
  listOpenDecisions,
  countOpenDecisions,
  DECISION_REASON_MAX_BYTES,
} from "../../../db/shared/contextual-decisions"

const db = env.AQUILLA_PG

function seed(overrides: Partial<Parameters<typeof raiseDecision>[1]> = {}) {
  return raiseDecision(db, {
    projectId: "proj-dec",
    runId: "run-1",
    fileId: "file-1",
    spanId: "span-1",
    cellIds: ["c1", "c2"],
    reason: "Two prior renderings of this name conflict.",
    readinessItem: "terminology",
    conceptId: "concept-1",
    blastRadius: 6,
    ...overrides,
  })
}

describe("raiseDecision", () => {
  it("persists a decision as open with no resolution", async () => {
    const d = await seed()
    expect(d.status).toBe("open")
    expect(d.resolution).toBeNull()
    expect(d.blastRadius).toBe(6)
    expect(d.cellIds).toEqual(["c1", "c2"])

    const read = await getDecision(db, d.id)
    expect(read?.id).toBe(d.id)
  })

  it("rejects an empty reason rather than surfacing a blank card", async () => {
    await expect(seed({ reason: "   " })).rejects.toThrow(/reason/i)
  })

  it("rejects an over-long reason instead of truncating it mid-sentence", async () => {
    const long = "x".repeat(DECISION_REASON_MAX_BYTES + 1)
    await expect(seed({ reason: long })).rejects.toThrow(/reason/i)
  })
})

describe("listOpenDecisions", () => {
  it("ranks by blast radius, then oldest first, and honours the limit", async () => {
    const project = `proj-rank-${Date.now()}`
    const small = await seed({ projectId: project, blastRadius: 1, reason: "small" })
    const big = await seed({ projectId: project, blastRadius: 40, reason: "big" })
    const mid = await seed({ projectId: project, blastRadius: 10, reason: "mid" })

    const all = await listOpenDecisions(db, project, 10)
    expect(all.map((d) => d.id)).toEqual([big.id, mid.id, small.id])

    const capped = await listOpenDecisions(db, project, 2)
    expect(capped.map((d) => d.id)).toEqual([big.id, mid.id])

    // The held one is still open — it just isn't surfaced (§4.6).
    expect(await countOpenDecisions(db, project)).toBe(3)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd auth-worker && npx vitest run src/__tests__/contextual-decisions.test.ts`
Expected: FAIL — cannot resolve `../../../db/shared/contextual-decisions`.

- [ ] **Step 3: Write the module**

Create `db/shared/contextual-decisions.ts`:

```ts
// Contextual decisions — the agent → user channel (seam design §4.3).
//
// Lives in db/shared/ beside contextual-runs.ts so the routes AND the tick
// executor apply the SAME validation and parameterized SQL. Identity and
// authorization stay in the caller; this module never touches HTTP.
//
// Two invariants carry the design:
//   1. Routing is an ASSIGNMENT. An assigned decision is still `open`, so a
//      queue of unanswered questions can never report as handled work.
//   2. `superseded` and `expired` are distinct terminal states. Supersession is
//      the system working; expiry is the system stalling.

import type { AquillaDb } from "../shim/postgres"

export type DecisionStatus =
  | "open"
  | "researching"
  | "resolved"
  | "dismissed"
  | "superseded"
  | "expired"

export type DecisionReadinessItem =
  | "terminology"
  | "brief"
  | "examples"
  | "rules"
  | "languages"

export type DecisionResolution =
  | { kind: "answered"; answer: string; byUserId: number }
  | { kind: "researched"; memoryProposalId: string }

export interface ContextualDecision {
  id: string
  projectId: string
  runId: string | null
  fileId: string
  spanId: string | null
  cellIds: string[]
  reason: string
  readinessItem: DecisionReadinessItem | null
  conceptId: string | null
  blastRadius: number
  status: DecisionStatus
  assignedUserId: number | null
  assignedInviteId: string | null
  resolution: DecisionResolution | null
  createdAt: string
  updatedAt: string
  resolvedAt: string | null
}

export interface RaiseDecisionInput {
  projectId: string
  runId: string | null
  fileId: string
  spanId?: string | null
  cellIds?: string[]
  reason: string
  readinessItem?: DecisionReadinessItem | null
  conceptId?: string | null
  blastRadius?: number
}

/** How many open decisions a project surfaces at once (§4.6). Deliberately
 *  low: a supervisor allowed three open questions behaves very differently
 *  from one allowed thirty. Surplus stays open but unsurfaced — and is very
 *  likely to be superseded before anyone would have reached it. */
export const OPEN_DECISION_SURFACE_CAP = 3

/** A reason longer than this is not a question, it is a report. Reject rather
 *  than truncate: a card cut mid-sentence is worse than no card. */
export const DECISION_REASON_MAX_BYTES = 2000

const DECISION_COLS = `id, project_id, run_id, file_id, span_id, cell_ids, reason,
  readiness_item, concept_id, blast_radius, status, assigned_user_id,
  assigned_invite_id, resolution, created_at, updated_at, resolved_at`

/** uuidv7 — time-ordered, so lexicographic id order is creation order.
 *  Deliberately duplicated from contextual-runs.ts rather than cross-imported;
 *  these modules stay independently loadable. */
function uuidv7(): string {
  const ms = BigInt(Date.now())
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  for (let i = 5; i >= 0; i--) {
    bytes[i] = Number((ms >> BigInt((5 - i) * 8)) & 0xffn)
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

interface DecisionRow {
  id: string
  project_id: string
  run_id: string | null
  file_id: string
  span_id: string | null
  cell_ids: unknown
  reason: string
  readiness_item: string | null
  concept_id: string | null
  blast_radius: number
  status: string
  assigned_user_id: number | null
  assigned_invite_id: string | null
  resolution: unknown
  created_at: unknown
  updated_at: unknown
  resolved_at: unknown
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T
    } catch {
      return fallback
    }
  }
  return value as T
}

/** PGlite (tests) returns timestamptz as a Date; postgres.js (production)
 *  returns a string. Normalize so the declared `string` type is not a lie.
 *  Duplicated from contextual-runs.ts:257 on purpose, same as uuidv7. */
function toIso(v: unknown): string {
  if (v == null) return ""
  if (v instanceof Date) return v.toISOString()
  return new Date(v as string).toISOString()
}

function mapRow(row: DecisionRow): ContextualDecision {
  return {
    id: row.id,
    projectId: row.project_id,
    runId: row.run_id,
    fileId: row.file_id,
    spanId: row.span_id,
    cellIds: parseJson<string[]>(row.cell_ids, []),
    reason: row.reason,
    readinessItem: (row.readiness_item as DecisionReadinessItem | null) ?? null,
    conceptId: row.concept_id,
    blastRadius: row.blast_radius,
    status: row.status as DecisionStatus,
    assignedUserId: row.assigned_user_id,
    assignedInviteId: row.assigned_invite_id,
    resolution: parseJson<DecisionResolution | null>(row.resolution, null),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    // Nullable on purpose: callers distinguish "not resolved" from
    // "resolved at an unknown time", so this must not collapse to "".
    resolvedAt: row.resolved_at == null ? null : toIso(row.resolved_at),
  }
}

export async function raiseDecision(
  db: AquillaDb,
  input: RaiseDecisionInput,
): Promise<ContextualDecision> {
  const reason = input.reason.trim()
  if (!reason) throw new Error("decision reason is required")
  if (new TextEncoder().encode(reason).length > DECISION_REASON_MAX_BYTES) {
    throw new Error(`decision reason exceeds ${DECISION_REASON_MAX_BYTES} bytes`)
  }
  const row = await db
    .prepare(
      `INSERT INTO contextual_decisions
          (id, project_id, run_id, file_id, span_id, cell_ids, reason,
           readiness_item, concept_id, blast_radius)
       VALUES (?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?)
       RETURNING ${DECISION_COLS}`,
    )
    .bind(
      uuidv7(),
      input.projectId,
      input.runId,
      input.fileId,
      input.spanId ?? null,
      // NOT JSON.stringify — see the jsonb note on answerDecision in Task 3.
      input.cellIds ?? [],
      reason,
      input.readinessItem ?? null,
      input.conceptId ?? null,
      input.blastRadius ?? 0,
    )
    .first<DecisionRow>()
  if (!row) throw new Error("failed to raise decision")
  return mapRow(row)
}

export async function getDecision(
  db: AquillaDb,
  id: string,
): Promise<ContextualDecision | null> {
  const row = await db
    .prepare(`SELECT ${DECISION_COLS} FROM contextual_decisions WHERE id = ?`)
    .bind(id)
    .first<DecisionRow>()
  return row ? mapRow(row) : null
}

/** Ranked by blast radius, then oldest first (§4.6). Rows beyond `limit` stay
 *  open — they are held, not closed. */
export async function listOpenDecisions(
  db: AquillaDb,
  projectId: string,
  limit: number = OPEN_DECISION_SURFACE_CAP,
): Promise<ContextualDecision[]> {
  const { results } = await db
    .prepare(
      `SELECT ${DECISION_COLS} FROM contextual_decisions
        WHERE project_id = ? AND status IN ('open','researching')
        ORDER BY blast_radius DESC, created_at ASC
        LIMIT ?`,
    )
    .bind(projectId, limit)
    .all<DecisionRow>()
  return (results ?? []).map(mapRow)
}

export async function countOpenDecisions(
  db: AquillaDb,
  projectId: string,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT count(*)::int AS n FROM contextual_decisions
        WHERE project_id = ? AND status IN ('open','researching')`,
    )
    .bind(projectId)
    .first<{ n: number }>()
  return row?.n ?? 0
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd auth-worker && npx vitest run src/__tests__/contextual-decisions.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add db/shared/contextual-decisions.ts auth-worker/src/__tests__/contextual-decisions.test.ts
git commit -m "feat(decisions): raise and ranked-surface contextual decisions"
```

---

### Task 3: Data layer — guarded transitions

**Files:**
- Modify: `db/shared/contextual-decisions.ts`
- Test: `auth-worker/src/__tests__/contextual-decisions.test.ts`

**Interfaces:**
- Consumes: Task 2's `ContextualDecision`, `DecisionResolution`, `mapRow`, `DECISION_COLS`
- Produces:
  - `type DecisionTransition = { status: "ok"; decision: ContextualDecision } | { status: "invalid_state" } | { status: "not_found" }`
  - `answerDecision(db, id, answer: string, byUserId: number): Promise<DecisionTransition>`
  - `dismissDecision(db, id): Promise<DecisionTransition>`
  - `assignDecision(db, id, to: { userId?: number; inviteId?: string }): Promise<DecisionTransition>`
  - `supersedeDecisions(db, ids: string[]): Promise<number>`
  - `expireDecisionsOlderThan(db, projectId, cutoffIso: string): Promise<number>`

- [ ] **Step 1: Write the failing test**

Append to `auth-worker/src/__tests__/contextual-decisions.test.ts` (keep the existing `seed` helper and imports; extend the import list):

```ts
import {
  answerDecision,
  dismissDecision,
  assignDecision,
  supersedeDecisions,
  expireDecisionsOlderThan,
} from "../../../db/shared/contextual-decisions"

describe("decision transitions", () => {
  it("answering closes it and records who answered", async () => {
    const d = await seed()
    const t = await answerDecision(db, d.id, "Use 'council'.", 42)
    expect(t.status).toBe("ok")
    if (t.status !== "ok") throw new Error("unreachable")
    expect(t.decision.status).toBe("resolved")
    expect(t.decision.resolution).toEqual({
      kind: "answered",
      answer: "Use 'council'.",
      byUserId: 42,
    })
    expect(t.decision.resolvedAt).not.toBeNull()
  })

  it("refuses to answer an already-closed decision instead of clobbering it", async () => {
    const d = await seed()
    await answerDecision(db, d.id, "first", 1)
    const second = await answerDecision(db, d.id, "second", 2)
    expect(second.status).toBe("invalid_state")

    const read = await getDecision(db, d.id)
    expect(read?.resolution).toEqual({ kind: "answered", answer: "first", byUserId: 1 })
  })

  it("reports not_found for an unknown id", async () => {
    expect((await answerDecision(db, "nope", "x", 1)).status).toBe("not_found")
  })

  // The invariant the whole design rests on: routing must NOT close anything,
  // or a queue of unanswered questions reports as handled work.
  it("assigning leaves the decision open so anyone can still answer it", async () => {
    const project = `proj-assign-${Date.now()}`
    const d = await seed({ projectId: project })
    const t = await assignDecision(db, d.id, { userId: 7 })
    expect(t.status).toBe("ok")
    if (t.status !== "ok") throw new Error("unreachable")
    expect(t.decision.status).toBe("open")
    expect(t.decision.assignedUserId).toBe(7)

    // Still surfaced, still countable, and answerable by someone else.
    expect(await countOpenDecisions(db, project)).toBe(1)
    const answered = await answerDecision(db, d.id, "settled", 99)
    expect(answered.status).toBe("ok")
  })

  it("supersedes only open decisions and reports how many it closed", async () => {
    const open = await seed()
    const closed = await seed()
    await dismissDecision(db, closed.id)

    const n = await supersedeDecisions(db, [open.id, closed.id])
    expect(n).toBe(1)
    expect((await getDecision(db, open.id))?.status).toBe("superseded")
    expect((await getDecision(db, closed.id))?.status).toBe("dismissed")
  })

  it("expires only decisions older than the cutoff", async () => {
    const project = `proj-exp-${Date.now()}`
    const fresh = await seed({ projectId: project })
    const past = new Date(Date.now() - 60_000).toISOString()
    expect(await expireDecisionsOlderThan(db, project, past)).toBe(0)

    const future = new Date(Date.now() + 60_000).toISOString()
    expect(await expireDecisionsOlderThan(db, project, future)).toBe(1)
    expect((await getDecision(db, fresh.id))?.status).toBe("expired")
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd auth-worker && npx vitest run src/__tests__/contextual-decisions.test.ts`
Expected: FAIL — `answerDecision` is not exported.

- [ ] **Step 3: Implement the transitions**

Append to `db/shared/contextual-decisions.ts`:

```ts
export type DecisionTransition =
  | { status: "ok"; decision: ContextualDecision }
  | { status: "invalid_state" }
  | { status: "not_found" }

/** Every transition is a GUARDED UPDATE: the WHERE clause names the statuses
 *  it may move from, so two racing writers cannot both win. The loser matches
 *  zero rows and we distinguish "wrong state" from "no such row" with one
 *  follow-up read. */
async function transition(
  db: AquillaDb,
  id: string,
  sql: string,
  binds: unknown[],
): Promise<DecisionTransition> {
  const row = await db.prepare(sql).bind(...binds).first<DecisionRow>()
  if (row) return { status: "ok", decision: mapRow(row) }
  const exists = await db
    .prepare(`SELECT 1 AS n FROM contextual_decisions WHERE id = ?`)
    .bind(id)
    .first<{ n: number }>()
  return exists ? { status: "invalid_state" } : { status: "not_found" }
}

export async function answerDecision(
  db: AquillaDb,
  id: string,
  answer: string,
  byUserId: number,
): Promise<DecisionTransition> {
  const trimmed = answer.trim()
  if (!trimmed) throw new Error("answer is required")
  const resolution: DecisionResolution = { kind: "answered", answer: trimmed, byUserId }
  return transition(
    db,
    id,
    `UPDATE contextual_decisions
        SET status = 'resolved', resolution = ?::jsonb,
            resolved_at = now(), updated_at = now()
      WHERE id = ? AND status IN ('open','researching')
      RETURNING ${DECISION_COLS}`,
    // Pass the object, NOT JSON.stringify(resolution). postgres.js learns the
    // parameter's jsonb type from `?::jsonb` and applies its own serializer;
    // pre-stringifying makes it encode a second time, storing a jsonb scalar
    // string instead of an object. See db/shared/contextual-runs.ts:718-721,
    // and migration 0074, which exists partly to repair rows written that way.
    [resolution, id],
  )
}

export async function dismissDecision(
  db: AquillaDb,
  id: string,
): Promise<DecisionTransition> {
  return transition(
    db,
    id,
    `UPDATE contextual_decisions
        SET status = 'dismissed', resolved_at = now(), updated_at = now()
      WHERE id = ? AND status IN ('open','researching')
      RETURNING ${DECISION_COLS}`,
    [id],
  )
}

/** Routing is an ASSIGNMENT: status stays `open` on purpose (§4.3). */
export async function assignDecision(
  db: AquillaDb,
  id: string,
  to: { userId?: number; inviteId?: string },
): Promise<DecisionTransition> {
  return transition(
    db,
    id,
    `UPDATE contextual_decisions
        SET assigned_user_id = ?, assigned_invite_id = ?, updated_at = now()
      WHERE id = ? AND status IN ('open','researching')
      RETURNING ${DECISION_COLS}`,
    [to.userId ?? null, to.inviteId ?? null, id],
  )
}

/** Bulk close for the supersession sweep. Returns how many were actually
 *  closed — already-closed rows are skipped, never reopened. */
export async function supersedeDecisions(
  db: AquillaDb,
  ids: string[],
): Promise<number> {
  if (ids.length === 0) return 0
  const placeholders = ids.map(() => "?").join(",")
  const { results } = await db
    .prepare(
      `UPDATE contextual_decisions
          SET status = 'superseded', resolved_at = now(), updated_at = now()
        WHERE id IN (${placeholders}) AND status IN ('open','researching')
        RETURNING id`,
    )
    .bind(...ids)
    .all<{ id: string }>()
  return (results ?? []).length
}

/** Backstop only — supersession is the real mechanism (§4.3). Expiry is a
 *  DISTINCT terminal state from supersession because it means the opposite
 *  thing: nobody ever answered. */
export async function expireDecisionsOlderThan(
  db: AquillaDb,
  projectId: string,
  cutoffIso: string,
): Promise<number> {
  const { results } = await db
    .prepare(
      `UPDATE contextual_decisions
          SET status = 'expired', resolved_at = now(), updated_at = now()
        WHERE project_id = ? AND status IN ('open','researching')
          AND created_at < ?::timestamptz
        RETURNING id`,
    )
    .bind(projectId, cutoffIso)
    .all<{ id: string }>()
  return (results ?? []).length
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd auth-worker && npx vitest run src/__tests__/contextual-decisions.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add db/shared/contextual-decisions.ts auth-worker/src/__tests__/contextual-decisions.test.ts
git commit -m "feat(decisions): guarded transitions; routing assigns without closing"
```

---

### Task 4: The pure supersession predicate

**Files:**
- Create: `auth-worker/src/lib/contextual/supersede.ts`
- Modify: `auth-worker/src/lib/contextual/readiness.ts` (export two constants)
- Test: `auth-worker/src/__tests__/contextual-supersede.test.ts`

**Interfaces:**
- Consumes: Task 2's `DecisionReadinessItem`; `ReadinessLevel` from `readiness.ts`
- Produces:
  - `interface SupersessionSnapshot`
  - `isSuperseded(decision: SupersedableDecision, snap: SupersessionSnapshot): boolean`
  - `interface SupersedableDecision { readinessItem: DecisionReadinessItem | null; conceptId: string | null }`
  - `readiness.ts` now exports `MIN_EXAMPLES` and `MIN_BRIEF_FIELDS`

- [ ] **Step 1: Export the thresholds from readiness.ts**

In `auth-worker/src/lib/contextual/readiness.ts`, add `export` to the two existing constants (do not change their values):

```ts
export const MIN_EXAMPLES = 8
export const MIN_BRIEF_FIELDS = 4
```

- [ ] **Step 2: Write the failing test**

Create `auth-worker/src/__tests__/contextual-supersede.test.ts`:

```ts
// Supersession predicate (seam design §4.3).
// WHY these tests: supersession is the path users actually take — they answer
// a question by doing ordinary work, never seeing the card. If this predicate
// is too eager it closes questions that still need a human; if it is too shy
// the user gets interrupted for something already settled. The free-text case
// must NEVER auto-close, because deciding whether an edit answered a question
// is a judgment call, not a query (CLAUDE.md Rule 5).

import { describe, it, expect } from "vitest"
import { isSuperseded, type SupersessionSnapshot } from "../lib/contextual/supersede"

const base: SupersessionSnapshot = {
  conceptsWithApprovedRenderings: new Set<string>(),
  validatedExamples: 0,
  briefFieldsAnswered: 0,
  readinessLevels: {
    terminology: "missing",
    brief: "missing",
    examples: "missing",
    rules: "partial",
    languages: "partial",
  },
}

describe("isSuperseded", () => {
  it("closes a terminology decision once its concept gains a rendering", () => {
    const d = { readinessItem: "terminology" as const, conceptId: "c-1" }
    expect(isSuperseded(d, base)).toBe(false)
    expect(
      isSuperseded(d, { ...base, conceptsWithApprovedRenderings: new Set(["c-1"]) }),
    ).toBe(true)
  })

  it("does not close a terminology decision when a DIFFERENT concept was settled", () => {
    const d = { readinessItem: "terminology" as const, conceptId: "c-1" }
    expect(
      isSuperseded(d, { ...base, conceptsWithApprovedRenderings: new Set(["c-2"]) }),
    ).toBe(false)
  })

  it("closes an examples decision only once the threshold is crossed", () => {
    const d = { readinessItem: "examples" as const, conceptId: null }
    expect(isSuperseded(d, { ...base, validatedExamples: 7 })).toBe(false)
    expect(isSuperseded(d, { ...base, validatedExamples: 8 })).toBe(true)
  })

  it("closes a brief decision once enough fields are answered", () => {
    const d = { readinessItem: "brief" as const, conceptId: null }
    expect(isSuperseded(d, { ...base, briefFieldsAnswered: 3 })).toBe(false)
    expect(isSuperseded(d, { ...base, briefFieldsAnswered: 4 })).toBe(true)
  })

  it("closes rules and languages decisions once they leave 'missing'", () => {
    const rules = { readinessItem: "rules" as const, conceptId: null }
    expect(
      isSuperseded(rules, {
        ...base,
        readinessLevels: { ...base.readinessLevels, rules: "missing" },
      }),
    ).toBe(false)
    expect(isSuperseded(rules, base)).toBe(true) // base has rules: "partial"
  })

  it("never auto-closes a free-text decision — that needs judgment, not a query", () => {
    const d = { readinessItem: null, conceptId: null }
    expect(
      isSuperseded(d, {
        ...base,
        validatedExamples: 999,
        conceptsWithApprovedRenderings: new Set(["c-1"]),
      }),
    ).toBe(false)
  })

  it("never closes a terminology decision that names no concept", () => {
    const d = { readinessItem: "terminology" as const, conceptId: null }
    expect(
      isSuperseded(d, { ...base, conceptsWithApprovedRenderings: new Set(["c-1"]) }),
    ).toBe(false)
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd auth-worker && npx vitest run src/__tests__/contextual-supersede.test.ts`
Expected: FAIL — cannot resolve `../lib/contextual/supersede`.

- [ ] **Step 4: Write the predicate**

Create `auth-worker/src/lib/contextual/supersede.ts`:

```ts
// Supersession — "does this question still need an answer?" (seam design §4.3).
//
// PURE by design: no database, no HTTP, no model. Every branch here is a query
// the caller has already answered, so the whole thing unit-tests with plain
// values. Per CLAUDE.md Rule 5, code answers what code can answer; the ONLY
// judgment-shaped case (a free-text ambiguity someone resolved in the work
// without seeing the card) is deliberately NOT handled here — it returns false
// and is left for a gated model call that is out of scope for this slice.

import { MIN_EXAMPLES, MIN_BRIEF_FIELDS, type ReadinessLevel } from "./readiness"
import type { DecisionReadinessItem } from "../../../../db/shared/contextual-decisions"

export interface SupersedableDecision {
  readinessItem: DecisionReadinessItem | null
  conceptId: string | null
}

export interface SupersessionSnapshot {
  /** Concept ids with a `preferred` or `admitted` rendering. */
  conceptsWithApprovedRenderings: ReadonlySet<string>
  validatedExamples: number
  briefFieldsAnswered: number
  readinessLevels: Record<DecisionReadinessItem, ReadinessLevel>
}

/** True when the gap that caused this decision has been filled by other means,
 *  so the run may proceed with nobody touching the card. */
export function isSuperseded(
  decision: SupersedableDecision,
  snap: SupersessionSnapshot,
): boolean {
  switch (decision.readinessItem) {
    case "terminology":
      // A terminology decision that names no concept cannot be checked
      // mechanically — treat it as still open rather than guessing.
      return decision.conceptId
        ? snap.conceptsWithApprovedRenderings.has(decision.conceptId)
        : false
    case "examples":
      return snap.validatedExamples >= MIN_EXAMPLES
    case "brief":
      return snap.briefFieldsAnswered >= MIN_BRIEF_FIELDS
    case "rules":
    case "languages":
      return snap.readinessLevels[decision.readinessItem] !== "missing"
    default:
      // Free text. Closing this is a judgment call, not a query.
      return false
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd auth-worker && npx vitest run src/__tests__/contextual-supersede.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add auth-worker/src/lib/contextual/supersede.ts auth-worker/src/lib/contextual/readiness.ts auth-worker/src/__tests__/contextual-supersede.test.ts
git commit -m "feat(decisions): deterministic supersession predicate"
```

---

### Task 5: The `waiting` run status

**Files:**
- Modify: `db/shared/contextual-runs.ts`
- Test: `auth-worker/src/__tests__/contextual-decisions.test.ts`

**Interfaces:**
- Consumes: Task 1's schema
- Produces:
  - `ContextualRunStatus` gains `"waiting"`; `ACTIVE_STATUSES` includes it
  - `blockRunOnDecision(db, runId, decisionId): Promise<{status:"ok"; run: ContextualRun} | {status:"invalid_state"} | {status:"not_found"}>`
  - `unblockRun(db, runId): Promise<{status:"ok"; run: ContextualRun} | {status:"invalid_state"} | {status:"not_found"}>`

- [ ] **Step 1: Write the failing test**

Append to `auth-worker/src/__tests__/contextual-decisions.test.ts`. Extend the imports with `createRun`, `getRun`, `claimStrandedRuns`, `blockRunOnDecision`, `unblockRun` from `../../../db/shared/contextual-runs`:

```ts
async function newRun(projectId: string, fileId = "f1") {
  const created = await createRun(db, { projectId, fileId, targetLang: "" })
  if (created.status !== "ok") throw new Error(`createRun: ${created.status}`)
  return created.run
}

describe("waiting run status", () => {
  it("blocks a running run on a decision and unblocks it again", async () => {
    const project = `proj-wait-${Date.now()}`
    const run = await newRun(project)
    const d = await seed({ projectId: project, runId: run.id })

    const blocked = await blockRunOnDecision(db, run.id, d.id)
    expect(blocked.status).toBe("ok")
    expect((await getRun(db, run.id))?.status).toBe("waiting")

    const unblocked = await unblockRun(db, run.id)
    expect(unblocked.status).toBe("ok")
    expect((await getRun(db, run.id))?.status).toBe("running")
  })

  // THE regression test for §4.5. A waiting run adopted by the sweeper gets
  // flipped to running and re-ticked forever — burning budget while the human
  // it is waiting for never gets asked again. The predicate must name statuses
  // explicitly and must never include 'waiting'.
  // A waiting run holds its lane, so starting another run on the same file
  // must report `active_exists` — NOT surface a raw unique-violation error
  // from Postgres. See Step 3 item 6.
  it("reports active_exists rather than throwing when a waiting run holds the lane", async () => {
    const project = `proj-lane-${Date.now()}`
    const run = await newRun(project)
    const d = await seed({ projectId: project, runId: run.id })
    await blockRunOnDecision(db, run.id, d.id)

    const second = await createRun(db, { projectId: project, fileId: "f1", targetLang: "" })
    expect(second.status).toBe("active_exists")
    if (second.status !== "active_exists") throw new Error("unreachable")
    expect(second.runId).toBe(run.id)
  })

  it("is never adopted by the stranded-run sweeper", async () => {
    const project = `proj-sweep-${Date.now()}`
    const run = await newRun(project)
    const d = await seed({ projectId: project, runId: run.id })
    await blockRunOnDecision(db, run.id, d.id)

    // Backdate well past any staleness threshold so the ONLY thing keeping it
    // out of the sweep is its status.
    await db
      .prepare(`UPDATE contextual_runs SET updated_at = now() - interval '1 day' WHERE id = ?`)
      .bind(run.id)
      .run()

    const claimed = await claimStrandedRuns(db, 50)
    expect(claimed.map((r) => r.id)).not.toContain(run.id)
    expect((await getRun(db, run.id))?.status).toBe("waiting")
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd auth-worker && npx vitest run src/__tests__/contextual-decisions.test.ts -t "waiting run status"`
Expected: FAIL — `blockRunOnDecision` is not exported.

- [ ] **Step 3: Add the status and the transitions**

In `db/shared/contextual-runs.ts`:

1. Add `"waiting"` to the `ContextualRunStatus` union (after `"parked"`, ~line 26).
2. Add `"waiting"` to `ACTIVE_STATUSES` (~line 31) — a waiting run holds its lane, and `failRun` (which transitions from `[...ACTIVE_STATUSES]`) must be able to fail one.
3. Add `blocked_on_decision_id` to the `RUN_COLS` list (~line 334), plus `blockedOnDecisionId: string | null` on the `ContextualRun` interface and in `rowToRun`.
4. **Do not touch `claimStrandedRuns`** (~line 1719). Its predicate names `running` and `parked` explicitly, which is exactly why the regression test in Step 1 passes.
6. **Fix `createRun`'s two hardcoded status lists.** `createRun` does *not* use `ACTIVE_STATUSES`: it inlines `('running','pausing','paused','parked')` twice — the pre-check at ~line 797 and the race-recovery lookup at ~line 833. Task 1 added `waiting` to the `contextual_runs_active` unique index, so leaving these alone breaks as follows: the pre-check misses the waiting run → the INSERT violates the index → the catch block's lookup *also* misses it → `racing` is null → the raw Postgres unique-violation error is rethrown instead of a clean `active_exists`. Replace **both** inline lists with `ACTIVE_STATUSES` expanded the same way `failRun` does it, so there is one source of truth:

```ts
// Both sites become (note: bind the spread AFTER the existing binds):
const activePlaceholders = ACTIVE_STATUSES.map(() => "?").join(",")
// …
  `SELECT id FROM contextual_runs
    WHERE project_id = ? AND file_id = ? AND target_lang = ?
      AND status IN (${activePlaceholders})
    LIMIT 1`
// .bind(input.projectId, input.fileId, lane, ...ACTIVE_STATUSES)
```
5. Append the two transitions after `parkRun` / `failRun` (~line 1044). These cannot use the existing `transitionRun` helper because they also write `blocked_on_decision_id`, so they mirror its body — including the same `TransitionResult` contract and the same "read back to distinguish invalid_state from not_found" tail:

```ts
/** Block a live run on a decision (§4.5). `waiting` means "something left to
 *  do, but it needs a human" — distinct from `parked`, which means there is
 *  nothing left to do. Conflating them is how a blocked run silently looks
 *  finished. */
export async function blockRunOnDecision(
  db: AquillaDb,
  runId: string,
  decisionId: string,
): Promise<TransitionResult> {
  const row = await db
    .prepare(
      `UPDATE contextual_runs
          SET status = 'waiting', blocked_on_decision_id = ?, updated_at = now()
        WHERE id = ? AND status = 'running'
        RETURNING ${RUN_COLS}`,
    )
    .bind(decisionId, runId)
    .first<RunRow>()
  if (row) return { status: "ok", run: rowToRun(row) }
  const current = await getRun(db, runId)
  if (!current) return { status: "not_found" }
  return { status: "invalid_state", current: current.status }
}

/** Resume a waiting run. Reached two ways (§4.5): the decision was answered,
 *  or the next wake's sweep found it superseded. The second should be the
 *  common one. */
export async function unblockRun(
  db: AquillaDb,
  runId: string,
): Promise<TransitionResult> {
  const row = await db
    .prepare(
      `UPDATE contextual_runs
          SET status = 'running', blocked_on_decision_id = NULL, updated_at = now()
        WHERE id = ? AND status = 'waiting'
        RETURNING ${RUN_COLS}`,
    )
    .bind(runId)
    .first<RunRow>()
  if (row) return { status: "ok", run: rowToRun(row) }
  const current = await getRun(db, runId)
  if (!current) return { status: "not_found" }
  return { status: "invalid_state", current: current.status }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd auth-worker && npx vitest run src/__tests__/contextual-decisions.test.ts src/__tests__/contextual-runs.test.ts`
Expected: PASS — all three new tests, and no regressions in the existing run suite (which exercises `createRun`'s `active_exists` path directly).

- [ ] **Step 5: Commit**

```bash
git add db/shared/contextual-runs.ts auth-worker/src/__tests__/contextual-decisions.test.ts
git commit -m "feat(decisions): waiting run status, excluded from the stranded sweep"
```

---

### Task 6: HTTP routes

**Files:**
- Create: `auth-worker/src/routes/contextual-decisions.ts`
- Modify: `auth-worker/src/index.ts` (mount it)
- Test: `auth-worker/src/__tests__/contextual-decisions-routes.test.ts`

**Interfaces:**
- Consumes: Tasks 2–3 data layer; `authMiddleware`, `ROLE`, `AuthHonoEnv` from the worker
- Produces:
  - `GET  /api/v2/projects/:projectId/contextual/decisions` → `{ decisions, openCount, cap }`
  - `POST /api/v2/projects/:projectId/contextual/decisions/:decisionId/:action` where action ∈ `answer` | `dismiss` | `assign`

- [ ] **Step 1: Write the failing test**

Create `auth-worker/src/__tests__/contextual-decisions-routes.test.ts`. Follow the existing route-test setup in `auth-worker/src/__tests__/contextual-routes.test.ts` for app construction and auth headers — read that file first and mirror it.

```ts
// Decision routes (seam design §4.3, §4.6).
// WHY these tests: the surfacing cap is a product promise, not a nicety — a
// user who is shown thirty questions has been handed a queue, which is the
// exact failure the decision channel exists to avoid. And `answer` must be
// role-gated, because answering sets project-wide policy.

import { env } from "cloudflare:test"
import { describe, it, expect, beforeEach } from "vitest"
import { raiseDecision } from "../../../db/shared/contextual-decisions"

const db = env.AQUILLA_PG

describe("GET /contextual/decisions", () => {
  it("surfaces at most the cap, ranked, but reports the true open count", async () => {
    const project = `proj-routes-${Date.now()}`
    for (const radius of [1, 2, 3, 40, 50]) {
      await raiseDecision(db, {
        projectId: project,
        runId: null,
        fileId: "f1",
        reason: `radius ${radius}`,
        blastRadius: radius,
      })
    }

    const res = await request(`/api/v2/projects/${project}/contextual/decisions`)
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.cap).toBe(3)
    expect(body.openCount).toBe(5)          // the held ones are still open
    expect(body.decisions).toHaveLength(3)  // …but not shown
    expect(body.decisions.map((d: { blastRadius: number }) => d.blastRadius)).toEqual([50, 40, 3])
  })
})

describe("POST /contextual/decisions/:id/:action", () => {
  it("rejects an unknown action rather than silently doing nothing", async () => {
    const res = await request(`/api/v2/projects/p/contextual/decisions/x/explode`, {
      method: "POST",
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  it("answers a decision and returns the resolved row", async () => {
    const project = `proj-answer-${Date.now()}`
    const d = await raiseDecision(db, {
      projectId: project,
      runId: null,
      fileId: "f1",
      reason: "Which rendering?",
    })
    const res = await request(
      `/api/v2/projects/${project}/contextual/decisions/${d.id}/answer`,
      { method: "POST", body: JSON.stringify({ answer: "council" }) },
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.decision.status).toBe("resolved")
  })

  it("returns 409 when answering an already-closed decision", async () => {
    const project = `proj-conflict-${Date.now()}`
    const d = await raiseDecision(db, {
      projectId: project, runId: null, fileId: "f1", reason: "Which rendering?",
    })
    const once = { method: "POST", body: JSON.stringify({ answer: "a" }) }
    await request(`/api/v2/projects/${project}/contextual/decisions/${d.id}/answer`, once)
    const res = await request(
      `/api/v2/projects/${project}/contextual/decisions/${d.id}/answer`,
      { method: "POST", body: JSON.stringify({ answer: "b" }) },
    )
    expect(res.status).toBe(409)
  })
})
```

**Implementer note:** define the `request(path, init?)` helper by copying the pattern from `contextual-routes.test.ts` (it builds the Hono app from `../index` and attaches a signed test JWT). Do not invent a new harness.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd auth-worker && npx vitest run src/__tests__/contextual-decisions-routes.test.ts`
Expected: FAIL — 404 on every route.

- [ ] **Step 3: Write the routes**

Create `auth-worker/src/routes/contextual-decisions.ts`:

```ts
// Decision routes — the agent → user channel's HTTP surface (seam design §4.3).
//
// Read is VIEWER; acting is CONTRIBUTOR, because answering a decision sets
// project-wide policy rather than editing one cell.
//
// The surfacing cap is enforced HERE, read-side, not at raise time: a held
// decision stays open so the supersession sweep can still close it, and is
// very likely to be closed that way before anyone would have reached it.

import { Hono } from "hono"
import { z } from "zod"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"
import { ROLE } from "../types"
import {
  listOpenDecisions,
  countOpenDecisions,
  answerDecision,
  dismissDecision,
  assignDecision,
  OPEN_DECISION_SURFACE_CAP,
  type DecisionTransition,
} from "../../../db/shared/contextual-decisions"

const decisions = new Hono<AuthHonoEnv>()

const answerSchema = z.object({ answer: z.string().min(1).max(2000) })
const assignSchema = z.object({
  userId: z.number().int().positive().optional(),
  inviteId: z.string().min(1).max(256).optional(),
})

decisions.get("/:projectId/contextual/decisions", authMiddleware, async (c) => {
  const projectId = c.req.param("projectId") ?? ""
  const gate = await requireRole(c, projectId, ROLE.VIEWER)
  if (!gate.ok) return gate.res

  const [open, openCount] = await Promise.all([
    listOpenDecisions(c.env.AQUILLA_PG, projectId, OPEN_DECISION_SURFACE_CAP),
    countOpenDecisions(c.env.AQUILLA_PG, projectId),
  ])
  return c.json({ decisions: open, openCount, cap: OPEN_DECISION_SURFACE_CAP })
})

decisions.post(
  "/:projectId/contextual/decisions/:decisionId/:action",
  authMiddleware,
  async (c) => {
    const projectId = c.req.param("projectId") ?? ""
    const decisionId = c.req.param("decisionId") ?? ""
    const action = c.req.param("action") ?? ""
    if (!["answer", "dismiss", "assign"].includes(action)) {
      const { body, status } = errorJson("validation_failed", `unknown action ${action}`, 400)
      return c.json(body, status)
    }
    const gate = await requireRole(c, projectId, ROLE.CONTRIBUTOR)
    if (!gate.ok) return gate.res

    let result: DecisionTransition
    if (action === "answer") {
      const parsed = answerSchema.safeParse(await c.req.json().catch(() => ({})))
      if (!parsed.success) {
        const { body, status } = errorJson("validation_failed", "answer is required", 400)
        return c.json(body, status)
      }
      // requireRole returns only { ok, level } — it carries no user. The
      // authenticated user comes from the middleware's context variable, the
      // same way requireRole itself reads it (contextual.ts:130).
      const user = c.get("user")
      result = await answerDecision(
        c.env.AQUILLA_PG,
        decisionId,
        parsed.data.answer,
        user.id,
      )
    } else if (action === "dismiss") {
      result = await dismissDecision(c.env.AQUILLA_PG, decisionId)
    } else {
      const parsed = assignSchema.safeParse(await c.req.json().catch(() => ({})))
      if (!parsed.success || (!parsed.data.userId && !parsed.data.inviteId)) {
        const { body, status } = errorJson(
          "validation_failed",
          "assign requires userId or inviteId",
          400,
        )
        return c.json(body, status)
      }
      result = await assignDecision(c.env.AQUILLA_PG, decisionId, parsed.data)
    }

    if (result.status === "not_found") {
      const { body, status } = errorJson("not_found", `decision ${decisionId} not found`, 404)
      return c.json(body, status)
    }
    if (result.status === "invalid_state") {
      const { body, status } = errorJson(
        "invalid_state",
        "decision is already closed",
        409,
      )
      return c.json(body, status)
    }
    if (result.decision.projectId !== projectId) {
      const { body, status } = errorJson("not_found", `decision ${decisionId} not found`, 404)
      return c.json(body, status)
    }
    return c.json({ decision: result.decision })
  },
)

export default decisions
```

**Implementer note — do this first, it is a prerequisite for the code above.** `errorJson` (`auth-worker/src/routes/contextual.ts:118`) and `requireRole` (`:125`) are **file-private** — neither is exported. Move both verbatim into a new `auth-worker/src/routes/_contextual-helpers.ts`, export them, and import from *both* `contextual.ts` and the new module. Do not copy them, and do not change their behaviour: `contextual.ts` has many callers and this must stay a pure move. Run `cd auth-worker && npm test` after the move and before writing any new route code, so a regression there is unambiguous.

- [ ] **Step 4: Mount the routes**

In `auth-worker/src/index.ts`, mount `contextual-decisions` on the same `/api/v2/projects` base as the existing `contextual` routes. Copy the neighbouring `app.route(...)` line exactly and change only the module and variable name.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd auth-worker && npx vitest run src/__tests__/contextual-decisions-routes.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Run the whole worker suite for regressions**

Run: `cd auth-worker && npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add auth-worker/src/routes/contextual-decisions.ts auth-worker/src/index.ts auth-worker/src/__tests__/contextual-decisions-routes.test.ts
git commit -m "feat(decisions): HTTP surface with read-side surfacing cap"
```

---

### Task 7: Client transport

**Files:**
- Modify: `src/lib/contextual/transport.ts`
- Test: `src/lib/contextual/transport.test.ts` (exists — append)

**Interfaces:**
- Consumes: Task 6's endpoints
- Produces:
  - `interface ContextualDecisionView` (client mirror; `blastRadius`, `reason`, `status`, `assignedUserId`, `readinessItem`, `cellIds`, `fileId`, `id`)
  - `interface ContextualDecisionsPage { decisions: ContextualDecisionView[]; openCount: number; cap: number }`
  - `fetchContextualDecisions(projectId): Promise<ContextualDecisionsPage>`
  - `actOnContextualDecision(projectId, decisionId, action, payload): Promise<void>`

- [ ] **Step 1: Write the failing test**

Append to `src/lib/contextual/transport.test.ts` (mirror the fetch-mocking style already used in that file):

```ts
describe("fetchContextualDecisions", () => {
  it("degrades to an empty page when the backend predates the endpoint", async () => {
    mockFetchOnce({ status: 404 })
    const page = await fetchContextualDecisions("p1")
    expect(page).toEqual({ decisions: [], openCount: 0, cap: 0 })
  })

  it("passes through the cap and the true open count", async () => {
    mockFetchOnce({
      status: 200,
      json: { decisions: [{ id: "d1", reason: "why", blastRadius: 6 }], openCount: 5, cap: 3 },
    })
    const page = await fetchContextualDecisions("p1")
    expect(page.openCount).toBe(5)
    expect(page.cap).toBe(3)
    expect(page.decisions).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test src/lib/contextual/transport.test.ts`
Expected: FAIL — `fetchContextualDecisions` is not exported.

- [ ] **Step 3: Implement the transport helpers**

Append to `src/lib/contextual/transport.ts`, matching the existing helpers exactly (`requireJwt`, `fetchWithTimeout`, `authHeaders`, `throwFromResponse`, `AUTH_BASE`):

```ts
export interface ContextualDecisionView {
  id: string
  fileId: string
  cellIds: string[]
  reason: string
  readinessItem: "terminology" | "brief" | "examples" | "rules" | "languages" | null
  blastRadius: number
  status: "open" | "researching" | "resolved" | "dismissed" | "superseded" | "expired"
  assignedUserId: number | null
}

export interface ContextualDecisionsPage {
  decisions: ContextualDecisionView[]
  /** True number of open decisions — may exceed `decisions.length`, because
   *  surplus is HELD rather than shown (§4.6). */
  openCount: number
  cap: number
}

const EMPTY_DECISIONS: ContextualDecisionsPage = { decisions: [], openCount: 0, cap: 0 }

/** Reports an empty page rather than throwing when the backend predates this
 *  endpoint, so the inspector still renders without it. */
export async function fetchContextualDecisions(
  projectId: string,
): Promise<ContextualDecisionsPage> {
  const jwt = await requireJwt()
  const res = await fetchWithTimeout(
    `${AUTH_BASE}/api/v2/projects/${encodeURIComponent(projectId)}/contextual/decisions`,
    { headers: authHeaders(jwt) },
  )
  if (res.status === 404 || res.status === 501) return EMPTY_DECISIONS
  if (!res.ok) return throwFromResponse(res, "fetch decisions failed")
  const body = (await res.json()) as Partial<ContextualDecisionsPage>
  return { ...EMPTY_DECISIONS, ...body }
}

export async function actOnContextualDecision(
  projectId: string,
  decisionId: string,
  action: "answer" | "dismiss" | "assign",
  payload: Record<string, unknown> = {},
): Promise<void> {
  const jwt = await requireJwt()
  const res = await fetchWithTimeout(
    `${AUTH_BASE}/api/v2/projects/${encodeURIComponent(projectId)}/contextual/decisions/${encodeURIComponent(decisionId)}/${action}`,
    { method: "POST", headers: authHeaders(jwt), body: JSON.stringify(payload) },
  )
  if (!res.ok) return throwFromResponse(res, `decision ${action} failed`)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test src/lib/contextual/transport.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/contextual/transport.ts src/lib/contextual/transport.test.ts
git commit -m "feat(decisions): client transport for the decision channel"
```

---

### Task 8: `DecisionCard` and the inspector region

**Files:**
- Create: `src/components/contextual/DecisionCard.tsx`
- Create: `src/components/contextual/DecisionCard.test.tsx`
- Modify: `src/components/contextual/AutopilotActivityInspector.tsx`
- Modify: `src/lib/i18n/namespaces/autopilot.ts`

**Interfaces:**
- Consumes: Task 7's `ContextualDecisionView`, `actOnContextualDecision`
- Produces: `<DecisionCard decision={…} projectId={…} onResolved={() => void} />`

- [ ] **Step 1: Add i18n keys**

In `src/lib/i18n/namespaces/autopilot.ts`, add these inside the existing `defineNamespace({ keys: { … } })` object, alongside the `autopilot.inspector.*` group. **Interpolation in this codebase is `{count}` (single braces), and count-bearing keys use `plural({ one, other })`** — `plural` is already imported at the top of the file:

```ts
"autopilot.decisions.heading": "Needs your decision",
"autopilot.decisions.empty": "Nothing needs you right now.",
"autopilot.decisions.held": plural({
  one: "{count} more question is held until these are settled.",
  other: "{count} more questions are held until these are settled.",
}),
"autopilot.decisions.blastRadius": plural({
  one: "Affects {count} later passage.",
  other: "Affects {count} later passages.",
}),
"autopilot.decisions.answer": "Answer",
"autopilot.decisions.answerPlaceholder": "Your decision…",
"autopilot.decisions.dismiss": "Not needed",
"autopilot.decisions.assign": "Ask someone else",
```

`MessageKey` is derived from `src/lib/i18n/messages/en.ts`, which spreads this namespace — so `t()` calls are type-checked automatically once the keys land here. **No change to `en.ts` is needed.** Other locales (`messages/ar.ts`, `my.ts`, `th.ts`) are `Partial` catalogs that fall back to English; leave them alone.

There are namespace guard tests (`src/lib/i18n/namespaces/no-duplicates.test.ts`, `types.test.ts`, `common.test.ts`). Run `pnpm test src/lib/i18n` after this step and before writing the component — a key-shape mistake should surface here, not in the component test.

- [ ] **Step 2: Write the failing test**

Create `src/components/contextual/DecisionCard.test.tsx`:

```tsx
// DecisionCard (seam design §4.3, §4.6).
// WHY these tests: the card's whole job is to be worth interrupting for. It
// must state WHY it exists (not "review this") and it must show blast radius,
// because "this affects six later passages" is what makes the question
// answerable rather than merely annoying. Dismiss must be as easy as answer —
// dismissal rate is a designed signal, so the UI must not discourage it.

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, it, expect, vi } from "vitest"
import { DecisionCard } from "./DecisionCard"
import type { ContextualDecisionView } from "@/lib/contextual/transport"

vi.mock("@/lib/contextual/transport", async (orig) => ({
  ...(await orig<typeof import("@/lib/contextual/transport")>()),
  actOnContextualDecision: vi.fn().mockResolvedValue(undefined),
}))

const decision: ContextualDecisionView = {
  id: "d1",
  fileId: "f1",
  cellIds: ["c1"],
  reason: "Two prior renderings of this name conflict.",
  readinessItem: "terminology",
  blastRadius: 6,
  status: "open",
  assignedUserId: null,
}

describe("DecisionCard", () => {
  it("shows the reason and the blast radius", () => {
    render(<DecisionCard decision={decision} projectId="p1" onResolved={() => {}} />)
    expect(screen.getByText(/Two prior renderings/)).toBeInTheDocument()
    expect(screen.getByText(/6/)).toBeInTheDocument()
  })

  it("submits an answer and notifies the parent", async () => {
    const { actOnContextualDecision } = await import("@/lib/contextual/transport")
    const onResolved = vi.fn()
    render(<DecisionCard decision={decision} projectId="p1" onResolved={onResolved} />)

    await userEvent.type(screen.getByRole("textbox"), "Use 'council'")
    await userEvent.click(screen.getByRole("button", { name: /answer/i }))

    expect(actOnContextualDecision).toHaveBeenCalledWith("p1", "d1", "answer", {
      answer: "Use 'council'",
    })
    expect(onResolved).toHaveBeenCalled()
  })

  it("will not submit an empty answer", async () => {
    const { actOnContextualDecision } = await import("@/lib/contextual/transport")
    vi.mocked(actOnContextualDecision).mockClear()
    render(<DecisionCard decision={decision} projectId="p1" onResolved={() => {}} />)
    await userEvent.click(screen.getByRole("button", { name: /answer/i }))
    expect(actOnContextualDecision).not.toHaveBeenCalled()
  })

  it("offers dismiss as a first-class action", async () => {
    const { actOnContextualDecision } = await import("@/lib/contextual/transport")
    vi.mocked(actOnContextualDecision).mockClear()
    render(<DecisionCard decision={decision} projectId="p1" onResolved={() => {}} />)
    await userEvent.click(screen.getByRole("button", { name: /not needed/i }))
    expect(actOnContextualDecision).toHaveBeenCalledWith("p1", "d1", "dismiss", {})
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm test src/components/contextual/DecisionCard.test.tsx`
Expected: FAIL — cannot resolve `./DecisionCard`.

- [ ] **Step 4: Write the component**

Create `src/components/contextual/DecisionCard.tsx`:

```tsx
// One decision the agent could not settle alone (seam design §4.3).
//
// The card states WHY it exists and how far the answer reaches. Dismiss sits
// beside Answer as a first-class action on purpose: dismissal rate is a
// designed quality signal (§4.2), so hiding the dismiss path would corrupt the
// number that tells us the agent is generating make-work.

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { useT } from "@/lib/i18n/I18nProvider"
import {
  actOnContextualDecision,
  type ContextualDecisionView,
} from "@/lib/contextual/transport"

export function DecisionCard({
  decision,
  projectId,
  onResolved,
}: {
  decision: ContextualDecisionView
  projectId: string
  onResolved: () => void
}) {
  const t = useT()
  const [answer, setAnswer] = useState("")
  const [busy, setBusy] = useState(false)

  async function act(action: "answer" | "dismiss", payload: Record<string, unknown>) {
    if (busy) return
    setBusy(true)
    try {
      await actOnContextualDecision(projectId, decision.id, action, payload)
      onResolved()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3 rounded-lg border p-4">
      <p className="text-sm">{decision.reason}</p>
      {decision.blastRadius > 0 && (
        <p className="text-xs text-muted-foreground">
          {t("autopilot.decisions.blastRadius", { count: decision.blastRadius })}
        </p>
      )}
      <Textarea
        value={answer}
        onChange={(e) => setAnswer(e.target.value)}
        placeholder={t("autopilot.decisions.answerPlaceholder")}
        rows={2}
      />
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={busy}
          onClick={() => {
            const trimmed = answer.trim()
            if (!trimmed) return
            void act("answer", { answer: trimmed })
          }}
        >
          {t("autopilot.decisions.answer")}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act("dismiss", {})}>
          {t("autopilot.decisions.dismiss")}
        </Button>
      </div>
    </div>
  )
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm test src/components/contextual/DecisionCard.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 6: Render the region in the inspector**

In `src/components/contextual/AutopilotActivityInspector.tsx`, add a decisions region **above** the event timeline — a decision is the one thing in the panel that needs the user, so it must not sit below a scrolling log. Fetch with `fetchContextualDecisions(projectId)` using the file's existing `useState` + race-guarded `useEffect` pattern (this codebase does **not** use `useQuery` — see `CLAUDE.md` AD-3). Render:

- heading `autopilot.decisions.heading`
- one `<DecisionCard>` per returned decision, `onResolved` re-running the fetch
- when `openCount > decisions.length`, the `autopilot.decisions.held` line with the difference
- when there are none, `autopilot.decisions.empty`

- [ ] **Step 7: Verify the full suites pass**

Run: `pnpm test src/components/contextual src/lib/contextual`
Expected: PASS.

Run: `pnpm lint`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/components/contextual/DecisionCard.tsx src/components/contextual/DecisionCard.test.tsx src/components/contextual/AutopilotActivityInspector.tsx src/lib/i18n/namespaces/autopilot.ts
git commit -m "feat(decisions): decision cards in the autopilot inspector"
```

---

## Deliberately out of scope

Named so a reviewer does not read their absence as an oversight:

- **The supervisor that raises decisions.** This slice builds the channel and its data layer; the tick executor does not yet call `raiseDecision`. Wiring it in belongs with the supervisor tier (spec §9 step 3), and until then decisions can be raised by tests and by the API.
- **The supersession sweep's caller.** Task 4 ships the pure predicate and Task 3 ships `supersedeDecisions`; the per-wake loop that assembles a `SupersessionSnapshot` and runs them together arrives with the supervisor.
- **The judgment-shaped supersession check** (a free-text ambiguity resolved in the work). Spec §11 open question 2 says explicitly: ship the deterministic half and measure what survives before building this.
- **Routing that creates an invite.** `assignDecision` accepts an `inviteId`; minting one from a decision is part of the onboarding/invite work.
- **Mandate, budgets, and the escalation metrics.** Spec §4.2 — these need the supervisor to have something to measure.
- **Expiry scheduling.** `expireDecisionsOlderThan` exists and is tested; nothing calls it on a timer yet, because the scheduled-job substrate does not exist (spec §8, the one genuinely missing piece).

## Follow-ups this plan deliberately leaves for the wiring task

Found during execution and verified. None can fire while nothing calls `blockRunOnDecision`, which is why they are recorded rather than fixed here — but the task that wires the supervisor into the tick **must** handle them, and it should start from this list.

1. **`waiting` is missing from the wire-frame status allowlists**, so a `waiting` frame is silently dropped and the run pill freezes on its last-known status — the exact "blocked run looks like it is still working" failure the state exists to prevent. Three places: `sync-worker/src/contextual-frames.ts` (`ContextualBroadcastRunStatus` and `RUN_STATUSES`, which returns `null` on an unknown status), `src/lib/sync/ws-reconciler.ts` (`CONTEXTUAL_FRAME_STATUSES`), and `src/lib/contextual/run-store.ts` (the SPA's own `ContextualRunStatus`). Nothing catches this at compile time: auth-worker's `ContextualRunStateFrame` types `status` as the full union, so a `waiting` frame is constructed happily and only fails at sync-worker's runtime validator.
2. **A terminated or failed run keeps its `blocked_on_decision_id`**, because `transitionRun` writes only `status`/`last_error`/`updated_at`. The decision it names stays `open` with no live run behind it. The wiring task should resolve that decision — `dismissDecision` and `supersedeDecisions` already exist for this.
3. **The project fan-out skip reason says "already running"** for a file whose lane a `waiting` run holds (`auth-worker/src/routes/contextual.ts:631-639`). Behaviour is right, the copy is imprecise.
