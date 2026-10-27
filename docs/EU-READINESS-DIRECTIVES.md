# EU / UK tenant readiness — directives

Status: draft, 2026-10-27. Written in Simplified Technical English (ASD-STE100 style).
Scope: what we must do before a UK or EU enterprise tenant (for example, Tearfund) goes
to production. Each directive has an owner role, a "done when" test, and the code
evidence that caused it.

## 0. Answer to the architecture question

Aquilla is a **shared multi-tenant SaaS**. All customers use:

- one Neon Postgres database, through Hyperdrive (`db/shim/postgres.ts`);
- one R2 bucket, `aquilla-snapshots`, for source files, audio, snapshots and artifacts;
- the same Cloudflare Workers (`auth-worker`, `sync-worker`, `agent-worker`, `worker`).

Tenant isolation is **mostly application code**, not the database:

- 31 of about 117 tables have row-level security (RLS).
- "Service mode" queries set `app.user_id = ''` and bypass identity RLS
  (`db/shim/postgres.ts:34-38`, `:263-265`).
- No R2 `jurisdiction = "eu"` setting exists in the Wrangler profiles.
- Test fixtures name a Neon host in `us-east-2`. Confirm the production region.

Thus, the security priority is: **prove the application-layer isolation, then tell the
customer the truth about region.** Do not say "EU hosted" or "EU residency" today.

## 1. Facts found in the code (2026-10-27)

| # | Finding | Evidence | Risk |
|---|---|---|---|
| F1 | No OpenRouter request sets `provider` routing, `zdr`, `data_collection: "deny"` or `allow_fallbacks: false`. ZDR depends only on the account setting. | grep over `auth-worker/src`, `sync-worker/src` | Fallback can send content to an unapproved endpoint if the account setting changes. |
| F2 | 29 server files call OpenRouter. Many build their own URL and body (`lib/contextual/tick.ts`, `lib/tools/builder.ts`, `lib/knowledge/index-doc.ts`, `routes/import-classify.ts`, `routes/import-sandbox.ts`, `routes/ai-transcript-cleanup.ts`, `lib/transcribe-core.ts`, …). | `auth-worker/src` | No single point to enforce policy. A new call site can skip it. |
| F3 | Other AI processors receive content: Google Gemini TTS (from the browser, `src/lib/audio/gemini-tts.ts`), Inworld TTS, Modal (diarization, Seed-VC, voice-forge, ASR), and user-supplied OpenAI/Groq keys (`src/lib/completion/provider-presets.ts`). | listed files | Each is a subprocessor or a customer-controlled transfer. None is in a register. |
| F4 | Integrations send project data out: Monday.com, Airtable, Zapier, Google Drive, Door43/DCS, Stripe, CF Email Service. | `auth-worker/src/lib/integrations/*`, `src/lib/import/google-drive*.ts` | More subprocessors and transfers. |
| F5 | PostHog uses the EU host. Session replay is on when analytics consent is on. A code comment still calls it a "third-party US processor" (`src/lib/posthog.ts`). OPSEC 2026-09-14 says consent defaults to **enabled** before a choice. | `src/lib/posthog.ts`, `docs/OPSEC-REVIEW-2026-09-14.md` | Default-on analytics fails the GDPR/PECR consent rule for non-essential cookies. |
| F6 | No MFA, no SSO (SAML/OIDC). A comment says an admin session has "no MFA required here". | `auth-worker/src/routes/orgs.ts:1004` | Procurement blocker. Account takeover risk. |
| F7 | No self-service account erasure or data export route. Member removal exists. | `auth-worker/src` | Data-subject requests are manual. Backups and R2 are not covered. |
| F8 | Audit tables exist: `admin_audit_log`, `agent_read_audit`, and the append-only `events` log. | `db/postgres/schema.sql:545`, `:1731` | Good base. Not proved tamper-evident. |
| F9 | An agent cannot validate a cell that is marked `ai_drafted` (AQU-1184). But the server sets `ai_drafted` only for DraftCells. An external agent that commits its own text through a PAT gets a normal commit under the human's name, and it can then validate it. | `sync-worker/src/external/emit-events-engine.ts:312-327`, `sync-worker/src/external/commit.ts:582-586` | An AI agent can make AI text look human-written and human-approved. |
| F10 | Spend guards default to log-only in all environments (OPS-27). OPS-24 credit race is open. | `docs/OPSEC-REVIEW-2026-09-03.md` | Cost exposure, not privacy. Note for contract terms. |
| F11 | Many OPSEC reviews exist, but there is no single live status table (OPSEC.md says so). | `docs/OPSEC*.md` | We cannot give a buyer one current answer. |

## 2. Directives

Priority order follows the risk table that started this work. "Eng" = engineering,
"Ops" = operator on call, "Legal" = external counsel, "Sales" = account owner.

### D1 — Data-flow and subprocessor register (Priority 1, Ops + Eng)

1. Make `docs/compliance/DATA-FLOWS.md`. For each data class, record: processor, storage
   region, processing region, retention, deletion method, subprocessors.
2. Use these data classes: source documents, drafts and commits (events), comments, user
   identity, audio, AI prompts and outputs, agent memory and artifacts, analytics and
   replay, logs (Workers Logs, Logpush), backups (Neon PITR, R2), email, support tickets,
   billing.
3. Use the vendor list in F1–F5 as the start. Add each vendor that a grep for outbound
   hosts finds.
4. Make `docs/compliance/SUBPROCESSORS.md` from the register. Publish it to customers.
5. Add a CI check that fails when a new outbound host appears in Worker code and is not in
   the register.

Done when: each data class has all six fields filled and confirmed with the vendor
dashboard or contract, not from memory.

### D2 — One AI egress gate (Priority 1 and 5, Eng)

1. Make one module, for example `auth-worker/src/lib/llm/egress.ts`. All OpenRouter calls
   must go through it.
2. In that module, set on every request: `provider.zdr: true`,
   `provider.data_collection: "deny"`, and an allowlist of providers. Set
   `allow_fallbacks: false` when the allowlist is short.
3. Read the tenant policy (see D2.5) before each call. Refuse the call if the model or
   provider is not on the tenant's list.
4. Move the 29 call sites to the module. Add a lint or test guard that fails on a raw
   `openrouter.ai` string outside the module.
5. Add an org setting "AI processing policy": allowed providers, allowed regions, TTS and
   voice features on or off, BYO keys on or off.
6. Confirm account-level ZDR in the OpenRouter dashboard. Confirm response caching is off
   for that account. Record the date and a screenshot in the register.
7. Do the same review for Gemini, Inworld and Modal. If a vendor has no ZDR or DPA,
   disable that feature for EU/UK tenants by default.

Done when: a test proves each call site sends the ZDR fields, and a tenant with a
restricted policy cannot reach a disallowed provider.

### D3 — Tenant isolation proof (Priority 2, Eng)

1. Write a cross-tenant test suite: user A of org X tries to read and write every route
   for org Y's projects, files, cells, comments, audio, artifacts, changesets, memory,
   termbase and R2 keys. Every call must fail.
2. Include the external Agent API and MCP tools with a PAT scoped to org X.
3. Include agent tool calls: an agent run for project P must not read project Q.
4. List every query that runs in service mode (`app.user_id = ''`). For each one, prove
   that the code scopes it by project or org. Extend RLS to the tables that hold content.
5. Put R2 keys under a project prefix, and check the prefix on every read.
6. Run the suite in CI.
7. Get an independent penetration test after steps 1–6. Give the summary to buyers.

Done when: the suite is green in CI and the pentest has no open high finding.

### D4 — AI provenance and approval integrity (Priority 2, Eng)

1. Mark every commit that comes through a PAT, the Agent API or MCP with its credential id
   and client name. Store this in the event, not only in a log.
2. Treat such commits as AI-origin by default (`ai_drafted = 1`), unless the credential is
   marked "human tool" by an org admin. This closes F9.
3. Keep the rule that an agent cannot validate an AI-origin cell.
4. Show three separate records in history: AI-generated, human-edited, human-validated.
5. Add a prompt-injection test: put instructions in a source document and confirm that the
   agent does not change permissions, read other projects, or approve its own changeset.

Done when: a test shows that an agent PAT cannot produce a cell that reads as
human-written and validated.

### D5 — Enterprise access control (Priority 4, Eng)

1. Add TOTP MFA. Make it required for platform admins now.
2. Add an org setting "Require MFA for all members".
3. Add SSO (OIDC first; SAML when a buyer requires it).
4. Write every privileged action (role change, member removal, PAT create/revoke, settings
   change, export, delete) to `admin_audit_log` or an org audit log that org admins can
   read and export.
5. Add "revoke all PATs and sessions for this org" for incident response.

Done when: MFA is required for all platform admins and an org admin can download the org
audit log.

### D6 — Erasure, export and retention (Priority 7, Eng + Ops)

1. Add an org export: all projects, files, events, comments, audio and artifacts.
2. Add an org and a user erasure procedure. It must cover Postgres, R2, PostHog persons,
   email logs, and connected integrations.
3. Write down what stays in Neon PITR and R2 versions after erasure, and for how long.
4. Set a retention period for each data class in the register.

Done when: we erase a test org end to end and a script confirms no rows or objects remain
(except backups, with a documented expiry date).

### D7 — Consent and analytics (Priority 1, Eng)

1. Change analytics consent to **off** until the user accepts. This fixes F5.
2. Correct the comment in `src/lib/posthog.ts` that calls PostHog a US processor, after
   you confirm the project is on the EU cloud.
3. Add an org setting that turns session replay off for all members.

Done when: a fresh browser sends no PostHog event before consent.

### D8 — Backup, recovery and incident response (Priority 2 and 6, Ops)

1. Write `docs/runbooks/incident-response.md`: incident owner, severity levels, customer
   notice time (contract), regulator notice (72 hours under GDPR and UK GDPR), access
   revocation steps, evidence keeping.
2. Rehearse two scenarios: (a) cross-tenant data exposure, (b) source text sent to an
   unapproved model provider. Record the results.
3. Do a Neon point-in-time restore to a branch, and an R2 restore, each quarter. Record
   time to restore.
4. Write RPO and RTO numbers. Use them in contracts.
5. Make one live OPSEC status table that replaces the many dated reviews (F11).

Done when: both rehearsals and one restore are done and recorded.

### D9 — Contracts and legal (Priority 3, Legal + Sales)

1. Get counsel to review: customer DPA, UK IDTA or UK Addendum to the EU SCCs, Canada
   adequacy and onward transfers to US vendors, need for a UK/EU Article 27 representative.
2. Set a liability cap with clear exceptions. Put translation accuracy and publishing on
   the customer's review responsibility.
3. Define "production ready" for the 90-day guarantee with objective tests, customer
   dependencies, and a deemed-acceptance period.
4. State how third-party AI providers are used and that model routing can change only
   with notice.
5. For media customers: write terms for source rights, derivative works, voice-cloning
   consent and generated-audio ownership. Check Seed-VC and voice-forge flows for a
   consent record.
6. Check insurance: tech E&O, cyber, privacy, and international cover.
7. Get an EU AI Act classification note for the current use cases.

Done when: counsel signs off the DPA and the master agreement template.

### D10 — Security package for procurement (Priority 7, Sales + Eng)

Make one folder with: architecture and data-flow diagram, security overview,
DPA, subprocessor list, incident-response policy, backup and recovery policy,
access-control policy, pentest summary. Build controls so that SOC 2 Type II later is
easy. Do not start SOC 2 now unless a deal requires it.

## 3. Order of work

| Week | Work |
|---|---|
| 1–2 | D1 register, D2 steps 1–6, D7, F9 fix (D4 steps 1–2), counsel engaged (D9) |
| 3–4 | D3 isolation suite, D5 MFA for admins, D8 runbook and first restore |
| 5–6 | D2.7 other AI vendors, D6 export and erasure, D8 rehearsals, pentest booked |
| Before EU production | D10 package complete, pentest done, DPA signed |

## 4. What we can tell Tearfund now

- "Aquilla is a multi-tenant service on Cloudflare and Neon. Tenant separation is in the
  application and is under independent test."
- "AI requests go through OpenRouter with zero data retention. We are adding per-request
  enforcement and a per-organization provider allowlist."
- "Here is our subprocessor list and where each one processes data."

Do not say: "GDPR compliant", "EU data residency", or "your data never leaves the EU".
