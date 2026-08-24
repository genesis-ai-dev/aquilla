# Operational Security Review — 2026-08-20

_Fifth pass in the standing series. Follows `docs/OPSEC-REVIEW-2026-08-17.md`
(OPS-11…OPS-13), `docs/OPSEC-REVIEW-2026-08-13.md` (OPS-8…OPS-10),
`docs/OPSEC-REVIEW-2026-08-11.md`, `docs/OPSEC-REVIEW-2026-08-10.md`
(OPS-1…OPS-7) and `docs/OPSEC.md` (V1…V9). New findings continue the **OPS-n**
series at OPS-15._

**Scope for this pass: API security & data exposure**, one theme in a rotating
weekly cycle (auth/session Mon, authz/access Tue, injection Wed, **API/data
exposure Thu**, infra/deployment Fri). Reviewed the external Agent API
(`sync-worker/src/external/*`), auth-worker's `/api/v1`/`/api/v2` surface, and
the internal service-to-service bearer that gates admin/notify routes between
the two Workers.

Every finding is labelled **FACT** (verified against a file:line or a test run
at this commit) or **JUDGMENT** (reasoned inference). All three findings below
are fixed in this change.

**What this pass turned up.** Two came from reading the external Agent API
against the theme directly: the write-heavy routes (`prepare`, `commit`,
artifact upload) were unlimited even though `/search` was throttled after the
2026-07-30 pen test, and artifact content is served back with a client-chosen
`Content-Type` and no `Content-Disposition` — the exact bug class OPS-8 closed
for the knowledge base, left open here. The third, OPS-17, came for free the
same way OPS-13 did: running the full test suite as part of verifying the
other two fixes turned up a suite that was **already red** —
`service-auth.test.ts`'s drift scan (OPS-11) — on code that landed after the
last pass. The guard did its job; nobody had looked at the result.

---

## Findings

### OPS-15 — External Agent API write routes had no rate limit — **FIXED** [FACT]

`db/shared/rate-limit.ts` was built for the 2026-07-30 pen test specifically
because the external Agent API had zero throttling, but it was only ever
wired into `/search` (`sync-worker/src/external/read-routes.ts:249-253`).
`discovery-route.ts` and `docs/AGENT-API.md` both said so explicitly
("currently enforced on /search", "not yet implemented: … rate limiting").

The routes that actually write — `POST .../changesets` (stage a plan,
`prepare.ts`), `POST .../changesets/:id/commit` (apply it, `commit.ts`), and
`POST .../artifacts` (upload up to 25 MB, `artifacts-route.ts`) — were
unlimited. A leaked or malicious `aqk_` PAT could stage/commit changesets or
upload artifacts as fast as the Worker could accept connections, with no
per-credential ceiling — a real-event and R2-storage cost vector, not just a
noisy-neighbor problem.

**Fixed:** the same `countRecentRateLimitEvents`/`recordRateLimitEvent`
primitive `/search` uses, added to each route's PAT entrypoint
(`handlePrepare`, `handleCommit`, `handleUpload` — the single choke point
both REST and the MCP adapter's synthetic requests go through):

| Route | Kind | Cap / 15 min |
|---|---|---|
| `POST .../changesets` | `external_prepare` | 300 |
| `POST .../changesets/:id/commit` | `external_commit` | 300 |
| `POST .../artifacts` | `external_artifact_upload` | 120 (≤25 MB each) |

Caps mirror `/search`'s reasoning: wide enough that a real agent loop staging
and applying a plan every few seconds never trips it, tight enough to blunt a
flood. `discovery-route.ts`'s `rate_limited` doc string and `docs/AGENT-API.md`
are updated to describe the new coverage instead of claiming only `/search` is
throttled.

**Still open:** changeset GET/discard and non-search reads (project/file/cell
GETs) remain unlimited, as does the MCP `list_projects`/`get_project` path
when it doesn't delegate to a throttled REST handler. Lower priority — these
are reads with no write/storage cost — but the same gap shape as before this
pass; worth a future pass rather than this one, which was scoped to the
routes with real cost.

### OPS-16 — Artifact content served back with a client-chosen Content-Type — **FIXED** [FACT]

Source-artifact upload (`artifacts-route.ts` `handleUpload`) stores whatever
`content-type` header the uploading client sent, with no validation — only the
newer `kind: audio` path validates content type, against an allowlist
(`AUDIO_CONTENT_TYPES`). `handleGetContent` then served that stored value back
verbatim, with no `Content-Disposition`. A CONTRIBUTOR-scoped PAT (or a leaked
one) could upload a "source" artifact declared `Content-Type: text/html`
containing a payload; anything that later opened
`.../artifacts/:id/content` directly in a browser — a future artifact-preview
UI, a partner integration proxying the URL — would render it as active content
on the sync-worker origin.

This is the same bug class OPS-8 (`docs/OPSEC-REVIEW-2026-08-13.md`) closed
for the knowledge base, whose fix note says explicitly: *"stored content type
is derived from the validated extension, never the client's Content-Type… a
mislabelled .md would otherwise be stored XSS on the worker origin."* That
mitigation was never applied here. Grepping the SPA (`src/`) for a fetch of
this content URL into a browser context comes back empty, so there is no live
sink today — the primitive itself is what's fixed, before whatever consumes
this URL next needs it to already be safe.

**Fixed**, at serve time (`handleGetContent`) rather than at write time, so it
also covers rows already stored with a browser-renderable type:

- A deny-list (`text/html`, `application/xhtml+xml`, `image/svg+xml`,
  `application/xml`/`text/xml`, the JS MIME variants) forces
  `application/octet-stream` on serve; everything else passes through
  unchanged (bytes and detection via `/inspect` are untouched — legitimate
  agent consumption of source artifacts as data is unaffected).
- `Content-Disposition: attachment; filename="…"` (name sanitized against
  header injection) and `X-Content-Type-Options: nosniff` on every response,
  so even a type that slips through can't be sniffed into rendering.

No UX/UI change: this route has no browser-facing caller today; the fix is
purely defense-in-depth on the wire format.

### OPS-17 — Service-bearer drift: three new call sites bypassed `serviceBearerMatches` — **FIXED** [FACT]

OPS-11 (`docs/OPSEC-REVIEW-2026-08-17.md`) consolidated seven hand-written
copies of the `SYNC_SECRET_KEY` service-bearer check into one helper
(`sync-worker/src/lib/service-auth.ts`) after one of the seven had quietly
dropped the constant-time compare, and added a drift-scan test
(`service-auth.test.ts`) specifically so the eighth copy would fail CI instead
of shipping silently.

Running the full sync-worker suite while verifying OPS-15/16 found it already
red: three call sites added since that pass reintroduced the hand-rolled
`` `Bearer ${SYNC_SECRET_KEY}` `` + manual compare shape the helper exists to
prevent —

- `sync-worker/src/events/migrate-cell-ids-route.ts:37`
- `sync-worker/src/member-role-changed.ts:98` (its own header literally says
  `// [Pen test 2026-08-17]`, from the same window OPS-11 landed in — the fix
  and the regression shipped past each other)
- `sync-worker/src/project-do.ts:264` — the same file that has *three other*
  call sites already correctly using `serviceBearerMatches`
  (`project-do.ts:155,186,219`); this fourth one just never got converted.

**None of the three is independently exploitable** — all three used
`secureCompare` (constant-time), not `===`/`!==`, so this is not a repeat of
OPS-11's actual timing-attack bug. What it is: the exact drift OPS-11 built
the scan to catch, on live code, with the guarding test failing and nobody
having looked — a live instance of the V4/OPS-13 pattern ("a control that
doesn't run is worth exactly as much as one that was never written"), except
here the control *did* run and its result just wasn't read before merge.

**Fixed:** all three now call `serviceBearerMatches(request.headers.get(...),
env)`, matching every other service gate. `secureCompare` and its now-unused
import were removed from `project-do.ts` and `member-role-changed.ts`.
`service-auth.test.ts` passes clean; `pnpm run type-check` and the full
sync-worker suite (`vitest run`, 1370 tests) are green.

---

## Risk assessment

| ID | Finding | Likelihood | Impact | Risk | State |
|---|---|---|---|---|---|
| OPS-15 | External Agent API write routes unthrottled | Medium — any leaked/malicious PAT | Medium — R2/event-log cost, abuse | **Medium-High** | Fixed |
| OPS-16 | Artifact content served with client Content-Type, no disposition | Low today (no browser sink) — Medium if a preview UI ships | Medium — stored XSS on worker origin | **Medium** | Fixed |
| OPS-17 | Service-bearer check drift (3 new hand-rolled call sites) | Certain — already landed, guard already red | Low today (all constant-time) — High if the next copy drops the compare, per OPS-11's own history | **Medium** | Fixed |

---

## Countermeasures applied in this change

| Control | Where |
|---|---|
| Per-credential rate limiting on changeset prepare/commit/artifact upload | `sync-worker/src/external/{prepare,commit,artifacts-route}.ts` |
| Artifact content served with a safe Content-Type, `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff` | `sync-worker/src/external/artifacts-route.ts` (`handleGetContent`) |
| Three drifted service-bearer checks routed back through `serviceBearerMatches` | `sync-worker/src/events/migrate-cell-ids-route.ts`, `sync-worker/src/member-role-changed.ts`, `sync-worker/src/project-do.ts` |
| Docs corrected to describe actual rate-limit coverage instead of "search only" | `sync-worker/src/external/discovery-route.ts`, `docs/AGENT-API.md` |

Every one has a test: OPS-15/16 are covered by the existing external-API
integration suites (`external-changesets.test.ts`, `external-project-commands.test.ts`,
`external-patch-settings.test.ts`, `external-emit-events.test.ts`,
`external-reads.test.ts`, `external-permission-parity.test.ts`, 155+ tests, all
green with the new throttles in place — none of the existing test flows trip
the caps). OPS-17 is covered by `service-auth.test.ts`'s own drift scan, now
passing.

## Reviewed, no finding

- **PAT scoping** (`assertCredentialScope`, `token-bridge.ts`) — every external
  route funnels through it, re-derives org from the DB rather than trusting
  the token, and re-resolves live project role per call. No org-A-reads-org-B
  gap found. Matches OPS's standing assessment of this as the model the rest
  of the system should follow.
- **`GET /api/v2/users/lookup`** — returns `{id, username}` only, requires
  auth, exact-match (no enumeration). Not scope-limited to shared org/project
  like `/search` is, but that's by design: `src/lib/frontier/members.ts`'s
  comment says explicitly this is the out-of-scope lookup path so a user can
  be invited by exact username from outside the shared org. No action.
- **CORS / aquifer proxy SSRF** — `Access-Control-Allow-Origin: *` remains
  correct for a cookie-less bearer API (re-confirmed, no credentialed CORS).
  The aquifer client composes its outbound URL only against a fixed
  `AQUIFER_BASE_URL`, rejecting `://`/`//`/`..` in the caller-supplied path
  before use — no SSRF via user-controlled host.
- **PAT minting/hashing** (`db/shared/api-credentials.ts`) — SHA-256 at rest,
  plaintext shown once, per-user mint throttle. Unchanged, still sound.

## Not fixed here — needs follow-up

- **Chat proxy budget-guard atomicity** (`auth-worker/src/routes/chat.ts`
  `creditGuard`/`wordGuard`). A burst of concurrent requests could each read
  the budget counter before any of them updates it (a TOCTOU race), which
  would let a burst exceed the daily LLM-spend cap by more than one request's
  worth. Not independently verified as exploitable here — needs a read of
  `db/shared` credit-ledger update code (transaction vs. read-then-write) to
  confirm before it's worth changing. Flag for the next API-security pass or a
  dedicated look.
- **OPS-15's own residual scope** — changeset GET/discard and non-search reads
  are still unthrottled (see OPS-15 above). Lower cost than the write routes
  fixed here; left for a future pass rather than widened into this one.
- **V7/SEC-1 (prod/dev share `SECRET_KEY`/`SYNC_SECRET_KEY`)** — unchanged,
  still the highest-leverage open item across the whole series; out of scope
  for this pass's theme but re-flagged per standing practice.

---

_Re-run the mechanical parts of this review with: `cd sync-worker && npx tsc
--noEmit && npx vitest run`._
