# Command Registry — P1 contract: delegation, supersession, playbooks (AQU-CMDREG-P1)

Follows `docs/COMMAND-REGISTRY.md` (P0, shipped). Implements the parts of the
oversight plan that do **not** depend on unmerged work.

## 0. Scope, and what is deliberately absent

The oversight plan has seven moves. Four of them depend on objects that do not
exist on `dev` yet, so they are **not** in this change:

| Move | Blocked on |
|---|---|
| Mandate as a catalog-tier grant | `Mandate` object (not built; PR #406 ships `Decision` only) |
| Supervisor writes through the registry | the supervisor (later work) |
| Decision answer becomes a command | `contextual_decisions` (PR #406, unmerged) |
| Act-mode PAT bound to a mandate | `Mandate` |

In scope here:

1. **Approval delegation** — a changeset is approvable by anyone who holds the
   floor, not only by its creator. §2.
2. **Supersession + inbox discipline** — a plan whose outcome already exists is
   `superseded`, not `stale`; the pending list is capped and ranked. §3.
3. **Onboarding playbooks** — L2 cookbooks that sequence existing commands. §4.
4. **Review surface** — the new status and the assignment. §5.

**Invariant that does not change, and must not:** an agent proposes, a human
approves. Approval always consumes a browser session; no agent surface can mint
a confirmation. This change widens *which* human may approve. It does **not**
require a different human than the proposer — that would break the shipped
in-app flow, where a person runs the agent and applies its output.

Migration `0079_changeset_delegation.sql` and the `schema.sql` change are
already written (assigned_to_user_id + the `superseded` status). Do not
re-create them.

## 1. Shared vocabulary

`ChangesetStatus` gains `superseded`. Every producer/consumer of the status
union must admit it: `sync-worker/src/external/types.ts` (`CHANGESET_STATUSES`
in `store.ts`), the SPA status helper, and any status filter validation.

| Status | Meaning | Health |
|---|---|---|
| `stale` | Preconditions drifted; the plan no longer describes reality | unhealthy |
| `superseded` | The plan's end-state already exists — a person did the work | **healthy** |
| `expired` | TTL passed; nobody acted | unhealthy |

Never merge `superseded` into `stale` or `expired` counts.

## 2. Approval delegation (owner: auth-worker stream; sync-worker mirrors)

### 2.1 Authority rule

Replace the creator-identity gate at
`auth-worker/src/routes/changeset-approvals.ts` (three sites: view ~:260,
approve ~:305, reject ~:383) with:

> The caller may view/approve/reject a changeset when their **live project role**
> is at or above the changeset's **required floor** — the same floor the plan was
> staged against (`max` over its commands, from `requiredRoleForCommand` /
> per-key settings floors).

Notes:
- The creator normally satisfies this, because prepare enforced the same floor.
  A creator whose role has since dropped loses approval rights. That is correct
  and is the reason for a live check rather than a stored one.
- Compute the floor from the stored `commands`, not from a new column. The floor
  function is the single source of truth and must not be duplicated.
- 403 on floor failure, 404 when the changeset belongs to another project
  (preserve the existing IDOR behaviour and its test).

### 2.2 Assignment

`POST /api/v2/changesets/:id/assign` — body `{ userId: string | null }`.

- Floor: PROJECT_LEAD (500), matching assignment semantics elsewhere.
- The assignee **must be a live member of the changeset's project**; otherwise
  `validation_failed`. (PR #406 records the absence of this check on its own
  assign path as a follow-up; do not repeat the gap here.)
- Assignment **never changes status**. A staged changeset with an assignee is
  still `staged`. Passing `null` clears the assignment.
- The approval payload gains `assignedToUserId` so the card can render it.

### 2.3 Sync-worker session routes

`sync-worker/src/external/session-routes.ts` gates list/get/commit/discard on
`created_by_user_id === token user`. Widen the same way: role floor at or above
the changeset's required floor. Commit still consumes an unconsumed ask-mode
confirmation — that gate is unchanged.

## 3. Supersession and inbox discipline (owner: sync-worker stream)

### 3.1 The predicate

New pure module `sync-worker/src/external/supersede.ts`:

```ts
/** True when the plan's intended end-state ALREADY holds in live state. */
export function isPlanSatisfied(commands: Command[], live: LiveState): boolean
```

Deterministic only — **code answers what code can answer** (CLAUDE.md Rule 5).
No model call. Per kind:

| Command | Satisfied when |
|---|---|
| `SetTranslation` | the live target value for that (cell, lane) already equals `value` |
| `PatchSettings` | every op's key already equals the proposed value (deep-equal) |
| `EmitEvents` | every event's end-state already holds where it is cleanly checkable (waiver row exists, validator row exists, comment resolved) |
| `PlanImport` / `CreateProject` / `LinkMedia` | **never** — creation is not safely idempotent by inspection; return `false` |

Any kind, or any single event, that cannot be checked cleanly returns `false`.
A plan is satisfied only when **every** command is satisfied. Guessing here
would silently discard a real plan, so the bias is always toward `false`.

### 3.2 Where it runs

At commit, on precondition drift only — before the existing `plan_stale` exit:

- If `isPlanSatisfied` → store status `superseded`.
- Else → store status `stale` (today's behaviour).

**The wire error stays `plan_stale` in both cases.** The external error-code
contract is frozen; only the stored status and the accounting differ. Add the
resulting status to the changeset response so a client can tell them apart.

A periodic sweep of staged rows belongs to the job substrate, which is not built
yet. Do not add a timer here.

### 3.3 Inbox cap and rank

`GET /api/v1/changesets/:projectId`:

- Rank staged rows by **blast radius** descending — the total effect count from
  the stored summary (translations + source cells + events + settings keys),
  tie-broken by `created_at` descending.
- Surface `3` by default (`SURFACED_CAP`). Report the rest as
  `heldCount`, never as rows. A caller may pass `limit` to page the full list;
  the cap applies to the default view only.
- Held rows stay `staged` — held, not closed — so a later supersession sweep can
  still close them.
- Echo the cap as `surfacedCap` alongside `heldCount`. A client must be able to
  say what it is showing without hard-coding the server's number, and a client
  talking to a pre-P1 worker must be able to tell "nothing was held" (both
  fields absent → surface everything, hold nothing) from "3 were held".

Known limit, accepted for P1: the SQL scans a fixed `LIST_CHANGESETS_MAX` (50)
window BEFORE the per-row role filter runs, because the floor is computed from
each row's stored commands and cannot be pushed into the WHERE clause. In a
project with more than 50 changesets, a low-role caller can therefore see fewer
plans than are actually visible to them. Widening this needs either a stored
floor column or a cursor that pages until the visible page fills — neither is
worth it before a list surface exists.

## 4. Onboarding playbooks (owner: auth-worker stream)

New `docs` tool topics — L2 prose only. **No new agent tools, no new commands.**
Each playbook names real commands in order and states the gotchas.

| Topic | Content |
|---|---|
| `playbooks/project-bootstrap` | upload artifact → `PlanImport` → `PatchSettings` (lanes, languages) → termbase seed → brief proposal → invite/assign via `EmitEvents`. Ends at "readiness has no blocking gaps". |
| `playbooks/qa-sweep` | `read` filtered to drafted/flagged → `search` for the term → stage `EmitEvents` waives and a validation queue → note that validations are testimony tier and are confirmed one at a time. |
| `playbooks/first-cycle` | the honest first run: draft ONE passage, show the gaps, fill them, re-run the same passage. States plainly that drafting at zero readiness produces fluent generic output, which is the costly kind. |

Each topic must state the human gate: the agent stages, the person applies.

## 5. Review surface (owner: SPA stream)

- Add `superseded` to the status helper with its own label and variant. It is a
  neutral/positive outcome, not an error: "Already done by hand".
- Show the assignee on the card when present, and show the held count on any
  pending list.
- The legacy PlanImport timeline rendering stays untouched.

## 6. Guardrails

- TypeScript, no `any`; hand validation (no zod); files ≤ ~500 lines.
- Per-package tests: `cd sync-worker && npm test`, `cd auth-worker && npm test`,
  root `pnpm test` for the SPA.
- **No new Playwright smoke specs** — agent journeys live in the expensive
  `*.spec.ts` suite.
- External REST/MCP error codes and response shapes are frozen.
- Record the AGENTS.md #16 test-impact analysis in the final report.
