# Aquilla as a Self-Driving Business — the Routine Doctrine

**What this is:** a design for running Aquilla's *business* the way the product runs
translation — as closed loops with an approval gate, not as a to-do list. Companion to
[MARKETING-OPERATING-SYSTEM.md](./MARKETING-OPERATING-SYSTEM.md) (which governs the
distribution routines below) and [AGENT-API.md](./AGENT-API.md) (the agent substrate).

Everything here is grounded in what's actually in this repo and in the last 30 days of
PostHog data. Where a routine is blocked on something we haven't built, it says so.

---

## 0. What counts as a routine

> **A routine is a loop that closes without you. An alert is a loop that opens on you.**

Most "automation" is alerting with extra steps: it notices something and hands you a
new task. That is a net negative — it adds work and removes the excuse of not knowing.
A routine must have all five:

1. **A trigger you don't have to notice.** Schedule, webhook, or threshold — never "when
   I remember to check."
2. **An action it can take alone.** Not a recommendation. A PR, an email, an invoice, a
   fixture, a suspended account.
3. **A verification the action worked.** The loop re-reads reality after acting. A routine
   that fires and never checks is a cron job with a good story.
4. **A written record.** One row per run: what fired, what it did, what it saw afterward.
5. **A rare escalation.** If it escalates on the median run, it isn't a routine — it's a
   queue with your name on it. Target: escalates on <10% of runs.

Plus two non-negotiables borrowed from the product's own architecture:

- **A gate for anything irreversible or outward-facing.** The agent already writes
  *staged changesets with a human approval gate* rather than direct commits
  (`auth-worker/src/routes/changeset-approvals.ts`). Business routines inherit that rule:
  money, public publishing, and account suspension are staged, not applied.
- **A kill switch, per routine, flippable without a deploy.** The credits layer already
  models this correctly (`creditEnforce = false` by default — record and display before
  you enforce). Every routine ships in record-only mode and gets promoted to acting mode
  after it has been right for two weeks.

**The honesty test for each routine below:** if its normal output is a report for a
human, it is a newsletter, not an employee.

---

## 1. Where we actually stand (the numbers that shape the plan)

Last 30 days, PostHog project `Aquilla` (401628):

| Step | Users | Events |
|---|---|---|
| Pageview | 168 | 2,035 |
| Signed up | 14 | 16 |
| Logged in | 34 | 79 |
| Project created | 15 | 32 |
| Import started | 30 | 144 |
| Import succeeded | 25 | 70 |
| Import failed | 4 | 7 |
| First cell commit | 33 | 116 |
| First cell validate | 21 | 89 |
| AI translation completed | 29 | 389 |
| File exported | 8 | 17 |
| **`$exception`** | **42** | **3,012** |

Three facts fall straight out of that table, and they set the whole sequencing:

1. **Exceptions outnumber every real product action combined.** 3,012 exceptions across 42
   users against ~800 meaningful product events. One issue — `Error: send was called
   before connect`, 1,979 events across 7 users — is almost certainly the WS reconciler
   (`src/lib/sync/ws-reconciler.ts`) posting to a socket that isn't open yet. This is the
   single loudest signal in the business and nothing is closing on it.
2. **The funnel leaks hardest at the end, not the start.** 33 users make a first commit;
   8 export a file. People get in and start working, then don't finish. Whatever
   "finished" means for a translation team, we are not measuring it, so no routine can
   close on it.
3. **There is no revenue loop to automate.** No Stripe, no billing, no invoice — the
   entitlement layer is an explicit stub that grants every paid feature to everyone
   (`src/lib/entitlements/entitlements.ts`). Credits are recorded but `enforce=false` and
   `showToOrg` is gated.

**Consequence, stated plainly:** at 16 signups/month, most classic "self-driving business"
routines (lead scoring, pricing experiments, churn-risk models, SDR sequences) would be
automating a business that doesn't have the volume to feed them. The routines that pay
off *now* are the ones that convert **product pain into product fixes** and **usage into
money**. The rest are staged behind volume thresholds, named explicitly in §9.

This is also exactly what the marketing doctrine already concluded from the other
direction: *"fix the ten-second magic moment first, then open the volume taps."*
The routine plan and the marketing plan agree on the ordering, which is a good sign.

---

## 2. The substrate we're missing (build this first — it's small)

There is precisely **one** scheduled job in the entire platform today: auth-worker's
`scheduled()` handler flushing dirty Monday board links every 5 minutes
(`auth-worker/src/index.ts:352`, `wrangler.toml` `crons = ["*/5 * * * *"]`). It's a fine
pattern and it works — but it is a bare cron with no run log, no idempotency key, no
retry policy, no dead-letter, and no kill switch. Every routine written against that
shape will one day fail silently for a month and nobody will know.

**Before routine #1, build the routine substrate.** It is roughly one table, one queue,
and one dispatcher:

```sql
CREATE TABLE routine_runs (
  id            TEXT PRIMARY KEY,          -- UUIDv7, doubles as idempotency key
  routine       TEXT NOT NULL,             -- 'import-failure-closer'
  trigger_key   TEXT NOT NULL,             -- natural key: dedupes re-fires
  mode          TEXT NOT NULL,             -- 'record' | 'act'
  status        TEXT NOT NULL,             -- 'running'|'ok'|'escalated'|'failed'|'dead'
  started_at    TIMESTAMPTZ NOT NULL,
  finished_at   TIMESTAMPTZ,
  observed      JSONB,                     -- what it saw
  acted         JSONB,                     -- what it did (PR url, invoice id, email id)
  verified      JSONB,                     -- what it saw AFTER acting  ← the closing half
  attempts      INTEGER NOT NULL DEFAULT 1,
  UNIQUE (routine, trigger_key)
);
```

- **Queue:** Cloudflare Queues, not more crons. Cron *enqueues candidate work*; a consumer
  executes with retries and a dead-letter queue. This separates "did we notice?" from
  "did we finish?", which is the distinction the current Monday cron can't make.
- **Kill switch:** `routine_config` rows (or `org_settings`-style JSON) holding
  `{ enabled, mode, maxPerRun, escalateAfter }`. Flippable from the admin surface that
  already exists (`auth-worker/src/routes/admin.ts` — `/overview`, `/credits/orgs`,
  `/activity`).
- **The `verified` column is the whole point.** It is what makes these routines rather
  than crons, and it is what lets us measure "escalation rate" and promote a routine from
  `record` to `act` on evidence.

Cost estimate: a few days. Everything in §3–§8 is cheap once it exists and expensive
forever if it doesn't.

---

## 3. Tier 0 — Product-integrity routines (start here)

These are the ones that behave most like a good employee: they take a recurring,
well-defined problem off the desk permanently.

### R1 — Error-budget closer
- **Trigger:** PostHog `$error_tracking_issue_created` / `$error_tracking_issue_spiking`,
  or a nightly sweep of issues above a rate floor.
- **Action:** agent pulls the stack + session recording + affected user count, reproduces
  against the e2e harness, writes a failing test, opens a PR on a branch. For an allowlist
  of file paths only; everything else files a triage-ready Linear issue instead.
- **Gate:** CI green + human merge. Never auto-merge product code.
- **Verify:** 7 days after merge, the issue's event rate is zero.
- **Metric:** exceptions per weekly-active user. Today: ~18. That is the number to drive down.
- **Seams that already exist:** PostHog MCP, Linear MCP, GitHub MCP, `e2e/`, the `/issue`
  and `/swarm` skills, `docs/QA-*`.
- **First target, hand-picked:** `send was called before connect` (1,979 / 7 users) and
  `undefined is not an object (evaluating 'e.createdBy.username')` (24 / 2 users).

### R2 — Import-failure closer *(the highest-value mechanical loop we have)*
- **Trigger:** `import failed` or `import collision detected` event.
- **Action:** fetch the source blob from R2, run the parser (`src/lib/parsers/*`) headless.
  If it reproduces, commit the file as a redacted fixture plus a failing test and open a PR.
  If it doesn't reproduce, escalate with the diff between local and production behavior.
- **Why this one first:** parsers are **pure functions over a file**. The failure is
  perfectly reproducible, the fix is testable, and the customer's pain becomes a permanent
  regression test with no human in the loop until PR review. That is the exact shape of a
  loop that closes.
- **Verify:** re-run the original import; it succeeds.
- **Metric:** import success rate (today 25/30 users ≈ 83%). Target 98%.
- **Compliance note:** source texts may be unpublished scripture drafts. Fixtures need a
  redaction step and an opt-out — see R13.

### R3 — Activation-funnel guard
- **Trigger:** daily, control-chart on each step conversion of the funnel in §1.
- **Action:** when a step falls outside its band, pull the 5 most recent session recordings
  at that step, diff the deploys since the break, and either (a) open a Linear issue with
  the diagnosis and the suspect commit range, or (b) if the break correlates 1:1 with a
  deploy, open a revert PR.
- **Verify:** conversion returns to band within 72h.
- **Metric:** 24h activation rate (already the GTM plan's own metric — reuse it, don't
  invent a second one).
- **Blocked on:** a defined "activated" event. `file exported` is the current proxy and
  it's weak. **Decide what a finished unit of work is and emit an event for it.** Nothing
  downstream — pricing, retention, expansion — can be automated until this exists.

### R4 — Nightly fidelity eval *(where engineering and marketing are the same artifact)*
- **Trigger:** nightly, plus on any PR touching prompts, model routing, or parsers.
- **Action:** run the frozen conformance corpus, score round-trip fidelity, write results
  to PostHog as `$ai_evaluation` / `$ai_metric`, and **fail the PR** on regression beyond
  tolerance.
- **The leverage:** the marketing doctrine already commits us to shipping an *Open Fidelity
  Conformance Suite* (MARKETING-OPERATING-SYSTEM §2). That suite and our internal eval
  harness are the same object. Build it once, and every nightly run simultaneously (a)
  gates model changes, (b) generates the Engine-1 fidelity note, and (c) generates the
  Engine-2 "what we found and what it can't do yet" Short. One routine, three outputs,
  and the cross-derivation rule in §4 of the doctrine becomes automatic instead of
  aspirational.
- **Currently missing entirely:** we send **zero** `$ai_generation` events to PostHog.
  We meter cost in our own `org_credit_usage_daily` but have no traces and no quality
  signal at all. We are flying with a fuel gauge and no altimeter.

---

## 4. Tier 1 — The money loops (all blocked on one integration)

The credits design (`docs/superpowers/specs/2026-06-13-org-credits-cost-model.md`) is
genuinely well built: it stores **raw provider cost** and derives credits on read, so
markup and caps can be re-tuned retroactively. That is exactly right for a company still
discovering its price. What's missing is the terminal end of the loop.

### R5 — Meter → invoice → dunning closer
- **Blocked on:** a billing provider. This is the single highest-leverage unlock in the
  document, because it converts R6, R7, and R8 from reports into loops that close.
- **Loop:** monthly close per org → rollup `org_credit_usage_daily` → invoice → charge →
  on failure, dunning sequence → on final failure, downgrade to the free field tier (never
  hard-lock a translation team out of their own text — see R14) → exception queue for
  anything anomalous.
- **Gate:** first N invoices per org staged for human review; auto-send after clean runs.
- **Verify:** every org with usage has exactly one invoice; every invoice reconciles to
  the underlying rows.

### R6 — Margin watchdog
- **Trigger:** daily, per org and per rail (`llm` / `agent` / `tts`).
- **Action:** compute realized gross margin from actual `raw_cost_cents` against what the
  org is actually paying. When an org's effective markup drops below floor — the classic
  case is a heavy `agent`-rail user on a flat plan, which the spec itself calls "the
  dangerous rail" — either auto-tighten their cap (staged) or flag the account for a plan
  conversation with a pre-written summary of *their* usage shape.
- **Verify:** margin returns above floor, or a plan change is recorded.
- **This is the "money model improvements based on data" ask, made mechanical.** You
  already store the one number most companies don't: true per-request infra cost.

### R7 — Model-routing optimizer
- **Trigger:** weekly, fed by R4 (quality) and the credits table (cost).
- **Action:** for each task type, compute cost-per-accepted-output across candidate models.
  When a cheaper model is within tolerance on the conformance corpus, open a PR changing
  the router default; when a model degrades, open a PR pinning away from it.
- **Gate:** human merge, always. Model swaps change output quality for real users.
- **Verify:** blended cost/unit falls, conformance score holds.

### R8 — Willingness-to-pay observation *(explicitly NOT an experiment)*
- At 16 signups/month, a pricing A/B test would need years to reach significance. **Do not
  run pricing experiments yet.** Instead: cluster orgs by *usage shape* (rails used,
  volume, seat count, whether they hit caps) and have the routine surface the natural
  packaging boundaries the data already shows. Promote to a real PostHog experiment at
  ~100 signups/month, not before.

---

## 5. Tier 2 — Customer loops

### R9 — Onboarding state-machine nudges
- **Substrate exists:** transactional email via Cloudflare Email Service
  (`auth-worker/src/services/email.ts`).
- **Loop:** per org, a state machine — signed up, no project (24h) → project, no import
  (48h) → import, no commit (72h) → committing, no invite (7d). Each message is generated
  from *their* actual project state (name the file they imported, the book they're in),
  not a template blast. The routine stops the moment the state advances.
- **Gate:** hard cap of 4 lifetime nudges per org, unsubscribe honored, and a rails check
  so nothing in an outbound email makes a capability claim that violates the
  load-bearing-limitation rule (MARKETING-OPERATING-SYSTEM §3.1).
- **Verify:** state advanced within 72h of send. Measure lift against a holdout.
- **Metric:** 24h activation (same metric as R3 — deliberately).

### R10 — Weekly project digest (agentic account management)
- **Loop:** weekly per active project, an agent reads the health/completion/rules rollups
  (`src/lib/health`, `src/lib/completion`, `src/lib/rules`) and writes a short digest:
  what moved, what's stalled, the three cells most worth attention this week.
- **Delivered:** in-app card + optional email.
- **Note:** `src/lib/brief/` is the *translation* brief (purpose, audience, register) —
  not a status digest. This is new surface, but it composes from subsystems that all exist.
- **Why it matters:** this is account management performed by a schedule. It's the routine
  that most resembles hiring someone, and it scales to a thousand projects at the cost of
  one.
- **Verify:** digest open/click, and whether the flagged cells actually got touched.

### R11 — Support triage
- **Blocked on:** a support inbox with an API. Today `support@aquilla.app` is a Cloudflare
  Email Routing address with no ticketing behind it — there is nothing for a routine to
  read.
- **Loop:** classify (bug / how-to / billing / feature) → *how-to* answers from docs and
  links the recorded walkthrough (the `record-docs-video` skill already produces these) →
  *bug* opens a Linear issue pre-loaded with the user's project state and recent
  exceptions → *billing* and ambiguous cases escalate.
- **Metric:** % of tickets closed with no human touch. Target 60% within two quarters.

---

## 6. Tier 3 — Distribution routines (already specced, not yet triggered)

`docs/GTM-DISTRIBUTION-PLAN.md` §5 and MARKETING-OPERATING-SYSTEM §4 describe the content
machine in detail, and the `distribution-cycle`, `record-docs-video`, and
`record-promo-video` skills implement the asset production. What's missing is the
**trigger and the queue** — the routine part.

### R12 — Ship → announce closer
- **Trigger:** merge to `main` of a PR labeled `story:`.
- **Action:** drive the Showcase harness against the real app, produce the walkthrough +
  docs page + Short + in-app card, and place them in the batch-approval queue.
- **Gate:** the doctrine's split queue — pure-UI walkthroughs get batch approval; anything
  transcript-derived or carrying a quality/fidelity number takes full human approve.
- **Verify:** published within the fast-lane SLA; if not, escalate the *queue*, not the asset.

### R13 — Doctrine invariant checks *(turn the promises into assertions)*
The marketing OS already names three things it calls "watched metrics." Make them
machine-checked, because a watched metric nobody implemented is a slogan:

1. **Cross-derivation:** every Engine-1 source emitted ≥1 Engine-2 artifact, and vice
   versa, within the week. Fail loudly when it didn't.
2. **Limitation appearance-rate:** the share of published assets carrying a tagged
   load-bearing limitation stays above floor. This is the tripwire §3.3 explicitly asks for.
3. **Pricing-boundary consistency:** no published asset makes a "free" claim that
   contradicts the canonical pricing fact. Especially once R5 exists — the day billing
   ships is the day this check earns its keep.

---

## 7. Tier 4 — Compliance routines

For a product handling **unpublished scripture drafts in minority languages, for
institutional partners, largely in the Global South**, compliance isn't overhead — it's
the thing that makes a consultant or a funder able to say yes. Treat it as product.

### R14 — Data-rights closer (export & deletion)
- **Loop:** a DSAR or deletion request → assemble the subject's data across Postgres, R2
  snapshots, and PostHog → produce the export → execute deletion → verify by re-querying
  every store.
- **The hard design question to answer *before* someone asks:** we are built on an
  **append-only event log** (AD-2). Deletion in an append-only store is not a `DELETE`.
  Decide now, in writing, between (a) tombstone + payload redaction, keeping the chain
  intact, or (b) hard delete with projection rebuild. Option (a) is almost certainly right
  and needs the redaction path built. Until that's settled, no deletion routine can exist,
  and the answer to a deletion request is manual and slow.

### R15 — Access review
- **Loop:** monthly — PATs (`auth-worker/src/routes/credentials.ts`) and member-scopes
  unused past a threshold get auto-expired with prior notice; platform-admin elevations
  (`/elevation/request`, `/elevation/verify`) get rolled into a monthly attestation the
  routine files and closes itself.
- **Verify:** zero credentials older than policy remain active.

### R16 — Sovereignty Covenant enforcement
The marketing doctrine makes public, structural promises: the field side stays free, and a
project can opt out of contributing to the global TM. Right now
`src/lib/entitlements/entitlements.ts` is a stub granting every paid feature to everyone,
and the opt-out is a settings blob. **A promise made publicly deserves a test.** The
routine asserts, continuously, that (a) no field-tier org is billed, and (b)
`contributeToGlobalTm: false` is honored at the actual TM ingestion path, not just in the UI.
Fail the build on violation. This is the mechanical version of "we stop *calling* it
irreversible until it *is*."

### R17 — Subprocessor & model-provenance register
We route through OpenRouter to many providers, and `src/lib/usage/record-usage.ts` already
records `byProvider`. Keep a generated register of which providers processed which org's
text. Then "who has seen our translation?" is a query with an answer, not a scramble
mid-deal. Cheap now, extremely expensive to reconstruct later.

### R18 — Consent integrity
`src/lib/analytics-consent.ts` stores consent in `localStorage` and **defaults to enabled**
when no choice has been recorded. That's defensible for product analytics today, but it
is per-device, not per-identity, and it won't survive a GDPR-serious partner review.
Routine: assert that no analytics event exists for a user who opted out on any device.
Fixing the underlying model (server-side consent record on the user row) is a prerequisite.

---

## 8. Agentic AI and multimodal — what's already modern, and the four gaps

**Already in place, and genuinely current:** a tools-only MCP server
(`sync-worker/src/external/mcp-*.ts`), PAT credentials scoped org/project, self-describing
discovery, a changeset engine with a **human apply gate**, artifacts, agent memory, and a
container-backed Durable Object for sandboxed code execution
(`agent-worker/`, `docs/AGENT-SANDBOX.md`). Most companies asking "how do we do agentic AI"
do not have this. The gaps are narrower and more specific:

1. **Evals, as a routine rather than a project.** Covered in R4. This is the biggest gap
   and it's not close — we have zero quality telemetry on the core value proposition.
2. **Skills over tools.** The MCP surface is tools; the repo's own `vertical-agent` skill
   argues for an L1/L2/L3 context hierarchy. Rarely-needed tool knowledge should move to
   on-demand skills so the agent stays accurate as the surface grows. Every tool added to
   the always-loaded set costs accuracy on the tasks that matter most.
3. **Durable long-running agents.** The agent-worker DO is the right substrate for
   hours-long work (draft a whole book, migrate a legacy corpus). The missing piece is
   resumability and a progress surface the user can leave and come back to.
4. **Cost/quality routing** — R7, which needs R4 to exist first.

**Multimodal — what we have and the loops it enables.** TTS (Modal, Kokoro/Gemini),
diarization (pyannote), voice conversion, video subtitles, IDML export
(`infra/modal/`, `src/lib/audio/`, `src/lib/diarization/`, `src/lib/idml/`). Two of these
close cleanly as routines:

- **Audio QA loop.** TTS output → ASR back-transcribe → compare against the source cell →
  flag drift above threshold. Fully mechanical, no human in the loop, and it catches the
  failure mode nobody hears until a listener does.
- **Layout regression loop.** Render IDML/PDF exports and image-diff against golden
  renders. `idml export blocked` is already an event we emit; nothing closes on it.
- **The strategic one — oral-first.** Many target communities are oral-first. A loop that
  takes a recorded oral draft → ASR → alignment → cells, and returns text → TTS →
  listen-check, is simultaneously a product feature and a routine. Most of the parts exist.

---

## 9. Sequencing, and what stays behind a volume gate

**Now (weeks 1–3)**
1. Routine substrate — `routine_runs`, a queue, the kill switch (§2).
2. R2 import-failure closer, R1 error-budget closer. Both in `record` mode first.
3. Define and emit the **"activated" event** — everything downstream depends on it.
4. Start sending `$ai_generation` to PostHog. One afternoon, unblocks R4/R7.

**Next (month 2)**
5. R4 nightly fidelity eval / conformance corpus — the one artifact that pays twice.
6. R3 activation guard, R9 onboarding nudges, R10 weekly digest.
7. R16 covenant assertions (cheap, and it's a promise already made in public).

**Then (month 3+, and the real unlock)**
8. Billing integration → R5, R6, R7.
9. Support inbox with an API → R11.
10. R12/R13 distribution triggers — *after* the magic-moment path is clean, per the
    doctrine's own sequencing concession.
11. R14 data-rights, R15 access review, R17 provenance — pull these forward the moment a
    named institutional partner enters the pipeline. They're cheap to build early and
    deal-blocking to build late.

**Explicitly gated behind volume — do not build yet:**
- Pricing experiments (need ~100 signups/month; today: 16).
- Churn-prediction models (need churn events; we don't reliably have retention data).
- Lead scoring / automated outbound (Engine 1 is 1:1 relationship work and automating it
  destroys the exact asset it's meant to build).

---

## 10. What must never become a routine

- **Anything addressed to a consultant, a funder, or a partner institution.** Engine 1 is
  a trust engine; automated warmth is the fastest way to burn it.
- **Any published quality or fidelity number** without a human approve. The doctrine
  already says this; it holds double when the number is generated by the system being
  measured.
- **Pricing changes.** A routine may *propose* a price; a human sets it.
- **Hard-locking a translation team out of their own text.** A failed payment downgrades
  capability; it never holds work hostage. This is a product-values line, and it should be
  a test (R16), not a norm.

---

## The three sentences worth remembering

1. **Build the substrate before the routines** — a run log with a `verified` column is the
   difference between an employee and a cron job that lies to you.
2. **The two loops to close first are the two the data is screaming about:** exceptions
   outnumber real product events 4:1, and imports fail for 1 in 6 users — both are
   perfectly mechanical loops with reproducible failures and testable fixes.
3. **Billing is the keystone** — without a terminal that closes on money, half of these
   routines can only ever produce reports, and the conformance eval is the keystone's twin:
   it's the only artifact that gates our model changes *and* buys our credibility.
