# The seam: readiness, mandate, and decisions (2026-08-15)

**What this is.** The contract between two projects that are being built separately:

1. **Org-oriented onboarding** — get a new organization from signup to a project an agent
   can run, agent-first, without a configuration marathon.
2. **Agent as project orchestrator** — promote autopilot from a per-passage graph loop to
   a supervised routine that decides what to do next, records why, and escalates rarely.

They are separable to build and useless apart. Onboarding without the orchestrator is a
faster tour of a manual product; the orchestrator without onboarding is a good feature the
customer meets on day 40. This document pins only the shared interface, plus an inventory
of what already exists so neither implementation plan rebuilds it.

**Status.** Design approved in conversation 2026-08-15. Implementation plans not yet
written. Sequencing in §9.

---

## 1. Problem

Aquilla's enterprise motion (the 90-Day Agentic Translation Rollout) sells a claim:
*your teams run 5–10× more projects, at higher and more consistent quality, without
5–10× the staff.* The product today asks a new organization to configure its way to that
claim — an 8-step wizard ([`OnboardingWizard.tsx`](../../../src/components/onboarding/OnboardingWizard.tsx))
that terminates at an empty project, followed by a setup checklist covering AI providers,
models, instructions, and imports.

Meanwhile the thing that would demonstrate the claim — the contextual run engine — is
reachable only by finding an inspector panel inside a project that is already configured.

There is a second, sharper problem. `computeContextReadiness`
([`readiness.ts`](../../../auth-worker/src/lib/contextual/readiness.ts)) already documents
the failure mode that a naive "instant demo" would walk straight into:

> autopilot with no brief, no terminology and no validated examples produces *fluent,
> confident, generic* output — the most costly kind, because nothing about it looks wrong
> until a consultant reads it.

A brand-new organization has zero of all three. So the standard PLG move — draft something
impressive in the first ten seconds — is guaranteed to produce the worst output the system
can make, at the moment of maximum scrutiny, for a buyer whose stated objection is that
they cannot put their name on black-box AI output.

**The reframe this design is built on:** for this buyer the aha is not *"a translation
appeared."* It is *"it knew what it didn't know."* That is a claim only a system with
construal, verifiers, and a quorum can make, and Aquilla already has all three.

---

## 2. Decisions (user-approved)

1. **Design the shared seam first**, then plan each side against a fixed interface.
2. **Orchestrator bar is "full routine"** as defined in
   [`SELF-DRIVING-ROUTINES.md`](../../SELF-DRIVING-ROUTINES.md) §0: a trigger you don't
   have to notice, an action it can take alone, a verification the action worked, a written
   record, and escalation on <10% of runs. Plus the two non-negotiables — a gate on
   anything irreversible, and a per-routine kill switch flippable without a deploy.
3. **Onboarding forks by role early**, and each role gets a different primary surface —
   not three different products (§5).
4. **Autopilot becomes the main project surface**, with project progress integrated rather
   than living on a separate screen (§6).
5. **The agent may research its own knowledge gaps** and propose additions to the knowledge
   base, gated by human approval (§4.3).
6. **Org URL scanning during onboarding is acceptable** and will be visible and skippable.
   Rationale (user): it surfaces the org's current translation philosophy, security-sensitive
   users will skip it, and the lookup is attributable to us from our own servers. Noted
   against [`OPSEC.md`](../../OPSEC.md) D3, which treats "which language is being worked on
   and by whom" as the sensitive linkage; this decision accepts that exposure for
   *prospective* orgs at signup and does not change how project data is handled.

---

## 3. Non-goals

- **Not** changing what readiness *gates*. Readiness deliberately blocks nobody from
  pressing play; that stays true. Only unattended routines gain a gate, and the gate is
  Mandate, not Readiness.
- **Not** redesigning the run engine. Spans, closure, quorum, verifiers, and steering are
  the substrate; the supervisor sits above them.
- **Not** three onboarding flows. One flow, one set of objects, forking on which surface
  is primary and which readiness items are pre-filled.
- **Not** billing or credit enforcement. Mandate carries a budget because runs already
  meter units; whether that budget is money is out of scope here.

---

## 4. The seam: three objects

### 4.1 Readiness — *does it know enough?*

**Exists.** `ContextReadiness` is computed in
[`readiness.ts`](../../../auth-worker/src/lib/contextual/readiness.ts), returned by
`GET /:projectId/contextual/overview`
([`contextual.ts:778`](../../../auth-worker/src/routes/contextual.ts:778)), mirrored
client-side at [`transport.ts:267`](../../../src/lib/contextual/transport.ts:267), and
rendered inside `AutopilotActivityInspector`.

Five items — `terminology`, `brief`, `examples`, `rules`, `languages` — each with a
`level` (`ready` | `partial` | `missing`), a plain-language `detail` stating what it changes
about the output, and an `href` to go fix it. Three of them (terminology, brief, examples)
count toward `blockingGaps` because they change the *wording*.

**Its new jobs in this design:**

- **Onboarding's success criterion.** Onboarding stops terminating at "you have a project"
  and terminates at `blockingGaps === 0` plus a granted mandate. This is the single
  most important consequence of this document.
- **The feature-flex surface.** Each unfilled item already carries a concrete stated cost.
  That is a better upgrade argument than a feature grid, because the user can fill three
  items, re-run the same passage, and watch the output change.
- **A target the agent can raise itself** (§4.3).

**Extensions required:**

| Change | Why |
|---|---|
| Compute readiness for a project with no run history | Onboarding needs it before any run exists. Today it is only assembled on the overview endpoint's run-bearing path. |
| Add per-item `filledBy: "human" \| "agent-proposed" \| "imported"` | The ledger must distinguish what the team decided from what the agent proposed, and human edits are already protected from agent overwrite (§4.3). |
| A cheap per-project `autopilotReady` boolean on the projects list | The manager surface (§5) shows a small not-ready icon per project — no aggregate score, no ranking. **Cost constraint:** `computeContextReadiness` needs a full `ProjectContext` (concepts, brief, rules — `project-context.ts` is ~400 lines), so computing it per row is an N+1. This needs a denormalized flag on the project row or one narrow batch query, refreshed when terminology / brief / validated-example counts change. |

`blockingGaps` semantics do **not** change. Adding items to the blocking set later is a
product decision, not a refactor.

### 4.2 Mandate — *may it act, how far, and who catches it?*

**New. Small.** This is the object that gates unattended running, so that Readiness can
keep its stated design intent of gating nothing.

```ts
export interface Mandate {
  projectId: string
  /** Off by default. Flippable without a deploy — the per-routine kill switch. */
  enabled: boolean
  /** Ships in "record" and is promoted to "act" after it has been right.
   *  Mirrors the credits layer's enforce=false default. */
  mode: "record" | "act"
  /** What wakes it up. A routine's trigger must not be "when I remember to check." */
  trigger:
    | { kind: "schedule"; cron: string }
    | { kind: "on-import" }
    | { kind: "on-approval"; of: "decision" | "memory" }
  /** Ceiling per CYCLE (§4.4: 4 weeks, billing-aligned). Exhaustion is
   *  reported, never silently truncated — the same contract RunBudget honours. */
  budget: { unitsPerCycle: number }
  /** Pacing per WAKE (§4.4: one supervisor wake-up). */
  pacing: { maxSpansPerWake: number }
  /** What it may do alone vs. what must be asked. Staged drafts are already
   *  gated by the changeset approval flow; this governs the tier above. */
  authority: {
    /** May segment and draft without asking. */
    draft: boolean
    /** May spend budget researching a gap and propose a memory (§4.3). */
    research: boolean
    /** May re-run passages whose context changed under them. */
    refresh: boolean
  }
  /** Who receives a Decision Required card. Falls back to project leads. */
  escalateTo: { userIds: number[] } | { role: "project_lead" | "maintainer" }
  /** Measured, not aspirational. Surfaced next to the mandate itself (§4.4). */
  observed: {
    wakes: number
    wakesEscalated: number
    decisionsRaised: number
    decisionsDismissed: number
  }
}
```

**Rules:**

- A **human-initiated** run needs no mandate. Pressing play stays exactly as it is today.
- A **supervised** run needs readiness to be honest with the operator, but is not blocked.
- An **unattended routine** needs `enabled && mode === "act"` and a non-zero budget.
- **Two metrics, measuring two different failures** (§4.4). `wakesEscalated / wakes` is the
  doctrine's <10% bar — how *often* it interrupts. `decisionsDismissed / decisionsRaised`
  is the quality of those interruptions: a card dismissed without action was make-work by
  definition. The second is the one that catches "it suggests ten things and half need
  ignoring, and the decision to ignore is still load on the user."
- **Accounting rules for those metrics**, so neither can be gamed by a status change:
  - **Routing counts as nothing.** An assigned decision is still open (§4.3), so it neither
    raises nor lowers the dismissal rate until someone actually answers it.
  - **Expired counts as neither.** A decision that ages out was not answered and was not
    judged make-work, so it is excluded from both the numerator and the denominator of the
    dismissal rate. It is worth reporting on its own — a rising expiry count means questions
    are being asked of people who are not there.
- **The "Autopilot Routines" chips** (the Cursor quick-action pattern) are scoped mandates.
  Switching one on grants a specific standing authority; switching it off is the kill
  switch. This is how the feature gets flexed without a settings screen.

### 4.3 Decision — *the agent → user channel*

**New, and the highest-value single piece in this design.** Today
[`ContextualSteering.tsx`](../../../src/components/contextual/ContextualSteering.tsx) is
user → agent only: a free-text direction is queued and consumed on the next passage. There
is no channel in the other direction, so silver-path exhaustion is a dead stop.

```ts
export interface Decision {
  id: string
  projectId: string
  runId: string | null
  /** Where in the work this arose — the card must be answerable in context. */
  anchor: { fileId: string; spanId: string | null; cellIds: string[] }
  /** WHY the agent cannot proceed alone, in the user's words.
   *  e.g. "Two prior renderings of this name conflict; picking one changes
   *  every later passage." Not "review this." */
  reason: string
  /** Which readiness item this gap belongs to, when it maps to one. */
  readinessItem?: "terminology" | "brief" | "examples" | "rules" | "languages"
  status: "open" | "researching" | "resolved" | "dismissed" | "expired"
  /** Routing is an ASSIGNMENT, not a resolution — see below. A decision with an
   *  assignee is still `open`. Absent means "whoever gets to it first." */
  assignedTo?: { userId?: number; inviteId?: string }
  resolution?: DecisionResolution
}

export type DecisionResolution =
  /** Someone answered it. Feeds back as steering and, where it is a durable
   *  fact, as a memory proposal. */
  | { kind: "answered"; answer: string; byUserId: number }
  /** The agent spent budget researching and proposed a memory (requires
   *  mandate.authority.research). */
  | { kind: "researched"; memoryProposalId: string }
```

**Two resolutions and one assignment.** A decision closes exactly two ways: a human
**answers** it, or the agent **researches** it into a memory proposal. **Routing does not
close anything** — it names who is expected to answer, and the decision stays `open` until
someone does. If the assignee never shows up, anyone else who joins can still take it, and
it ages out through the `expired` path like any other unanswered decision.

This is the honest model: routing does not make an interruption go away, it moves who is
interrupted. Treating it as a resolution would let the escalation metrics report a queue of
unanswered questions as handled work.

**Routing is the invite trigger.** When a project runner hits a terminology decision they
personally cannot settle, the card offers to route it to a language expert — and the
invite carries the decision as its context, so the expert lands on the question that needed
them rather than on an empty project. Invites already carry context; see
[`2026-07-02-invite-experience-design.md`](../../specs/2026-07-02-invite-experience-design.md) §A.
This is the manager's aha, produced from felt need rather than from a setup screen.

**Research closes the readiness loop.** `mandate.authority.research` lets the supervisor
spend budget on a gap and call `proposeAgentMemory`
([`memory-api.ts`](../../../src/lib/agent/memory-api.ts)) — which already implements
propose → `reviewAgentMemory` (approve/reject), with `HumanEditProtectedError`,
`BriefHumanOnlyError`, and `SupersedesHumanEditedError` guaranteeing the agent can never
overwrite a human decision. Gap observed → research → proposal → human approves →
readiness rises → next cycle drafts better. **The approval surface exists; only the trigger
is new.**

**Sources of decisions already exist in the engine.** `Construal.openQuestions` and
`AmbiguityEntry` ([`types.ts:104`](../../../auth-worker/src/lib/contextual/types.ts:104))
are literally "questions the scene leaves open on purpose," and `ClosureExit` distinguishes
`model-closed` and `fixpoint` from `window-exhausted`, `budget`, and `unparseable`. A
supervisor promoting the right subset of these into Decisions is doing selection, not
invention. **Selectivity is the whole game** — the failure mode is ten cards the user must
mentally discard, which is why the escalation rate is measured on the mandate.

### 4.4 Time units: cycle vs. wake

Two words, because one number is a spending ceiling and the other is a quality bar, and
they run on different clocks.

| Term | Length | Carries |
|---|---|---|
| **Cycle** | 4 weeks, aligned to the planned billing period (usage is already tracked weekly, so 4 weeks is a clean rollup) | `budget.unitsPerCycle` |
| **Wake** | One supervisor wake-up, processing a wave of spans | `pacing.maxSpansPerWake`; the escalation-rate denominator |

**Why they must not be the same word.** The routine doctrine's bar is "escalates on <10% of
runs." Measured per *cycle*, a supervisor could raise 200 decision cards inside one 4-week
period and still score 0% escalation — the metric goes inert exactly where it is supposed
to bite. Measured per *wake*, it means what it says.

### 4.5 Run status state machine

The engine already has **two orthogonal axes**, and they stay orthogonal:

- **Span phase** — `reading → drafting → checking → staging`, documented at
  [`types.ts:196`](../../../auth-worker/src/lib/contextual/types.ts:196) as *"live UI only —
  never a control signal,"* with every phase potentially terminal. Per-span progress.
- **Run status** — the control axis, on `contextual_runs.status`.

The supervisor does **not** get a third state machine. Its one new state, `waiting`, belongs
on the run-status axis.

```
                  ┌──────────────────────────────────────┐
                  ▼                                      │
  (start) ──► running ──► pausing ──► paused ────────────┤ resume
               │  ▲ │                                    │
     no work   │  │ │  blocking decision raised          │
     left      │  │ └────────► waiting ──────────────────┘ decision resolved
               │  │                 │                      (mandate on-approval)
               ▼  │ cursor has      │ unanswered > N days
            parked┘ work left       ▼
               │                  parked
               ▼
        done │ failed │ terminated     (terminal; terminate reachable from any state)
```

| Status | Meaning | Exists? |
|---|---|---|
| `running` | A driver holds it; ticks execute | Yes |
| `pausing` | Pause requested; confirms at the next tick boundary | Yes |
| `paused` | Human paused it; resumes on human action | Yes |
| `parked` | **Nothing left to do.** Stays live so drafts remain reviewable | Yes |
| `waiting` | **Something left to do, but it needs a human.** Blocked on an open Decision | **New** |
| `done` / `failed` / `terminated` | Terminal | Yes |

**The distinction that matters:** `parked` means nothing left to do; `waiting` means
something left to do that needs a person. Both are idle; only one is blocked. Conflating
them is how a blocked run silently looks finished.

**`waiting` is safe to add.** `claimStrandedRuns`
([`contextual-runs.ts:1726`](../../../db/shared/contextual-runs.ts:1726)) adopts only
`status = 'running' OR (status = 'parked' AND the cursor has remaining work)`. Because the
predicate names statuses explicitly, a `waiting` run is not adopted, so it cannot be
re-ticked in a loop while it waits. **Nothing may add `waiting` to that predicate.**

**`waiting → running`** is the mandate's `{ kind: "on-approval"; of: "decision" }` trigger —
no new mechanism. **`waiting → parked`** on timeout, so an unanswered decision releases the
lease and leaves drafts reviewable rather than failing the run. Timeout length is open (§11).

---

## 5. Role segmentation

Today [`IntentStep.tsx`](../../../src/components/onboarding/steps/IntentStep.tsx) forks
personal vs. team. The permission layer already carries real role levels and a
`termbaseEditMinRole` floor
([`project-settings.ts:144`](../../../auth-worker/src/routes/project-settings.ts:144)),
mirrored client-side for the agent apply gate in
[`role-floors.ts`](../../../src/lib/agent/role-floors.ts).

The fork becomes three roles, each with a different **primary surface** and a different
**aha** — but the same three objects underneath.

| Role | Aha to engineer for | Primary surface | Readiness items onboarding pre-fills |
|---|---|---|---|
| **Does the work** (translator) | "it drafts like me" | Editor, with readiness and the same-passage re-run loop | languages; examples via a real validate-eight step |
| **Runs a project** (operator) | "it runs itself and tells me what it decided" | Ledger + mandate | brief and terminology from org sources; examples routed out |
| **Manages a team** (manager) | "I can see where everything stands and who's blocked" | Progress + routed decisions across projects | none directly; sees the per-project not-ready icon (§4.1) |

**The eight-approved-examples floor is unavoidable and should be used.** `MIN_EXAMPLES = 8`
is the threshold below which the performer is imitating almost nothing. A brand-new org has
zero, and no onboarding cleverness manufactures them. So the translator path includes a
real "validate these eight" step, and the operator path routes that work to someone via a
Decision. Making the user *teach* the system is a stronger aha than watching it guess, and
it produces the examples the next cycle needs.

---

## 6. Autopilot as the main surface

**This is a merge of three components that already exist**, all in `src/components/org/`
and `src/components/contextual/`. The design work is information architecture; the
machinery is built. Each component's fate must be stated so nobody rebuilds one:

| Component | Today | Becomes |
|---|---|---|
| [`ProjectOverview.tsx`](../../../src/components/org/ProjectOverview.tsx) | Manager-facing progress: per-file rollups, deadline-vs-progress status ([:173](../../../src/components/org/ProjectOverview.tsx:173)), CSV export | The **progress region** of the unified surface. Keeps its own logic. |
| [`ProjectAutopilotPanel.tsx`](../../../src/components/org/ProjectAutopilotPanel.tsx) | Run controls | The **mandate region**: routines, budget, kill switch, escalation rate |
| [`AutopilotActivityInspector.tsx`](../../../src/components/contextual/AutopilotActivityInspector.tsx) | Inspector reached from the panel | The **ledger region**, promoted to primary |

Progress and health stay **separate axes** and must not be blended: `src/lib/progress/*`
answers "how much is done," `src/lib/health/decay-engine.ts` answers "how good is it," and
AD-14 explicitly keeps rules and checks out of the health number. The unified surface shows
all three side by side; it does not invent a composite score.

### The ledger records decisions, not just events

The renderer is largely built — `EventTimeline`, `eventKindLabel`, `SceneBriefEvidence`
(the agent's construal shown as evidence), `activityLog`, and `redactedDetails` (activity
details are already scrubbed before display, which matters given OPSEC D3). What is missing
is the *content*: today's entries are state transitions (`steering_queued`, phase changes,
draft counts).

A ledger entry must answer **what it decided and why**, e.g. *"Researched 'Sanhedrin'
before drafting passage 4 — no approved rendering, and it appears in six later passages."*
The supervisor tier produces these lines; `appendContextualRunEvent` already persists
arbitrary run events, so this is a new event kind plus its label, not new plumbing.

Ledger columns follow the routine doctrine's `routine_runs` shape — **observed / acted /
verified** — because the verified column is the half that makes it a routine rather than a
cron job with a good story.

---

## 7. Onboarding's target state

Onboarding's job is now stated precisely: **produce the inputs readiness measures, then
grant a mandate, then show the first cycle.** Concretely, its terminal state is
`blockingGaps === 0` and `mandate.enabled`.

Sequence, role-forked per §5:

1. **Role** — replaces the binary personal/team fork with the three roles.
2. **Source material** — the honest URL-to-aha for this product is *give me a document you
   want translated*, not *give me your website*. Coded importers where they exist, agent
   importer where they don't.
3. **Org inference** (visible, skippable, per §2.6) — scan the org's public material for
   translation philosophy, audience, and register; pre-fill **brief proposals**, never
   approved brief content. `proposeBriefUpdate` already exists and `BriefHumanOnlyError`
   already guarantees a human owns the brief.
4. **The first cycle, shown honestly** — run the real pipeline on one real passage and show
   the work: the construal, the verifier votes, the quorum verdict, and the gaps it hit.
   This is the aha. It is differentiated precisely because a generic AI tool cannot produce
   it, and it is the visual proof of "pipeline, not prompts."
5. **Fill the gaps, re-run the same passage** — the feature flex. Watching the same passage
   improve after three readiness items are filled is the upgrade argument.
6. **Route what they cannot fill** — the first Decision, the first invite, the manager aha.

**What must not happen:** drafting three passages in the background during personalization.
At zero readiness that output is fluent, confident, and generic by construction (§1), which
confirms rather than dissolves the enterprise objection.

---

## 8. Already built — do not rebuild

| Capability | Where | State |
|---|---|---|
| Durable resumable run engine (span cursor, pause/park/terminate, steering consumption) | [`tick.ts`](../../../auth-worker/src/lib/contextual/tick.ts) | Complete |
| Per-span graph: construe → summarize → draft → lint → route → verify → quorum → redraft → stage | [`pipeline.ts`](../../../auth-worker/src/lib/contextual/pipeline.ts) | Complete |
| Budget threading with explicit no-silent-truncation on exhaustion | `RunBudget`, `pipeline.ts` | Complete |
| Context readiness checklist | [`readiness.ts`](../../../auth-worker/src/lib/contextual/readiness.ts) | Complete; needs §4.1 extensions |
| Activity ledger renderer, construal-as-evidence, detail redaction | [`AutopilotActivityInspector.tsx`](../../../src/components/contextual/AutopilotActivityInspector.tsx) | Renderer built; needs decision-shaped content |
| Run event persistence | `appendContextualRunEvent` | Complete |
| User → agent steering | [`ContextualSteering.tsx`](../../../src/components/contextual/ContextualSteering.tsx) | Complete |
| Agent memory propose/review, human-edit protection | [`memory-api.ts`](../../../src/lib/agent/memory-api.ts) | Complete; needs a trigger |
| Brief propose/review, human-only brief ownership | `proposeBriefUpdate`, `BriefHumanOnlyError` | Complete |
| Staged changesets with human approval gate | `auth-worker/src/routes/changeset-approvals.ts` | Complete |
| Progress rollups, deadline status, CSV | `src/lib/progress/*`, `ProjectOverview.tsx` | Complete |
| Health/decay as a separate axis | `src/lib/health/decay-engine.ts` | Complete |
| Role floors, termbase edit floor | `role-floors.ts`, `project-settings.ts` | Complete |
| Context-carrying invites | [invite spec](../../specs/2026-07-02-invite-experience-design.md) §A | Complete |
| Scheduled-job substrate with run log, idempotency, kill switch | — | **Missing.** [`SELF-DRIVING-ROUTINES.md`](../../SELF-DRIVING-ROUTINES.md) §2 specs it; only one bare cron exists today (`auth-worker/src/index.ts:369`, `crons = ["*/5 * * * *"]`). The unattended trigger depends on it. |

---

## 9. Sequencing

The dependency that decides order: **the routine trigger needs the scheduled-job substrate
that does not exist yet**, and everything else does not.

1. **Decision object + agent→user channel.** Highest value, no new infrastructure. Turns
   silver-path exhaustion into a product surface and makes escalation measurable. Ships
   useful on human-initiated runs alone.
2. **Ledger records decisions; surface merge.** Makes the work visible. Mostly IA.
3. **Mandate + record-mode supervisor.** Supervisor decides and records without acting
   unattended. Escalation rate becomes observable *before* anything runs on a schedule.
4. **Routine substrate + act mode.** Promote to unattended only after the escalation rate
   has been under the bar. This is the doctrine's own record-then-act promotion rule.

Onboarding can be planned against §4 and §7 in parallel with step 1, since it consumes the
objects rather than the supervisor.

---

## 10. Testing notes

Per [`AGENTS.md`](../../../AGENTS.md), worker tests run per-package and the root suite
excludes worker packages.

- **Readiness extensions** — unit tests alongside the existing
  `computeContextReadiness` cases in `auth-worker/src/__tests__/contextual-project-context.test.ts`.
  The run-history-free path needs its own case.
- **Mandate** — the meaningful tests are authority-boundary tests: a supervisor with
  `research: false` must never call `proposeAgentMemory`; `mode: "record"` must never stage.
  These encode *why* the gate exists, not just that a flag is read.
- **Decision** — the two resolutions, plus the assignment case: a routed decision must still
  read as `open`, and a second user must be able to answer one assigned to someone else.
  The accounting rules in §4.2 want tests of their own — routing must not move the
  dismissal rate, and an expired decision must leave it unchanged in both terms. These
  encode *why* the metrics exist: a supervisor whose queue of unanswered questions reported
  as handled work would pass the <10% bar while failing the user completely.
- **Run status** — the `waiting` transitions from §4.5, and one regression test asserting
  `claimStrandedRuns` does **not** adopt a `waiting` run. That test encodes why the status
  exists: without it, a run blocked on a human gets re-adopted and re-ticked, burning budget
  while achieving nothing.
- **E2E** — one journey per role from §5, ending at `blockingGaps === 0`. Note the
  single-stack constraint in `e2e/JOURNEYS.md` and the seeded-project helper.

---

## 11. Open questions

1. **Who owns a mandate?** Project-scoped as written. An org-level default that projects
   inherit is plausible but adds an inheritance model; deferred until a second project
   needs it.
2. **How long until an unanswered decision expires?** §4.5 decays `waiting → parked` so the
   lease is released and drafts stay reviewable. The *duration* is still a product call;
   how it is counted is settled (§4.2: neither answered nor dismissed).

**Resolved 2026-08-15:**

- *What is a cycle?* → §4.4. Cycle is 4 weeks (billing-aligned); the escalation denominator
  is the **wake**, a separate unit, because a 4-week denominator makes the <10% bar inert.
- *Does `parked` become the resting state?* → No. §4.5 keeps `parked` as "nothing left to
  do" and adds `waiting` for "blocked on a human." `claimStrandedRuns` already excludes
  anything not named in its predicate, so the addition is safe.
- *Org-scope readiness aggregation?* → No aggregation. A per-project not-ready icon, with
  the N+1 cost constraint noted in §4.1.
- *Does a routed decision re-open if the invitee never accepts?* → The question dissolves:
  routing never closed it. §4.3 makes routing an assignment, so the decision stays `open`
  and anyone who joins can answer it.
- *How is a timed-out decision counted?* → Neither answered nor dismissed (§4.2), reported
  on its own as an expiry count.
