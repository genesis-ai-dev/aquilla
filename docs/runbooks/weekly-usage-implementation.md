# Weekly usage implementation map

Updated: 2026-09-14. AQU-837. Implementation preparation, not an enabled meter.

## Decision required

The approved Free/Pro/Max/Team values specify allowance counts but not the
conversion from performed work into those counts. Two incompatible accounting
systems currently exist:

- `auth-worker/src/lib/credits.ts` stores raw provider cents in daily aggregates.
  `creditsFor` applies a configurable multiplier (default 4×; agent 5×).
  `sync-worker/src/credits.ts` mirrors this for speech synthesis.
- `auth-worker/src/lib/billing/words.ts` records input words in daily aggregates;
  legacy billing defaults to 100 words per credit.

These do not give the same capacity. Do not silently select one, reinterpret
approved allowance counts, or treat missing provider cost as free work.
Ryder has been asked which unit the weekly allowance uses. If cost-based, confirm
its conversion/rate version before enabling customer enforcement. Percentage-only
presentation does not remove the need for an explicit internal unit.

## Producer and consumer map

| Entry point | Current accounting | Weekly enforcement work |
| --- | --- | --- |
| `auth-worker/src/routes/chat.ts` | Post-response cost and input words; streaming uses a flat cost estimate | Authorize owning workspace; reserve before provider call; reconcile streamed/non-streamed result. Projectless, unknown, and unauthorized projects currently fall back to org 0, so do not reuse this behavior for enforced billing. |
| `auth-worker/src/routes/agent.ts` and `lib/agent/tools/draft.ts` | Aggregate run cost and input words after run; separate optional per-call instrumentation | Enforce advanced capability and shared allowance at each billable model/tool step, including nested drafting, retries, and cancellation; stop further work safely on exhaustion. |
| `auth-worker/src/routes/contextual.ts` and `lib/contextual/tick.ts` | Optional `CostMeter` instrumentation; not the product billing ledger | Resolve project owner for background leases, resume, and multi-wave work; reserve/settle each provider call and stop further waves after exhaustion. |
| `auth-worker/src/routes/import-classify.ts` | Cost plus sampled input words on valid result | Reserve before provider call; define settlement for charged malformed output and retry without duplicate consumption. Preserve manual import. |
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

1. Reconcile migration numbering with current main before adding a usage store.
2. Define a versioned internal unit and provider settlement contract. Preserve
   raw measurements separately so pricing changes do not rewrite consumption.
3. Add a durable request/reservation ledger and exact anchored-period totals.
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

No runtime code changes in this map. It does not mark metering, capabilities, or
launch enforcement complete.
