# Operational Security Review — 2026-08-27

_Seventh pass in the standing series. Follows `docs/OPSEC-REVIEW-2026-08-24.md`
(OPS-18…OPS-21), `docs/OPSEC-REVIEW-2026-08-20.md` (OPS-15…OPS-17),
`docs/OPSEC-REVIEW-2026-08-17.md` (OPS-11…OPS-13),
`docs/OPSEC-REVIEW-2026-08-13.md` (OPS-8…OPS-10),
`docs/OPSEC-REVIEW-2026-08-11.md`, `docs/OPSEC-REVIEW-2026-08-10.md`
(OPS-1…OPS-7) and `docs/OPSEC.md` (V1…V9). New findings continue the **OPS-n**
series at OPS-22._

**Scope for this pass: API security & data exposure**, the second pass on this
theme (`docs/OPSEC-REVIEW-2026-08-20.md` was the first), in the rotating
weekly cycle (auth/session Mon, authz/access Tue, injection Wed, **API/data
exposure Thu**, infra/deployment Fri). Reviewed the external Agent API
(`sync-worker/src/external/*`) end to end against the two open items the
2026-08-20 pass explicitly deferred, plus the credit-guard budget path
(`auth-worker/src/routes/chat.ts`, `auth-worker/src/lib/credits.ts`) flagged
in the same pass as worth a dedicated look.

Every finding is labelled **FACT** (verified against a file:line or a test run
at this commit) or **JUDGMENT** (reasoned inference).

**What this pass turned up.** OPS-22 and OPS-23 are exactly the two items
2026-08-20 named and deliberately left open rather than widening that pass:
"changeset GET/discard and non-search reads … remain unlimited" (OPS-15's own
"Still open" note) and the `isPathSafeId` convention audio.ts documents but
two call sites never applied. Closing both keeps the same file's follow-up
list from silently going stale the way OPS-13/OPS-17's pattern warns about.
OPS-24 is the item flagged but not investigated last time — the credit-guard
race — now traced end to end and confirmed as a real TOCTOU gap, but not
fixed here; see its section for why.

---

## Findings

### OPS-22 — External Agent API read/lifecycle routes still had no rate limit — **FIXED** [FACT]

`docs/OPSEC-REVIEW-2026-08-20.md` (OPS-15) throttled the routes with a direct
storage/event-log cost — prepare, commit, artifact upload — and explicitly
left the rest open: *"changeset GET/discard and non-search reads (project/file/
cell GETs) remain unlimited… worth a future pass rather than this one."*
`discovery-route.ts`'s own error-code docs said so too: `rate_limited` was
"enforced on /search, changeset prepare, changeset commit, and artifact
upload" — every other external route was, by that sentence's own admission,
unthrottled:

- `GET /api/v1/external/me`, `GET /api/v1/external/projects` — cold-start
  identity/project-list calls (`read-routes.ts:192-225`).
- `GET .../files`, `GET .../files/:fileId/cells`, `GET .../cells/:cellId/history`
  — the project/file/cell read surface (`read-routes.ts:314-467`).
- `GET .../artifacts/:artifactId`, `GET .../artifacts/:artifactId/content`,
  `GET .../artifacts/:artifactId/inspect` — metadata, and up to
  `MAX_ARTIFACT_BYTES` (25 MB) of raw content, per call
  (`artifacts-route.ts:293-569`).
- `GET .../changesets/:id`, `POST .../changesets/:id/discard` — the two
  changeset lifecycle ops sibling to prepare/commit, both already throttled
  (`changesets-route.ts:30-80`).
- The MCP tools `get_changeset` and `discard_changeset` delegate to the same
  handlers as the REST routes above (`mcp-handlers.ts:487-591`), so the gap
  was identical on both transports.

Impact: a leaked or malicious `aqk_` PAT could scrape a project's entire
file/cell/history graph, or repeat-download artifact content, without limit —
no write and no changeset cost, but real DB read load and, for artifact
content, real R2 egress cost per call, unbounded.

**Fixed:** the same `countRecentRateLimitEvents`/`recordRateLimitEvent`
primitive already used by search/prepare/commit/upload, added to every
remaining route:

| Route group | Kind | Cap / 15 min |
|---|---|---|
| `/me`, `/projects`, `/files`, `/files/:fileId/cells`, `/cells/:cellId/history` | `external_read` | 300 (shared per-credential bucket) |
| Artifact `meta` + `inspect` | `external_artifact_meta` | 300 |
| Artifact `content` | `external_artifact_content` | 120 (mirrors upload's cap — same order of bytes moved, opposite direction) |
| Changeset `GET` + `discard` | `external_changeset_lifecycle` | 300 |

Caps follow the same reasoning as OPS-15: wide enough that a real agent loop
traversing a large project's files/cells, or polling a changeset's status,
never trips it; tight enough to blunt a flood. `discovery-route.ts`'s
`rate_limited` doc string and `docs/AGENT-API.md`/`docs/api/agent-api.md` are
updated to say coverage is now complete instead of listing four routes as the
exception.

**Not part of this fix:** the MCP `list_projects`/`get_project`/
`get_capabilities`/`get_identity_and_scope` tools that don't delegate through
a REST handler at all (`mcp-handlers.ts:198-280`) are unauthenticated-scope
or credential-only lookups with no project-graph traversal — same class as
`/me`/`/projects`, now covered by the shared `external_read` bucket since
`list_projects`/`get_project` do delegate to `handleExternalReadRequest`. No
further gap found there.

### OPS-23 — Two audio-id fields bypassed the codebase's own path-safety convention — **FIXED** [FACT]

`sync-worker/src/audio.ts`'s `isPathSafeId` exists specifically because
`audioObjectKey()` string-concatenates its `audioId` argument into an R2 key
(`projects/{projectId}/files/{fileId}/audio/{audioId}`), and unlike this
file's own handlers — which get `projectId`/`fileId` from `[^/]+` URL
segments — `tts.ts`, `voice-convert.ts`, and `diarization.ts` take these ids
from a JSON/form body and pass them straight through. The doc comment already
named `voice-convert.ts` as a risk; `tts.ts` applies the check to
`projectId`/`fileId` there. Two fields it covers by name were never actually
validated:

- `diarization.ts:84-87` (`start`) — `audioObject` from the JSON body went
  straight into `audioObjectKey(env, projectId, fileId, audioObject)`
  (`serveAudio`, line 168) with no check at all, on any of its three
  components.
- `voice-convert.ts:180-181` — `sourceAudioId` from form data went straight
  into `audioObjectKey()`, even though `projectId`/`fileId` two lines above it
  in the same handler **are** checked (line 151).

**Exploitability, assessed rather than assumed:** in both handlers,
`projectId`/`fileId` are attacker-supplied but equality-checked against the
caller's own verified sync-token claims (`requireFileToken` /
`verifyTokenForFile`) — so they can only ever equal a project/file the caller
already holds a valid token for, not an arbitrary string. `audioObject` /
`sourceAudioId` had no such constraint. R2 object keys are opaque strings with
no path normalization (unlike a filesystem, `a/../b` is not resolved to `b`),
so a literal `../other-project/secret.webm` value does not by itself let a
caller read a *different* real key — the resulting key is simply a distinct,
almost certainly nonexistent one. This is a defense-in-depth gap against the
convention the codebase already committed to, not a demonstrated cross-tenant
read today; it is fixed on that basis (same reasoning OPS-16 used for the
artifact `Content-Type` fix: "the primitive itself is what's fixed, before
whatever consumes this value next needs it to already be safe" — and R2's
key-normalization behavior across all deployment paths, including any future
local/dev filesystem-backed emulation, is not something to bet an active
exploit's absence on).

**Fixed:** both fields now go through `isPathSafeId` before reaching
`audioObjectKey`, matching the existing `projectId`/`fileId` checks
immediately next to them. `audio.ts`'s doc comment is updated to name both
call sites so a future reviewer sees the convention as closed, not as a TODO.
No UX/UI change — the ids are internal object names the client itself
generates, never user-typed text; the new checks reject only unusable input a
legitimate caller would never send.

### OPS-24 — Credit-cap enforcement has a check-then-act race across concurrent chat requests — **NOT FIXED, reported** [FACT]

Flagged in `docs/OPSEC-REVIEW-2026-08-20.md` as "not independently verified as
exploitable here — needs a read of `db/shared` credit-ledger update code…
before it's worth changing." That read is now done.

`POST /api/v1/chat` (`auth-worker/src/routes/chat.ts:165`) calls
`creditGuard(db, env, orgId, "llm")` *before* the upstream OpenRouter call,
and `recordCredit(db, orgId, ...)` only *after* it completes
(`chat.ts:226` for the streaming path; the non-streaming path records after
the response is fully read). `creditGuard` (`credits.ts:303-341`) is a plain
read-then-decide: `readSpend` sums `org_credit_usage_daily` as it stands *at
that instant*, compares against the org's configured cap, and returns
`ok: true` if under it — with nothing reserved or locked between the read and
the eventual write. `recordCredit`'s own increment
(`credits.ts:196-207`, an `ON CONFLICT … DO UPDATE SET raw_cost_cents =
raw_cost_cents + EXCLUDED.raw_cost_cents`) is atomic *per call*, but that
atomicity is irrelevant to the race: N requests issued concurrently, close
enough to the cap, all read the same pre-request total, all pass the guard,
and all proceed to the (possibly expensive) LLM call before any of them
records spend. The cap can be exceeded by up to N−1 requests' worth in one
burst, bounded only by how much concurrency the caller can produce against
this one Worker.

**Why this is real but bounded, and why it isn't fixed in this pass:**

- `creditGuard` only returns `ok: false` when `cfg.enforce` is true, and the
  comment at the call site says explicitly this is **log-only by default** —
  "once an admin turns enforcement on." For every org that hasn't opted into
  enforcement (the default), this race has no effect: the guard never blocks
  regardless of the read it did. The exposure is real only for orgs that have
  explicitly turned enforcement on, which narrows the actor from "any
  authenticated user" to "one whose org already opted into a hard cap" —
  still worth closing, but not the widest-blast-radius class of bug in this
  series.
- `wordGuard` (`billing/words.ts:431-445`), the sibling guard on the same
  request path, is unconditionally log-only — it never returns `ok: false` at
  all — so it isn't part of this finding; nothing there enforces anything to
  race against.
- A correct fix is a genuine redesign, not a mechanical patch: `checkCredits`
  evaluates multiple thresholds (day/week, per-rail, per-org config) in
  process against a snapshot read, so closing the race properly means either
  (a) an atomic reserve-then-settle pattern — write a provisional charge
  before the upstream call and reconcile after, which needs a real
  cost-estimate story for a request whose actual cost isn't known until the
  response returns, or (b) serializing the guard-and-decide section per org
  (e.g. a Postgres advisory lock spanning the read and a placeholder
  reservation write) inside whatever transaction boundary the Hyperdrive/
  `postgres` shim actually gives a single request. Either touches
  billing-critical code (`credits.ts`, `chat.ts`, and the analogous path in
  `ai/agent/run` if one exists) under a hard 15-minute rate-limit window's
  worth of confidence-building, not a same-day fix I'm willing to land without
  the room to test the reservation math against the existing day/week/rail
  threshold logic.

Recorded here rather than silently reopened next pass, per the same standing
practice OPS-14/OPS-21 follow: this is now a confirmed FACT (not last pass's
open JUDGMENT), with the fix shape sketched above, for whoever picks it up —
ideally a pass with billing/credits as its stated scope rather than API
security picking it up as a side effect.

---

## Risk assessment

| ID | Finding | Likelihood | Impact | Risk | State |
|---|---|---|---|---|---|
| OPS-22 | External API read/lifecycle routes unthrottled | Medium — any leaked/malicious PAT, no write required | Medium — DB read load, R2 egress cost on artifact content (up to 25 MB/call, uncapped calls) | **Medium** | Fixed |
| OPS-23 | `audioObject`/`sourceAudioId` bypass the isPathSafeId convention | Low — R2 keys aren't path-normalized, so no demonstrated cross-tenant read today | Low today; Medium if any future storage layer *does* normalize paths | **Low** | Fixed |
| OPS-24 | Credit-cap check-then-act race across concurrent chat requests | Low — only orgs with `enforce: true`, needs deliberate request concurrency | Medium — direct LLM-spend overrun past a configured cap | **Low-Medium** | Reported, not fixed (see finding) |

---

## Countermeasures applied in this change

| Control | Where |
|---|---|
| Per-credential rate limiting on `/me`, `/projects`, `/files`, file cells, cell history | `sync-worker/src/external/read-routes.ts` |
| Per-credential rate limiting on artifact meta/content/inspect | `sync-worker/src/external/artifacts-route.ts` |
| Per-credential rate limiting on changeset GET/discard | `sync-worker/src/external/changesets-route.ts` |
| `isPathSafeId` applied to `diarization.ts`'s `audioObject` and `voice-convert.ts`'s `sourceAudioId` | `sync-worker/src/diarization.ts`, `sync-worker/src/voice-convert.ts` |
| Docs corrected to describe actual (now complete) rate-limit coverage instead of naming exceptions | `sync-worker/src/external/discovery-route.ts`, `docs/AGENT-API.md`, `docs/api/agent-api.md` |

Every one has a test: new throttle tests in `external-reads.test.ts` (6),
`external-import.test.ts` (3), and `external-changesets.test.ts` (3) assert
429 once the shared per-credential bucket is exhausted and 200 for a fresh
credential across every newly-covered route; new path-safety tests in
`diarization.test.ts` and `voice-convert.test.ts` assert a 400 (and zero
Modal calls) for an `audioObject`/`sourceAudioId` containing `../`. Every
suite touching a changed file (`audio`, `diarization`, `voice-convert`,
`external-reads`, `external-changesets`, `external-import`,
`external-link-media`, `external-import-parse`, `external-mcp`,
`external-permission-parity`, `external-discovery`, `read-routes` — 12 files)
is green, with `tsc --noEmit` and `eslint` clean on every touched file.

## Reviewed, no finding

- **PAT scoping** (`assertCredentialScope`, `token-bridge.ts`,
  `authenticateAndScope`, `authArtifact`) — re-checked against every route in
  scope for this pass, reads included: org resolved from the DB per call
  (never trusted from the token), live project role re-resolved per call,
  never a role baked into the credential. No gap found beyond OPS-22's
  throttling gap, which is orthogonal to authorization.
- **IDOR on the artifact/changeset item routes** — every `GET`/`POST` on a
  specific `:artifactId`/`:changesetId` re-validates project scope from the
  URL's `projectId`, and `changesets-route.ts` additionally requires
  `cred.credentialId === cs.credentialId` (the requesting credential must be
  the one that created the changeset) before returning or discarding it. No
  cross-credential read found.
- **Mass assignment / `SELECT *` reaching a response** — re-swept across
  `sync-worker/src/external/*`; every response is an explicit field allowlist
  (`rowToMeta`, `changesetToResponse`, the read routes' mapped shapes). No
  change from OPS's standing assessment.
- **SSRF via the aquifer/chat/diarization/voice-convert proxies** —
  unchanged from the 2026-08-20 pass: all four compose their outbound URL
  against a fixed, env-configured base, none accepts a caller-supplied host.

## Not fixed here — needs follow-up

- **OPS-24** — the credit-guard race, see its section above for the confirmed
  mechanics and the two candidate fix shapes. Needs a pass scoped to billing,
  not a side effect of an API-security pass.
- **V7/SEC-1 (prod/dev share `SECRET_KEY`/`SYNC_SECRET_KEY`)** — unchanged,
  still the highest-leverage open item across the whole series; out of scope
  for this pass's theme but re-flagged per standing practice.

---

_Re-run the mechanical parts of this review with: `cd sync-worker && npx tsc
--noEmit && npx vitest run`._
