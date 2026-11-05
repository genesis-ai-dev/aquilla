# BATCH_ENDPOINT_CONTRACT — Aquilla Batch Translation API v1 (FROZEN)

Status: **FROZEN 2026-07-04** (Phase 0 of the Matecat-parity run). The real endpoint will be
provided later and MUST implement this contract byte-for-byte. All Aquilla batch-pipeline code
is written against this contract and its stub implementation
(`parity/batch/stub-server.ts`); the contract test suite lives at
`parity/batch/contract.test.ts` and MUST pass against any real implementation.

Design provenance: interface shape informed by Matecat's public API documentation only
(https://www.matecat.com/api/docs, https://guides.matecat.com/creating-and-checking-projects-via-api)
— async two-phase creation, capability-token-per-resource auth, polled analysis, no webhooks
required for v1. No Matecat source code was consulted (clean-room constraint C1).

---

## 1. Auth model

- Header `x-aquilla-key: {keyId}.{secret}` on every request. Missing/malformed → `401`
  `{"errors":[{"code":"unauthorized","message":...}]}`.
- Each created batch returns a **capability token** (`batchToken`). Status/result reads accept
  EITHER the account key OR `authorization: Bearer {batchToken}` — so results can be handed to
  a third party without account credentials.
- Keys are provisioned out-of-band (billing/entitlement layer; stubbed today). The stub accepts
  any key of the literal form `test_{id}.{secret}` and rejects everything else — contract tests
  rely on this.

## 2. Endpoints

Base path: `/batch/v1`. All bodies are `application/json; charset=utf-8`.

### 2.1 `POST /batch/v1/batches` — create a batch (async)

Request:

```jsonc
{
  "projectId": "string",            // Aquilla project the batch belongs to (entitlements/TM flags come from here)
  "sourceLang": "string",           // BCP 47, case-sensitive region (e.g. "en-US")
  "targetLang": "string",           // BCP 47; ONE target per batch (fan out client-side)
  "segments": [                     // 1..=500 segments per request (chunking rule, §4)
    {
      "id": "string",               // client-scoped unique id, echoed back verbatim
      "text": "string",             // source text, ≤ 10,000 Unicode code points
      "context": "string | null",   // optional context hint (e.g. preceding segment)
      "maxLength": 123              // optional target character limit (null = none)
    }
  ],
  "options": {
    "model": "string | null",             // model id, null = server default
    "useGlobalExamples": true,            // few-shot retrieval from global DB (enterprise orgs ALWAYS excluded, §5)
    "maxExamplesPerSegment": 5,           // 0..10, default 5
    "temperature": 0.2                    // 0..1, default server-defined
  }
}
```

Response `202 Accepted`:

```jsonc
{
  "batchId": "string",              // server-assigned, ULID/UUIDv7 ordering
  "batchToken": "string",           // capability token for status/result reads
  "status": "queued",
  "segmentCount": 123,
  "statusUrl": "/batch/v1/batches/{batchId}",
  "resultsUrl": "/batch/v1/batches/{batchId}/results"
}
```

Errors: `400 invalid_request` (schema violation; message names the offending field),
`401 unauthorized`, `403 entitlement_missing` (batch API not enabled for the account),
`404 project_not_found`, `413 too_many_segments` (> 500 per request),
`422 unsupported_language`.

### 2.2 Idempotency

- Header `idempotency-key: {uuid}` on `POST /batches`. Replaying the same key + identical body
  returns the ORIGINAL `202` response (same `batchId`), not a new batch. Same key + different
  body → `409 idempotency_conflict`. Keys are retained ≥ 24 h.

### 2.3 `GET /batch/v1/batches/{batchId}` — status poll

Response `200`:

```jsonc
{
  "batchId": "string",
  "status": "queued | running | succeeded | failed | partially_failed",
  "segmentCount": 123,
  "completedCount": 45,
  "failedCount": 0,
  "createdAt": "RFC3339",
  "finishedAt": "RFC3339 | null",
  "queueDepthAhead": 0              // batches queued ahead (Matecat IN_QUEUE_BEFORE analog)
}
```

`404 batch_not_found` for unknown id or a token that doesn't match.

### 2.4 `GET /batch/v1/batches/{batchId}/results?cursor={cursor}&limit={n}` — paginated results

- `limit` 1..500, default 100. Cursor-based (opaque `cursor` string), stable ordering by
  segment submission order. Results MAY be read while `running` (completed segments stream in).

Response `200`:

```jsonc
{
  "batchId": "string",
  "results": [
    {
      "id": "string",                  // client segment id, verbatim
      "status": "succeeded | failed | pending",
      "translation": "string | null",
      "model": "string | null",        // actual model used (provenance)
      "examplesUsed": 3,               // few-shot examples retrieved for this segment
      "error": { "code": "string", "message": "string" } // present iff failed
    }
  ],
  "nextCursor": "string | null"        // null = end of current snapshot
}
```

### 2.5 `POST /batch/v1/batches/{batchId}/cancel`

`200 {"batchId": ..., "status": "failed", "cancelled": true}`. Cancelling a finished batch is a
no-op returning current state. Idempotent.

## 3. Error semantics (all endpoints)

```json
{ "errors": [ { "code": "snake_case_string", "message": "human readable" } ] }
```

- Codes are STABLE strings (not numbers). Clients switch on `code`, never on `message`.
- `429 rate_limited` includes `retry-after` header (seconds). Server-side failures are `500
  internal` and are safe to retry with the same idempotency key.
- Per-segment failures never fail the batch; they surface as `failed` results and
  `partially_failed` batch status.

## 4. Chunking & throughput bar (frozen)

- ≤ 500 segments per create request; ≤ 10,000 code points per segment; clients fan large jobs
  into multiple batches (Matecat analog: 600 files/200 MB caps — our per-request caps are the
  contract equivalent).
- **Throughput bar:** the pipeline (excluding model latency — measured with a no-op translator)
  must sustain ≥ 2,000 segments/minute end-to-end through create→process→results on the stub,
  demonstrated by `parity/batch/throughput.test.ts` processing 10,000 segments in ≤ 5 minutes
  of pipeline time. Rationale: Matecat documents no rate limits; its analysis pipeline
  processes whole projects (≤ 70k segments/file) asynchronously, so pipeline overhead — not the
  model — must never be the bottleneck.

## 5. Few-shot retrieval semantics (normative)

- When `useGlobalExamples` is true, examples come from the global validated-translation index.
- **Enterprise exclusion (hard invariant):** no example may originate from an organization
  flagged `enterprise`, under any query, language pair, or match type. This is enforced at the
  retrieval layer and adversarially tested (canary corpus, red-team queries) — see
  `sync-worker/test/fewshot-exclusion.test.js`.
- **TM opt-out (hard invariant):** projects with `contribute_to_global_tm = false` never
  contribute examples to the global index (write-path gate + read-side leak test).
- `examplesUsed` in results is the count actually retrieved post-exclusion, for auditability.

## 6. Versioning

- Breaking changes require `/batch/v2`. Additive response fields are allowed; clients must
  ignore unknown fields. Request fields are never repurposed.

## 7. Conformance

- Stub: `parity/batch/stub-server.ts` (in-process, no network) — the reference implementation.
- Contract tests: `parity/batch/contract.test.ts` — MUST pass unchanged against the real
  endpoint (transport adapter injected). Throughput: `parity/batch/throughput.test.ts`.
