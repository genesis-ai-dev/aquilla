# The Open Playbook — Build and Run an Agentic Translation Management System

**Working outline.** Target reader: a technical lead at a translation organization
(Bible translation, localization, media/subtitling) who is deciding whether to build,
buy, or fork — and who will be personally accountable when a translator loses a day's
work at 2am in a place with bad internet.

This is a *practitioner's* playbook, not a marketing artifact. Its entire credibility
rests on being specific about what broke.

---

## 0. The EEAT contract (read this before writing a single chapter)

The playbook's authority comes from four things, and every chapter has to carry them
or it gets cut:

| Signal | How we earn it | Anti-pattern to avoid |
|---|---|---|
| **Experience** | Dated incidents with file paths, error strings, and the commit that fixed them. "On 2026-06-10 an audit found `MAX(server_seq)+1` computed inside the transaction was silently dropping one of two concurrent event rows." | "Event sourcing can have race conditions." |
| **Expertise** | Named decisions *with the rejected alternative and why*. Every ADR states what it costs. | Listing technologies used. |
| **Authoritativeness** | Real numbers from a running system: token amplification per source word, rows read per book open, exception-to-action ratio, funnel counts. | Vendor-quoted benchmarks. |
| **Trust** | A standing "What we got wrong" section per chapter, kept honest even when it's embarrassing (the dev-login bypass that seeds users into whatever DB is bound; the password-reset link to a page that didn't exist). | A retro that only lists wins. |

**Structural rules for the whole document**

1. Every claim is labeled **FACT** (verifiable in the repo/telemetry, with a
   `file.ts:line` or a query) or **JUDGMENT** (reasoned inference). This convention is
   already used in this repo's audits and it is the single highest-leverage EEAT device.
2. Every chapter ends with **"Decisions you must make"** (a short list of forks with
   defaults), **"Gotchas"**, and **"How you'll know it's wrong in production"** (the
   observable symptom, not the theory).
3. Costs are given in *units the reader's CFO uses*: cost per 1,000 source words, not
   per million tokens.
4. Nothing is described as done unless it is. Maintain a live "not built yet" list
   inside the playbook itself — an honest gap list reads as more authoritative than a
   complete-looking feature table, and it is the thing readers actually verify.

---

## Part I — Should you build this at all?

### 1. The decision that precedes every technical one

- **What is your actual constraint?** Almost no org's constraint is "we can't type
  fast enough." It is usually: expert review capacity, format fidelity into a legacy
  desktop tool, or coordination across people on bad connections. Build against the
  real constraint or you build a nicer text editor.
- **Decision point: buy, fork, or build.** Buy if your formats are standard and your
  reviewers are colocated. Fork if you need one unusual format or an unusual review
  policy. Build only if the *governance* model — who may approve what, and what
  evidence they need — is the differentiator. That is what is genuinely hard to buy.
- **Gotcha: the incumbent's real moat is trust, not features.** In our market
  (SIL/UBS consultants + Paratext) the round-trip byte fidelity of one file format was
  worth more than every AI feature combined. Identify your equivalent before writing code.
- **The audience split that must never be averaged.** Credentialed experts are the
  *trust ballast* (a few hundred people, reached one-to-one). The volume users are a
  different population entirely (a Chromebook in Nairobi, a phone in Jakarta). Product
  decisions optimized for the average of those two serve neither.
- **What "web" actually changes**: not UX — eligibility. A desktop-only Windows tool
  is structurally incapable of serving the mass cohort. That single fact drove more of
  our architecture (offline outbox, thin client, tiny bundle) than any other.

### 2. Scoping v1 honestly

- Time-to-first-value target and how to measure it (ours: ~13 interactions, zero
  waiting, zero configuration, no API key required, no email verification wait).
- The counter-metric: our funnel showed 33 users reaching first commit and 8 reaching
  export. **People got in and started; they didn't finish.** If you only instrument
  activation you will optimize the half that already works.
- Decision: which persona's *day* you will complete end-to-end first. Half-completing
  three personas is the most common v1 failure.

---

## Part II — The domain model (get this wrong and nothing else matters)

### 3. Choosing the alignment unit

- **The cell is the unit of alignment, and it is never re-segmented below.** For
  scripture it's the verse; for subtitles the cue; for software strings the message.
  The entire downstream stack — back-translation, terminology checks, alignment,
  progress math — depends on stable source↔target correspondence.
- **Gotcha: structure is a *grouping over* cells, never a *split of* them.** Paragraph
  markers, poetry lines, and speaker turns are orthogonal metadata on the cell, not new
  cells. We wrote this down as a spec invariant because the pressure to "just split it"
  arrives every quarter and it is always wrong.
- **Multi-language targets: lanes, not projects.** One shared source, one independent
  target row/chain *per language tag*, registered in project settings. The alternative
  (a project per language) duplicates the source and desynchronizes it forever.
  Consequence to design for: staleness and concurrency checks must be lane-scoped, or
  editing Spanish will falsely invalidate a pending Portuguese plan.
- **Decision point: what is "done" for a cell?** Translated ≠ validated ≠ published.
  Pick three states max, define them once, server-side.

### 4. Format fidelity: the make-or-break chapter

- **The lesson: do not model the format. Preserve the bytes.** USFM 3.0 has ~150
  markers. Faithfully modeling all of them is a tar pit *and you will still lose to the
  incumbent on the long tail*. Instead: keep the original bytes canonical, have the
  parser only locate each unit's text span, and have the serializer walk the raw bytes
  swapping in replacements. Round-trip byte identity then holds **by construction**.
- Generalize the principle: **the parser's job is to find spans, not to own structure.**
  This applies to XLIFF, subtitle formats, DOCX, and IDML alike.
- **Gotchas that cost us real time:**
  - Markers that look like paragraph starts but mean the opposite (`\nb` = "no break" =
    *continuation*; including it in the paragraph-start set silently splits paragraphs).
  - Multi-member archives: zip bombs are a real ingestion surface. Cap entries, per-entry
    bytes, total bytes, and **compression ratio** — the ratio check is the one people skip.
  - Client-side DOM-bound parsers can't run in a Worker. If you want agents/servers to
    parse, you need a DOM-free text-parse core as a separate module from day one, or you
    will fork your parsers later.
  - Partial imports must produce a *durable, viewable report*. A toast that vanishes is
    the same as silent data loss to the person who has to explain it to a donor.
- **Test rule (non-negotiable):** every format needs coverage of *both* preparation and
  the complete commit path — parse → normalize → emit → source-artifact upload — for
  original text, original bytes, converted source, and container imports. A parser unit
  test plus a synthetic validator test does not cover their composition.

---

## Part III — Data architecture

### 5. Event sourcing: the decision and its bill

- **Decision:** append-only event log as the source of truth; `cells`/`files` are
  rebuildable projections. Chosen because the product's core promise is *"who did what,
  under whose authority, and why"* — attribution and history are the feature, not an
  audit checkbox.
- **What it buys you:** free history, compensating operations, agent provenance, and
  the ability to rebuild a corrupted read model.
- **What it costs you:** every read path is now a projection question; every write path
  needs an idempotency key; and *anything not event-backed becomes a second-class
  citizen you must be honest about* (our project creation/settings still write tables
  directly — we scoped the provenance promise to event-backed operations rather than
  overclaiming).
- **Parent chains and conflict policy.** Each event carries the prior winning event on
  the same `(project, file, cell)`.
  - Chain-mutating events: **first-write-wins**; a stale sibling gets a `409`, never a
    silent overwrite.
  - Plain commits: we chose **last-write-wins** for v1 single-editor reliability.
    Say out loud which one you picked and why — this is the single most consequential
    line in the whole system.
- **The bug to inoculate against (FACT, dated 2026-06-10):** computing `MAX(server_seq)+1`
  inside each transaction, combined with an unqualified `ON CONFLICT DO NOTHING`, means a
  concurrent commit's *log row* is dropped while its *projection* commits. `cells.event_id`
  then points at a non-existent event and a rebuild silently reverts real work. This is
  the ordinary two-user case, not an exotic one. **Fix shape:** serialize chain-mutating
  writes per project (a per-project sequence, or a partial unique index + compare-and-swap).
  One change closed the log corruption, the live/replay divergence, *and* the concurrent-batch
  retry storms.
- **Rule:** idempotency key = the event id (UUIDv7), and re-posting must be free. This is
  what makes bulk migrations from a legacy system re-runnable, which you will need more
  than once.

### 6. Datastore selection and the migration you will eventually do

- **Decision point: edge SQLite vs managed Postgres.** Edge SQLite (D1) is seductive for
  a Workers stack and has a **single-writer ceiling** that bulk imports and per-row
  aggregate recomputes hit immediately. Symptom to watch: `rows_read` growing
  super-linearly (O(N²)) on write-heavy or propagating-effect features — counters,
  health/decay, derived state.
- **The lesson that made our cutover cheap:** put a ~180-line **shim implementing the old
  DB's API over the new one**. Identical SQL runs in production and in tests, and ~80
  routes migrated without being touched. If you suspect you'll migrate, build the seam
  before you need it — it is a day of work and it saves a quarter.
- **Rules of thumb we now apply:** defer per-row aggregate recomputes to set-based;
  derive-on-read over materialize-on-write; delta by deterministic id.
- **Gotcha: reads are where the money goes, quietly.** Opening one Bible book was
  ~1.8–3.6M row reads, repeated on every window focus, because ~60 files each did a full
  re-read. The fix is a `?since=` delta read — design the cursor into the read API from
  the start, because retrofitting it means changing every consumer.

### 7. Reads: thin client, and the discipline to keep it thin

- **Decision:** read hooks fetch from the server on demand; no client-side replay of the
  write buffer over server reads. The outbox is a write buffer **only**. (Violating this
  produces the worst class of bug: the UI shows work the server never accepted.)
- **Transient projection gaps are real.** A just-accepted event can race a subsequent
  read. Use bounded, state-based retries for known-transient missing rows — and make
  exhaustion an **explicit error**, never a fallback to "empty project." An empty-state
  render on a read failure is how you convince a user their work is gone.
- Gotcha: if you adopt a data-fetching library, either use it or don't. Ours is installed
  and used by 3 of ~105 hook files, and the mixed idiom costs every new contributor a day.

---

## Part IV — Collaboration and offline

### 8. Offline-first without CRDTs

- **Decision: no CRDT/OT.** A durable IndexedDB outbox + parent-chain conflict resolution
  + per-cell focus locks covers the realistic field scenario (one editor per cell,
  intermittent connectivity) at a fraction of the complexity. Revisit only if you
  genuinely need character-level concurrent editing of the same cell.
- **Focus leases, not locks**: claim/renew/release with expiry through a per-project
  coordination object; peers see "X is editing." Leases must expire without a release
  (laptops close).
- **The outbox contract, spelled out** (each line here was a bug once):
  - A record is deleted only after the server accepts it.
  - Failed records stay visible and recoverable; after N attempts (ours: 5) they move to
    a `failed`/quarantine state instead of retrying forever.
  - Quarantined records must **not** drive the optimistic UI overlay — otherwise rejected
    text is shown to the user indefinitely as if it were saved.
  - Auth-rejected (401/403) records are quarantined *pending a fresh token*, not discarded.
- **The subtle one — a local-mutation clock (write fence).** When a server snapshot
  arrives, it must not clobber cells the user mutated *after that snapshot began*. Stamp
  every local mutation with a monotonic clock, record the clock when a fetch starts, and
  discard server rows for cells mutated since. Without this, fast typists lose keystrokes
  on every background refetch and it looks like flakiness, not a bug.
- **Realtime coordination object holds no durable state.** Presence, leases, broadcast
  relay — that's it. The moment it also owns durable data you have two sources of truth.
- **How you'll know it's wrong in production:** an exception like
  `send was called before connect` dominating your error volume (ours: 1,979 events
  across 7 users in 30 days) means the socket lifecycle and the send path disagree.

### 9. Permissions and roles

- **Decision:** a small role ladder (ours: 7 rungs) with **max-wins** resolution across
  direct membership, groups, org role, and creator. Max-wins is easy to explain and hard
  to get wrong; least-privilege-intersection is the opposite.
- **Server is authoritative, always.** Client-side gates exist only to (a) avoid a
  guaranteed-403 entering the durable outbox and (b) give a button an honest disabled
  reason.
- **Gotcha: mirrored constant tables drift.** We keep the client mirror of the role
  policy as *data derived from one file*, never a third hand-copied table — and enforce
  the perimeter with lint. If you have "client mirror" comments in more than one place,
  you already have a drift bug you haven't found yet.
- **The trust bug that matters most:** a read-only role receiving a fully editable
  editor whose writes die in a `console.warn`. Read-only must *look* read-only. Silent
  write failure destroys credibility faster than an outage.

---

## Part V — The AI layer

### 10. Cost: measure the amplification, not the rate card

- **The headline number to reproduce for your own pipeline:** raw text sent once is a
  fiction. Ours passes each passage through construe → summarize → draft → a
  three-verifier panel, each call re-carrying scene brief, rules, and register block.
  Measured on a 1,078-verse corpus: **~35 input and ~15 output tokens per source word —
  roughly 50× the raw text.** That multiplier, not the provider's price, determines margin.
- **Build a meter before you build features.** One row per model call *and per tool call*:
  surface, node label, span, tier, model, prompt/completion tokens, latency, ok/failed.
  - **Record failed calls.** A model that fails a parse and forces a retry costs twice;
    a success-only ledger hides it. Capacity rejections show up unmistakably as
    zero-token rows with ~50ms latency.
  - **Record raw tokens, not dollars.** Provider-reported cost is a vendor extension and
    is absent on self-hosted upstreams; tokens let you re-price a past run against a new
    rate card without re-running it.
  - Ship it **off by default** behind a flag so it can't touch a deployed environment.
- **Concurrency gotcha:** span concurrency is not request concurrency. A high-risk span
  fans out a 3-wide verifier panel, so N spans burst to ~3N requests. Against a
  fixed-slot host the surplus is rejected — and one rejected verifier can fail its whole
  span. **Contention destroys work rather than merely slowing it.** Cap in-flight requests
  client-side to the host's actual slot count (find it empirically).
- **Three silent-wrong-answer traps** worth a boxed callout: a model allowlist that
  rejects your test model with a 4xx you don't read; a dev harness that swaps in a mock
  when the API key is empty or `"mock"` (you measure the mock); and a model-swapping host
  that evicts your pinned model when a stray request asks for a second one.

### 11. Metering, credits, and not enraging your first customers

- **Decision: record before you enforce.** Ship the credits/quota layer with
  `enforce = false`, display-only, and promote to enforcing after it has been *right*
  for weeks. This applies to every limiter you will ever build.
- Define the unit in customer language: a credit = one cent of customer-facing price;
  cost × per-rail markup, rounded up. Separate rails (LLM / agent / TTS) because their
  economics differ by an order of magnitude.
- **Gotcha: an unmetered model proxy is an open wallet.** Any registered user, any model,
  no quota is a money and abuse hole that will be found. Gate it at the same time you
  expose it, even if the gate is generous.
- Honest-stub discipline: if entitlements grant everything to everyone today, say so in
  the code comment *and* in the playbook. Readers trust a documented stub; they do not
  forgive a discovered one.

### 12. Quality signals people can trust without reading the language

- The hard part of this product is not translating — it's giving a manager who **cannot
  read the target language** a number they can act on.
- **Decision: one metric, two framings.** Cell-scope "decay" (distance from a validated
  neighborhood) and file/project-scope "health" (`1 - mean(decay)`). One definition,
  two scopes, no composite of four sub-scores that nobody can reason about.
- **Keep rule/check violations a *sibling* surface, not an ingredient.** Folding
  everything into one number makes it uninterpretable and un-actionable.
- **Gotcha that broke our headline metric:** "Validated %" inflated because the
  per-project validation threshold (count × role floor × named users) was enforced on
  no server path — the projection flipped `validated` at COUNT ≥ 1. **Define "validated"
  once, server-side, threshold-aware**, and let all four surfaces read that one
  definition. Four surfaces that disagree about the same number is a trust event.
- Derive-on-read where you can; you avoid a backfill migration every time the policy changes.

---

## Part VI — The agentic layer (the actual subject of the book)

### 13. What makes an environment agent-ready

The useful frame: agents became productive in code when the environment offered five
things — a legible workspace, safe composable verbs, a verification loop, history with
attribution, and permission boundaries. Map your domain onto that table explicitly:

| Coding agent | Translation-system equivalent |
|---|---|
| read / grep | search cells, concordance, cell history |
| edit a file | a `SetTranslation` command → target-cell event |
| **run tests** | **rules/health/consistency checks with structured failures** |
| git log / blame | the append-only event log |
| plan mode / accept-edits | **ask mode / act mode** |
| project instructions | the project brief: glossary, style, audience |
| MCP servers | your system as a remote MCP server |

- **The most commonly missing row is "run tests."** Without a verification loop an agent
  can only *write*, never *finish*. Checks must return structured, actionable failures
  ("term 'covenant' rendered 3 ways: [refs]"), never a bare 400.

### 14. The command layer: never let agents write raw events

- **Decision:** external callers submit **stable domain commands**; the server validates
  permissions/invariants/preconditions and compiles them into canonical internal events.
  This makes provenance forgery and invariant bypass *structurally impossible* rather
  than merely prohibited, and it decouples your public contract from your internals.
- **One command layer, two adapters** (MCP for agents, REST for integrations). Neither
  may have capabilities the other lacks. Author the tool-shaped workflows first — the
  failure mode is a generic CRUD API with MCP bolted on.
- Binary transfer always via signed HTTP upload/download URLs, never inside protocol messages.

### 15. Changesets: the approval gate that makes autonomy safe

- **A changeset is an immutable execution plan**, not a bag of proposed writes:
  normalized commands (or an immutable manifest reference by digest), resource
  preconditions, resolved permissions, a **server-computed effect summary**, warnings and
  skipped items, a content digest, and an expiry.
- **The effect summary is computed by the server from the plan — never narrated by the
  agent.** The agent may phrase *around* the facts; it may not produce them. This one rule
  is the difference between a review gate and theater.
- **`409 plan_stale` over silent recompute.** If state changed between prepare and
  confirm, refuse. Never apply something other than what was approved.
- **Ask mode must be enforced, not requested.** A summary hash proves *which* plan was
  referenced, not that a human saw it. So: ask-mode credentials can prepare but *cannot*
  commit; confirmation requires a one-time approval assertion minted from an authenticated
  browser session, binding human identity + changeset digest + credential id + timestamp +
  expiry, consumed exactly once.
- **One pipeline for both modes**: `prepare → validate → resolve → summarize → (human
  approval | auto-confirm) → commit`. Act mode is the same machinery with confirmation
  auto-granted, so *every* agent action leaves a changeset record and a receipt.
- **Gotcha: commit must be crash-safe.** Prepare-time ids plus a `committing` status let a
  mid-commit retry resume without duplicating events or files.
- Scale gotcha: never inline tens of thousands of operations in one JSON value. Large
  imports reference an immutable manifest in object storage by digest; cap per-changeset
  operations (ours: 5,000 cells) and **list what was dropped** — silent truncation reads
  as "we covered everything."

### 16. Credentials, autonomy ceilings, and provenance

- Hashed, revocable, per-user credentials, scoped to org and/or project, carrying an
  **autonomy ceiling** (`ask` | `act`), expiry, last-used metadata, and rotation. A
  request may downgrade `act` to `ask`; nothing may upgrade.
- **Live role resolution on every call.** A credential never outlives or exceeds the
  user's current role. Invariant to print on the wall:
  **the agent can never exceed the credential, and the credential can never exceed the user.**
- **Server-stamped provenance envelope**, and be precise about what is verified vs merely
  recorded: human authority, channel, autonomy mode, changeset id, confirmation id are
  *stamped*; the agent's declared provider/model/run id is *testimony, not fact* — and the
  schema should say so.
- **Split the ledgers.** State-changing domain actions → the event log. Reads, searches,
  check runs, tool failures, discarded plans → a separate bounded-retention audit ledger.
  Forcing reads into the domain stream makes "the event log is the project's history"
  false and expensive.

### 17. Letting the agent run code (and why you eventually must)

- **The forcing function:** real orgs' uploads are messy in ways no fixed parser
  anticipates — merged header rows, delimiter drift, swapped source/target columns, mixed
  scripts, inconsistent transcripts. Fixed parsers plus "please clean your file first" is
  where adoption dies.
- **Decision: a capability ladder, not a free-for-all.**
  - Tier 0 — built-in deterministic parsers for known formats (no sandbox).
  - Tier 1 — small JS to inspect/reshape untrusted data ("is row 1 a real header or a
    merged title cell?").
  - Tier 2 — Python (pandas/lxml/chardet/etc.) for spreadsheets and encoding-ambiguous text.
- **Security model, stated as invariants:** no secrets ever enter the container — it gets
  code, explicitly pushed files, and returns stdout/stderr/a result. The harness *outside*
  the container is the only holder of the ephemeral credential.
- **The sandbox writes no project state.** It stores the upload under a temporary key,
  validates the normalized output, destroys the session, deletes the object — and the
  result then goes through the *ordinary* import preview and commit path. Originals,
  lanes, manifests, and bindings therefore use the same code path as every deterministic
  adapter. (Resist the shortcut here; it is the single biggest source of "agent imports
  behave differently" bugs.)
- **Mapping recipes are the real product object.** The agent authors a recipe once for a
  customer's weird JSON; thereafter it's deterministic, reusable, versionable, and the
  customer's second file of that shape imports with **zero agent judgment**. This is
  "the agent coordinates; deterministic primitives execute" made concrete.
- **Deployment gotcha:** a `127.0.0.1` sandbox URL in deployed config points at the
  *Worker runtime*, not your laptop. Sandboxing must be optional and degrade to a clear
  "unavailable" result, not a crash.

### 18. Agent memory and the project brief

- Memory that an agent writes unreviewed is a slow-motion corruption of your context.
  Gate it: the agent *proposes* memories and brief updates; a human accepts. Same
  approval philosophy as changesets, applied to context instead of content.
- The brief (glossary, style, audience, register) is the domain equivalent of a project
  instruction file — and it is the highest-ROI artifact in the whole system.

### 19. Cold start: the test almost nobody runs

- **The gate:** hand a fresh agent nothing but a base URL and a token. Can it discover
  what it may do, read state, stage work, and get it approved — with no human explaining
  the API?
- What we had to add after real agents failed it: an **unauthenticated discovery root**
  returning a machine-readable API map; a REST bootstrap pair (`/me`, `/projects`); JSON
  404s *with hints* on unmatched paths; teaching 401/405 messages; a `quickstart` inside
  the capabilities tool; and a single hand-to-your-agent quickstart doc.
- Error codes must be stable and machine-actionable (`permission_denied`, `scope_denied`,
  `plan_stale`, `confirmation_required`, `validation_failed`, `rate_limited`) and carry the
  data an agent needs to self-correct.

---

## Part VII — Security and operations for a *sensitive* domain

### 20. Threat model: it's the linkage, not the prose

- Rank assets by what a leak costs, not by volume. For us:
  1. **Signing keys** — root of the whole trust tree.
  2. **Unpublished drafts** — in restricted-access regions, *which* language and *by whom*
     is the sensitive part, not the text.
  3. **Translator identity + activity** — presence, focus locks, and `last_used_at` form a
     working-hours and collaboration graph. Combined with (2), it answers "who is
     translating what, and when" — the question that makes you a target rather than a
     curiosity. **Treat activity metadata as sensitive data, not telemetry.**
  4. Third-party credentials, bearer tokens in circulation, voice recordings
     (biometric-adjacent; a cloned voice is not revocable like a password), user-supplied
     vendor keys, session replays.
- Actors worth naming: opportunistic credential harvesters (highest likelihood, zero
  targeting cost), over-scoped insiders and agents (usually accident — the exposure is
  *breadth* of a PAT), phishers targeting maintainers (a console session equals every key
  in one step), and — lowest likelihood, highest impact — actors interested in (2)+(3).

### 21. The findings you should just pre-fix

Written as "here is our incident, go check yours":

- **A boolean that disables auth verification is a deploy away from catastrophe.** Ours
  (`ALLOW_UNAUTHENTICATED`) was guarded only by a comment, and was settable after the fact
  via a secret write no config review would catch. Fix: fail-closed guard keyed on the
  *environment label* (so previews are covered too), re-checked at the authorization
  decision point, not the entry point.
- **Dev bypasses seed data into whatever database is bound.** We initially believed the
  blast radius of a leaked dev-login route was "log in as a user that doesn't exist in
  prod." Wrong: it *seeds* those users with a known password first, then hands back a
  valid session. Audit every dev affordance for what it *creates*, not just what it grants.
- **Tokens in URL paths** (invite links) are the least protected place a bearer token can
  live — referrers, logs, chat previews, shoulders. Short expiry, single use, and a
  `Referrer-Policy` at minimum.
- **Never log a token, even on the failure path.** Ours reached the browser console on a
  failed revoke.
- **Security headers are not optional for an app full of one-click irreversible actions**
  (archive project, remove member, apply agent changeset). Framing protection, CSP,
  `nosniff`, HSTS, referrer policy — and know which layer actually serves your assets, or
  your headers cover a route nobody uses.
- **Session replay tooling exfiltrates drafts by design.** Masking inputs is not enough
  when the page body *is* the sensitive content. Decide deliberately; document it.
- Parallel security reviews will produce overlapping finding IDs and contradict each other
  about what's fixed. Maintain one consolidated status table or you will "fix" things twice
  and miss the ones that appear in only one series.

### 22. Testing: proportional gates that people actually run

- **Tier the suites by what a failure means**, and say so:
  - Unit/component for UI chrome, toggles, empty states.
  - Worker tests per package.
  - **Cross-layer smoke reserved for "product lies"**: a user can lose data, access, or a
    committed artifact; the assertion crosses at least two of SPA / identity / sync / DB /
    object storage / a second browser context; and no existing journey covers it. Ours is
    ~25 journeys with a <2 min budget. Everything else is a cheaper test.
  - Pre-push runs an *impact-derived* subset; the full smoke gate runs at merge/deploy.
- **Wait for state, never elapsed time.** Ban `waitForTimeout` and network-idle as
  readiness signals, and enforce the ban with a meta-test that runs as a prerequisite of
  every e2e command. Required assertions must not hide behind `.catch(() => false)`.
- **A retry is a diagnostic, not a pass.** Zero retries in the gating config.
- **Machine speed must never decide correctness.** Timeouts are stall watchdogs; making
  them shorter to "speed up feedback" converts a slow machine into a false failure.
- **Test across boundaries, not layer-by-layer.** When a shared type, payload, validation
  rule, or persistence shape changes, pass a real producer's output through its immediate
  consumer. And: **a regression needs a test at the level where it escaped** — if unit
  tests passed and smoke caught it, the smoke test is the deliverable.
- **Record the test-impact analysis in the change summary**: the contract touched, its
  producers and consumers, the test added, the exact commands run. Proximity is not evidence.

### 23. Deployment: make the wrong deploy impossible, not discouraged

- **Explicit named profiles for every environment; no inference from branch, hostname, or a
  missing profile.** All unnamed profiles resolve to local-only names, so a bare deploy
  command *cannot* reach production.
- Branch guards enforced in two places (the script and a build hook), plus a clean-worktree
  and HEAD-matches-remote check.
- **Deploy = upload a version → validate its exact id and bindings → promote → reapply
  routes → confirm 100% traffic → run a public verifier** that checks DNS/TLS, exact
  unauthenticated API contracts, and *the embedded API targets inside the shipped bundle*.
  That last check catches the classic "prod SPA pointing at dev API" outage.
- One machine-readable config file as the source for worker names, routes, buckets, and
  required bindings, with contract tests keeping every deploy file synchronized to it.
- Previews: route-free, always pointed at non-production APIs, never promoted.
- **The operational rule to print in bold: do not reset a database branch or clear a bucket
  to repair a routing problem.** Identify the version, profile, and bindings first, then
  reconcile data before anything destructive.
- Treat an environment change as **one atomic contract change** with a written checklist
  (ours has 9 items) — half-applied environment changes are the most expensive class of
  outage we've had.

### 24. Telemetry: the ratio that tells you the truth

- **The single most useful number we found: exceptions vs. meaningful product events.**
  Ours was ~3,000 exceptions across 42 users against ~800 real product actions in 30 days.
  Until that inverts, roadmap discussions are fiction.
- Prerequisites most prototypes skip and then regret: an error boundary, `window.onerror`
  and `unhandledrejection` handlers, exception telemetry, and a 404 route. A render throw
  or a stale lazy chunk after redeploy is otherwise a permanent white screen that nobody
  is ever told about.
- Instrument the *end* of the funnel (export/delivery), not just activation.
- Privacy constraint from §20: your analytics choices are a security decision in this domain.

---

## Part VIII — Running the organization

### 25. Building this *with* agents (the meta-layer readers will most want)

- **The pickup contract must be readable off the board, not off a label.** Ours: a triage
  status is the human queue (agents never pick from it); a `Todo` status means fully
  specified with acceptance criteria and no outstanding human decision — the only queue
  agents draw from. Everything else is drift.
- **Fix the code first, then reconcile the spec.** While fixing, your understanding of
  correct behavior changes; a spec edited before the fix documents the wrong thing.
  Record the *rule*, not the code change, and cite the issue.
- Verification gate: agents drive the real app themselves against a seeded local stack
  rather than handing the human a "please reload and click X." Provide the seeded stack
  and the one-URL login that makes this possible — it is the difference between agents
  that finish and agents that hand back homework.
- Parallel agent work needs isolation (worktrees), an integration branch, and promotion
  only on verified green. Merge conflicts and duplicated findings are the tax; budget for it.

### 26. Localizing the tool itself

- **The bottleneck is never string count — it's missing context.** "Save" translates
  differently as a button vs a menu item, by what it saves and how much room it has.
- Ship a catalog that carries its own context: per-key description, the surface it lives
  on, a screenshot where declared, and the semantics of every placeholder — with coverage
  enforced by a test so it can't rot.
- **The scaling lesson (measured, not guessed):** requiring hand-authored prose for
  *every* key produced 85.5% coverage at 1,337 keys and does not survive 4,000. Replace
  "every key" with a **class test** (which *kinds* of key need prose), cutting hand-written
  entries ~43% while keeping quality pressure.
- Gotchas: a duplicate-string guard that normalizes away a trailing ellipsis will force you
  to reword English to dodge false collisions (a screen reader reads "…" aloud — the mark
  is required on one string and forbidden on another); and a screenshot check that only
  asserts the file *exists* proves nothing about whether it's current. Ship a staleness
  manifest.
- **100% locale coverage is not the goal, and pretending otherwise hides real gaps.**
  Document why, per namespace.

### 27. Distribution when trust is conferred, not bought

- In credibility-dependent markets, adoption follows the visible endorsement of a small
  number of credentialed people. The marketing job is **manufacturing legible trust**,
  then using a distribution channel to carry it — not lead-gen first.
- The proof point available to anyone building this: **your product and your marketing
  engine are the same architecture** — a system that turns messy human input into
  structured, reviewable output. Dogfood it on your own go-to-market.
- Fix the narrative spine (one sentence, changes rarely); automate execution heavily.

### 28. The routine doctrine — running the business like the product

- **A routine is a loop that closes without you. An alert is a loop that opens on you.**
  Most "automation" is alerting with extra steps: it adds work and removes the excuse of
  not knowing.
- Five requirements: a trigger you don't have to notice; an action it can take alone; a
  verification that re-reads reality afterward; a written record per run; and rare
  escalation (target: <10% of runs).
- Two non-negotiables inherited from the product architecture: **a staged approval gate for
  anything irreversible or outward-facing** (money, publishing, account suspension), and
  **a per-routine kill switch flippable without a deploy**.
- **The honesty test:** if a routine's normal output is a report for a human, it's a
  newsletter, not an employee.
- Ship every routine in record-only mode; promote to acting after it has been right for
  two weeks. (Same rule as §11's `enforce = false`.)

---

## Part IX — Reference material (what makes it a playbook, not an essay)

- **A1. The ADR list** — one page per decision, each stating the alternative rejected and
  the cost accepted. Minimum set: alignment unit; event sourcing; conflict policy;
  datastore; offline model; role model; agent autonomy model; format fidelity strategy.
- **A2. The cost worksheet** — a spreadsheet where you enter your own measured
  tokens-per-source-word and get cost per 1,000 words per pipeline variant.
- **A3. Copy-pasteable contracts** — event envelope, changeset shape, provenance envelope,
  error-code table, capability/discovery document.
- **A4. Pre-launch checklists** — security (§21), deployment (§23), telemetry (§24),
  import fidelity (§4).
- **A5. The cold-start agent script** — the exact prompt to hand a fresh agent to test §19.
- **A6. "What we'd do differently"** — the standing honest list. Candidates today:
  serialize chain-mutating writes on day one; build the delta read before the first big
  import; put crash telemetry in before the first external user; decide the data-fetching
  idiom once; don't let two god components accrete (ours reached ~3,000+ lines and ~45
  props before we split them); keep one consolidated security-status document.
- **A7. Glossary** — cell, lane, changeset, ask/act, decay/health, recipe, outbox,
  projection, lease. Define these once; the rest of the playbook depends on them.

---

## Suggested publishing shape

- Each part ships as a standalone page that stands alone in search and in an AI answer
  ("how do you keep an agent from committing directly to a translation project?").
- Lead every page with the decision and the number; put the narrative underneath.
- Publish the reference contracts (A3) as real, copyable files — they are the most linkable
  artifacts here and the strongest authority signal.
- Keep a visible changelog. A playbook that is revised in public, with dates, reads as
  experience; a static one reads as content marketing.
