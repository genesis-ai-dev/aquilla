# Weekly usage implementation map

Updated: 2026-09-14. AQU-837. Implementation preparation, not an enabled meter.

## Approved accounting basis

Ryder selects provider cost with a multiplier on 2026-09-14 and confirms the
agent uses the same multiplier as other work. Higher token consumption naturally
uses more of the shared allowance; there is no additional agent surcharge.

The new weekly model preserves the existing base conversion: one internal unit
is one marked-up cent, with a uniform 4× multiplier. `2026-09-cost-v1` snapshots
that rate. Store raw provider cost separately, and use integer millionths of an
internal unit so small calls do not each round up to a whole unit. Existing
legacy credit/word accounting remains separate during rollout.

The approved allowance counts stay unchanged. Consequently Pro's 50 units allow
12.5 raw provider cents per week at 4×. This is an explicit implementation of the
existing unit convention, not a claim that the capacity is commercially validated.
Validate realistic workloads before enabling enforcement; changing the unit or
capacity requires a new explicit policy/version, not hidden repricing.

Missing provider cost is unresolved, not zero or an invented flat charge.
Percentage-only presentation does not remove the need for an explicit unit.

## Launch decisions — 2026-09-16

See the pricing model's decision list. Implementation consequences: the
reservation bound is `prompt tokens × live input price + output cap × live output
price` from OpenRouter's model list, cached server-side and refused when missing;
the agent may finish an in-progress step up to 5% over the weekly allowance;
audio rails stay unmetered for now; the credit and word guards are removed once
every LLM producer is connected. Measured 2026-08 rates from the local
`agent_cost_meter` ledger: Luna ≈ 0.07¢ per autopilot call, DeepSeek v4 flash
≈ 0.03¢; Sonnet and Opus were never measured.

## Implemented foundation

- `db/shared/billing-cost.ts` defines the common conversion and strict provider
  cost parser. Agent, chat, and speech use the same multiplier.
- Migration `0098_workspace_usage_provider_ref.sql` adds the provider generation
  reference used to reconcile held reservations; `usage-reconcile.ts` settles a
  held request only from the provider's own generation record.
- Migration `0097_workspace_usage_requests.sql` adds exact-period reservations,
  raw settled cost, rate snapshots, and terminal-state constraints. It is prepared,
  not deployed. Freshly fetched main `c1aad5636` ends at migration 0089;
  0097 does not collide there. Recheck pending branches at release integration.
- `rate-card.ts` reads OpenRouter's live model prices (cached) and bounds a
  request from prompt characters and the enforced output cap; unknown models
  are refused. `reserveWorkspaceUsage` admits only below 100% and lets a bound
  end up to 5% over (`OVERAGE_FACTOR`).
- `workspace-usage.ts` reads the verified workspace entitlement inside the same
  organization lock used by billing changes. It reserves against settled plus
  outstanding usage, deduplicates request IDs, and settles actual cost atomically.
- A reservation replay never authorizes another provider call. Known unused work
  can release its reservation; unknown completion cannot expire into free usage.
  Settled overruns remain recorded and prevent further admission.
- Paid access failure selects the Free cap against the same period's consumption.
  Exact weekly boundaries leave old usage intact. Explicit Free workspace periods
  start at workspace creation; unknown/legacy/covered workspaces require their
  separate access contract instead of automatic reclassification.
- The authenticated chat, import-classification, and agent routes now consume
  this foundation in explicit local scripted-provider rehearsal; contextual
  background work, indexing, and Monday analysis remain unconnected. It does
  not authorize users itself: funded endpoints must validate project access first,
  calculate a trusted maximum cost, reserve before the call, and settle afterward.
  Billing usage remains unavailable until all active producers are connected.

## Producer and consumer map

| Entry point | Current accounting | Weekly enforcement work |
| --- | --- | --- |
| `auth-worker/src/routes/chat.ts` | Post-response cost and input words; streaming uses a flat cost estimate | Authorize owning workspace; reserve before provider call; reconcile streamed/non-streamed result. Projectless, unknown, and unauthorized projects currently fall back to org 0, so do not reuse this behavior for enforced billing. |
| `auth-worker/src/routes/agent.ts` and `lib/agent/tools/draft.ts` | Legacy aggregate run cost after run; local rehearsal reserves and settles each orchestrator turn and drafting pass (`agent-usage.ts`) | Remaining: capability checks, legacy guard retirement, contextual background work. Exhaustion stops the next step and preserves staged work. |
| `auth-worker/src/routes/contextual.ts` and `lib/contextual/tick.ts` | Optional `CostMeter` instrumentation; not the product billing ledger | Resolve project owner for background leases, resume, and multi-wave work; reserve/settle each provider call and stop further waves after exhaustion. |
| `auth-worker/src/routes/import-classify.ts` | Legacy cost plus sampled input words on valid result; local rehearsal reserves before the call and settles reported cost even for rejected recipes | Remaining: real-provider cost bound; a retry with a new key reserves again (same key returns 409). Manual import is untouched. |
| `auth-worker/src/routes/import-sandbox.ts` | Cost plus filename words | Filename word count does not measure conversion-model work. Integrate selected unit and preserve source/commit artifacts on exhaustion. |
| `auth-worker/src/lib/knowledge/index-doc.ts` | Direct provider request | Resolve document/project ownership; include or explicitly classify system-funded indexing before launch. |
| `auth-worker/src/lib/monday/analyze.ts` | Direct provider request with usage parsing | Resolve organization and invoking workflow; include or explicitly classify system-funded analysis. |
| `sync-worker/src/tts.ts` | Audio seconds plus configured compute cost after synthesis | Shared workspace pool across workers; reserve before synthesis, settle duration/cost, handle missing duration without recording free work. |
| `sync-worker/src/voice-convert.ts`, `diarization.ts` | Separate media processing paths | Audit whether Aquilla-funded processing consumes this allowance; avoid accidental unmetered paid paths. |
| External-agent tokens | Ordinary identity/permission boundaries | Check owning workspace capability and same usage pool at every funded AI endpoint; external provider bills stay outside Aquilla's allowance. |
| Workspace billing API / UI | Period and effective offer; `usagePercent` is null | Read authoritative settled plus reserved usage and exact reset time; do not fabricate zero usage when the store is unavailable. Hide internal units. |

`CostMeter` is optional development instrumentation (`COST_METER=1`), buffers
writes, and drops failed batches. It cannot serve as a paid-access authority.
The existing word guard is log-only, and the credit guards use rolling daily
aggregates. Neither supplies exact activation-anchored weeks or concurrency-safe
admission. A daily row cannot divide usage at a midday weekly boundary.

## Implementation order

1. Recheck migration numbering against release integration branches; the fresh main reference has no collision with 0097.
2. Use the approved versioned cost unit and finish provider-specific settlement contracts. Preserve
   raw measurements separately so pricing changes do not rewrite consumption.
3. Connect the durable request/reservation ledger and exact anchored-period totals.
   Serialize admission per workspace; include outstanding reservations when
   checking capacity. Make retries idempotent and release only proven unused
   reservations. Unknown completion stays reconcilable instead of free.
4. Resolve Free anchor from workspace creation and paid anchor from verified
   activation. Plan/cadence changes and renewal leave consumption untouched.
   Payment failure selects Free capacity against the same current usage.
5. Implement one complete chat → provider → settlement → billing API journey,
   behind an explicit local gate, then expand to every mapped producer.
6. Enforce paid feature capabilities at the server boundary. Preserve legacy,
   partner, and negotiated access until an explicit migration is approved.
7. Expose percentages/reset times and actionable exhaustion states. Preserve
   existing artifacts, editing, and export. Do not enable automatic overages.
8. Verify every producer before enabling any public checkout or usage claims.

## Required regression boundaries

- Real Postgres: simultaneous last-allowance reservations cannot overspend;
  retries, failed transactions, provider uncertainty, and duplicate settlement
  cannot lose usage or apply it twice.
- Exact reset instant, no rollover, no invoice-triggered extra reset, and no
  forgiveness of spent usage on upgrade, downgrade, or failed-payment fallback.
- Actual authenticated producer output flows through the admission/settlement
  consumer; test multiple tools and both workers against one organization pool.
- Chat project attribution rejects unauthorized/unknown projects instead of
  silently funding an unowned call. Personal paid access cannot fund Team work.
- Stream disconnect, canceled background lease, retry, failed parse, and nested
  tool calls preserve correct settlement and already-created artifacts.
- Extend the existing billing smoke for cross-layer access and percentage proof;
  keep UI-only copy/control tests in RTL. Add the usage module/migration to
  `scripts/lib/e2e-impact.ts` when implementation lands.

Foundation verification: 16 tests pass against real Postgres, composing signed
Checkout activation → entitlement → reservation → provider cost parser → settlement.
Coverage includes concurrency, replay, migration replay, equal multipliers, unknown
cost, overrun, rollback, Free fallback, scope mismatch, and exact reset boundaries.
Local chat endpoint integration passes thirteen additional real-Postgres route
tests; import classification adds five (settled valid and malformed output,
retained uncertain/missing cost, exhaustion, and authorization before admission). Real-provider bounds, remaining endpoints, capabilities, and launch
enforcement remain incomplete.

## Local verification commands

- `pnpm --dir auth-worker exec vitest run --config vitest.webhook-postgres.config.ts src/__tests__/billing-workspace-usage.test.ts` — 16 pass.
- `npx vitest run scripts/e2e-impact.test.ts scripts/e2e-determinism.test.ts --maxWorkers=2` — 24 pass.
- `E2E_SHARD=3/3 npx tsx scripts/e2e-up.ts -- e2e/specs/orgs/org-settings-billing.smoke.spec.ts --shard=1/1` — three pass; no slow-request logs.
- `pnpm --dir auth-worker exec tsc --noEmit`, `npm run build`, and `git diff --check` — pass.

The existing browser journey checks that the new schema preserves billing access;
it does not claim to verify provider admission, which is separately covered through the real chat handler against Postgres.
The new regression suite verifies the changed ledger contract against real
Postgres. No UI behavior changes, so no new UI test or browser journey is added.
