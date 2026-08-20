# Addendum: the oversight seam meets the command registry (2026-08-18)

**What this is.** A design addendum that binds two things built separately:

1. **The oversight seam** — readiness, mandate, and decision. Designed in
   `2026-08-15-agent-onboarding-seam-design.md`; its first slice (the decision
   channel) is PR #406, unmerged at the time of writing. That document arrives
   with the PR, so the link dangles until it lands.
2. **The command registry** — one command vocabulary and one staging/commit
   engine for the in-app agent and the external Agent API. Shipped as
   `docs/COMMAND-REGISTRY.md` (P0), extended by `docs/COMMAND-REGISTRY-P1.md`.

**The thesis.** These are the two halves of one oversight system. The seam is the
control plane: it decides *whether* an agent may act, *how far*, and *who is
asked* when it cannot decide alone. The registry is the write plane: it decides
*what* an action is, *what role it requires*, *how it is reviewed*, and *what
record it leaves*. Built apart, they will grow two vocabularies for one
permission model, and enterprise buyers will meet both.

This document pins the decisions that connect them. It changes no code. The
unblocked half is already implemented in P1; each decision below states what
blocks it.

## A. Mandate authority is a grant over catalog tiers

The seam gives a mandate three booleans: `draft`, `research`, `refresh`. The
registry already carries a finer, tested authority model: command kind × tier ×
role floor, with `agentReachable: false` for kinds no agent may ever reach.

**Decision.** Express a mandate's authority as a grant over tiers, not as three
flags:

| Tier | Under a mandate with `mode: "act"` |
|---|---|
| `prepared` | may commit without a person |
| `structural` | always stages for approval |
| `testimony` | never grantable — a person confirms each item |
| `governance` | never grantable — `agentReachable: false` in code |

Unattended writes then flow through prepare/commit exactly as attended ones do,
with `mandateId` stamped into the provenance envelope beside the existing
`human_authority`, `channel`, and `autonomy_mode`. The mandate inherits the
digest, the receipt, the idempotent commit, and the audit trail at no cost; the
registry gains the answer to "who authorised this unattended action."

*Blocked on:* the `Mandate` object. Nothing to build until it exists.

## B. One list of what needs a person

The product will have four review surfaces: changesets, decisions, memory
proposals, and validation items. Only the decision surface was designed with a
cap, a rank, and dismissal accounting.

**Decision.** One inbox per project, and one set of accounting rules across all
four. The seam's rules generalise without change: cap what is surfaced, rank by
blast radius, hold the remainder rather than closing it, and keep the healthy
"already handled" outcome distinct from the unhealthy "nobody acted" one.

A changeset has the same three outcomes as a decision, and P1 already separates
them: `superseded` (a person did the work by hand — healthy) versus `stale`
(preconditions drifted some other way) versus `expired` (the TTL passed —
unhealthy). Do not let a later metric merge them.

*Partly shipped:* the changeset half is in P1 — delegation, cap, rank, and the
`superseded` status. *Blocked on #406:* merging the decision surface into the
same list, and the cross-project manager view.

## C. The supervisor writes through the registry

**Decision.** When the supervisor acts alone — drafts, redrafts, consistency
sweeps, research that becomes a memory proposal — it emits registered commands
with a supervisor provenance channel, not bespoke writes.

The ledger's *observed / acted / verified* columns then link to real receipts.
"Researched 'Sanhedrin' before drafting passage 4" stops being prose about work
and starts being a line with the receipt of what changed attached. That pairing
is the audit story an enterprise buyer is actually asking for.

*Blocked on:* the supervisor.

## D. A decision answer may become a command

A decision closes today as free text (`answered`) or as a memory proposal
(`researched`).

**Decision.** For decisions that map to a readiness item, offer a third,
structured path: the answer pre-fills a staged command — a terminology answer
becomes a termbase command, a brief answer becomes a brief proposal.

Two things follow for free. The deterministic supersession sweep sees the fix
immediately, because the fix is a real write rather than a sentence. And the
command's role floor applies: answering a terminology decision is a policy write
at the termbase floor, even though answering a decision is otherwise a
CONTRIBUTOR-level act. Without this, the floor is bypassed by the answer box.

*Blocked on #406.*

## E. Onboarding is a sequence of playbooks over commands

The seam's onboarding target — reach zero blocking readiness gaps, then grant a
mandate — maps one-to-one onto commands that already exist:

| Onboarding step | Command |
|---|---|
| Source material | `PlanImport` |
| Organisation inference | brief proposal (never approved brief content) |
| Fill the gaps | termbase and `PatchSettings` commands |
| Validate eight examples | `EmitEvents`, testimony tier, confirmed per item |
| Route what they cannot fill | decision plus a context-carrying invite |

**Decision.** Build onboarding as playbooks (L2 cookbooks) over the registry, so
each step ends in a reviewable changeset. A day-one user then gets the same
audit trail as a day-ninety user, and the flow is drivable conversationally by
the agent rather than only by clicking a wizard.

**Corollary.** Derive readiness's planned `filledBy: human | agent-proposed |
imported` from the provenance the registry already stamps. Do not maintain a
second attribution field; two sources of truth for "who decided this" is exactly
the ambiguity the ledger exists to remove.

*Shipped in P1:* the first three playbooks, as docs topics. *Blocked on #406:*
the routing step.

## F. One job substrate, not two

The seam needs a scheduled-job substrate (run log, idempotency, kill switch) for
the unattended trigger; it is listed as the one missing capability. The registry
roadmap needs a job primitive for `RunImport`, `RunExport`, `RunChecks`,
`RunBatchDraft`, and the audio batches.

**Decision.** These are one system. A routine is a job with a recurring trigger;
a job is a routine that runs once, whose payload is a command. Build it once,
with the budget, pacing, metrics, and kill switch the mandate already defines.

*Blocked on:* nothing structural — but it is sequenced last, after the
escalation rate has been observed under the bar.

## G. An act-mode credential must reference a mandate

An act-mode PAT today is standing authority with no budget, no pacing, no kill
switch, and no observed metrics. The mandate defines all four.

**Decision.** Require an act-mode credential to reference a mandate. The
external surface then inherits the same governance envelope as the supervisor,
and the organisation gets one control that stops all unattended activity.

*Blocked on:* the `Mandate` object.

## H. One word for autonomy

Three vocabularies are now in play: `ask`/`act` on credentials, `record`/`act`
on mandates, and suggest/auto-apply on the in-app ladder.

**Decision.** Choose one set before a fourth appears. Recommended:
`observe` → `propose` → `act`, mapped onto the tier grant in §A, with the
existing `ask`/`act` credential values kept as wire-compatible aliases so the
frozen external contract does not move.

## I. Correction to an earlier recommendation

An earlier draft of this advice proposed a blanket rule that "the person who
proposes a change does not approve it." That is wrong here, and it is not
implemented. It would break the shipped in-app flow, where a person runs the
agent and applies its output.

The invariant that actually matters — and that already holds — is that **an
agent proposes and a human approves**: approval consumes a browser session, and
no agent surface can mint a confirmation. P1 widens *which* human may approve
(anyone at the command's role floor, optionally routed by assignment). It does
not require a different human than the proposer.

## J. Notes for the decision-channel PR

- **Migration number.** #406 ships `0076_contextual_decisions.sql`, but `0076`,
  `0077`, and `0078` are taken on `dev`, and `0079` is taken by the P1
  delegation migration. Renumber to `0080` before applying, or it will collide.
- The PR's own four follow-ups belong to the supervisor wiring task: the
  `waiting` status missing from five surfaces, the orphaned
  `blocked_on_decision_id` on terminated runs, the unvalidated assignee, and the
  unwritten `researched` path.
- **Assignee validation.** P1's changeset assign route validates that the
  assignee is a live project member. The decision assign path should adopt the
  same check rather than solving it twice.
- **Concurrent-decision cap.** The open question in the seam spec should start
  at three — the same number P1 uses for surfaced changesets — and rise only if
  held items are observed expiring rather than being superseded.

## K. Sequencing

The seam's own order stands. The additions slot in without reordering it:

| Step | Seam work | Addendum work |
|---|---|---|
| 1 | Decision channel (#406) | — |
| 2 | Ledger + surface merge | §B: merge the decision surface into the P1 inbox |
| 3 | Mandate + record-mode supervisor | §A tier grant; §C supervisor writes; §D decision-to-command |
| 4 | Routine substrate + act mode | §F one substrate; §G act-mode credentials |
| — | — | §E playbooks: already started, needs only the registry |
