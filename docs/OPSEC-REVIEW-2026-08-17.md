# Operational Security Review — 2026-08-17

_Fourth pass in the standing series. Follows `docs/OPSEC-REVIEW-2026-08-13.md`
(OPS-8…OPS-10), `docs/OPSEC-REVIEW-2026-08-11.md`, `docs/OPSEC-REVIEW-2026-08-10.md`
(OPS-1…OPS-7) and `docs/OPSEC.md` (V1…V9), which re-check
`docs/SECURITY-NOTES-2026-06-10.md` (SEC-1…SEC-11). New findings continue the
**OPS-n** series at OPS-11._

Every finding is labelled **FACT** (verified against a file:line or a command run
at this commit) or **JUDGMENT** (reasoned inference). Findings fixed in the same
change that adds this document say so; the rest carry a recommended owner
decision, because they are secrets or settings calls rather than patches.

**Context: 150 commits landed since the last pass**, and they brought the largest
new attack surface the product has added in one window — a Stripe billing
integration (real money, a public webhook), an org/project knowledge base
(uploaded documents, R2 originals, extracted text), an EPUB importer, and the
autopilot graph. §3 reports what a review of each turned up, including the ones
that turned up nothing, because "we looked and it held" is the part a review
series usually forgets to write down.

**What this pass turned up that the previous three did not.** Both findings came
from counting rather than reading. OPS-11 came from asking not *is this gate
correct?* but *how many copies of this gate are there?* — every prior pass
checked authorization decisions one at a time and found them sound; counting
them found seven hand-written copies of the same four lines, one of which had
quietly dropped the constant-time compare a previous fix had already installed
in a sibling file. The bug was not a decision anyone got wrong; it was there
being seven places to get it wrong.

OPS-13 came from the same question asked of the pipeline, and it came for free:
this review's own PR went red on a check its diff could not have affected, and
following that back showed the credential scan had not been running in CI at
all. Worth recording as method — **opening the PR was itself a probe**, and the
CI result was evidence about the repo rather than about the change.

---

## 1. Critical data

The 2026-08-10 ranking stands. Two rows are re-weighted by what shipped since
the last pass:

| Rank | Asset | Where it lives | Change this pass |
|---|---|---|---|
| 1 | **Translator identity ↔ project linkage** | `users`, `project_members`, invite emails, comment authorship | Unchanged in substance. Still the datum the platform can never un-leak. |
| 2 | **Signing keys** — `SECRET_KEY`, `SYNC_SECRET_KEY` | Worker secrets | **Re-weighted up.** `SYNC_SECRET_KEY` is not only the sync-token signing key and a legacy admin bearer (OPS-2) — it is also the shared bearer on *seven* internal endpoints across both Workers (OPS-11). Its blast radius is now the widest of any single secret in the system. |
| 3 | **Session JWTs** | Browser IndexedDB, 30-day lifetime | Unchanged. CSP still mostly report-only. |
| 4 | **Unpublished translation content** | `events` / `cells`, R2 blobs | Unchanged; replay masking (OPS-3) verified to have survived a refactor — see §6. |
| — | **New: knowledge-base documents** | `knowledge_docs` + R2 `kb/…` | Uploaded reference material, org- and project-scoped, served back as original bytes. Reviewed this pass (§3); no finding. |
| — | **New: billing records + Stripe customer linkage** | `org_billing`, Stripe | An org's plan, spend and customer id. Payment instruments never touch our infrastructure (Checkout + Portal are hosted). |

---

## 2. Threats

The 2026-08-10 actor table stands unchanged. One note on weighting:

The billing integration adds a **financially motivated** actor for the first
time — someone who wants a free Field Plan, not a translator's identity. That
actor is real but is the *cheapest* of the four to defend against, because
Stripe's webhook signature is a cryptographic gate rather than a judgement call.
It is worth being explicit that this actor is a distraction relative to the
existing model: forging a subscription costs the business money, while the §2
actor hostile to the translation work costs somebody their safety. Review effort
should stay allocated accordingly, and did.

---

## 3. Vulnerabilities

### OPS-11 — [FACT] The service-to-service bearer gate is hand-written at seven sites, and one of them had dropped the constant-time compare — **fixed in this change**

`SYNC_SECRET_KEY` gates every internal call between the identity Worker and the
sync Worker: `/admin/projects/:id/archive`, `.../member-removed`,
`.../settings-changed`, `.../contextual-activity`, and the project DO's
`__broadcast`, `__link-sync` and `__member-removed`. Seven receivers, each with
its own copy of:

```ts
const auth = request.headers.get("Authorization") ?? ""
const expected = env.SYNC_SECRET_KEY ? `Bearer ${env.SYNC_SECRET_KEY}` : null
if (!expected || !secureCompare(auth, expected)) return new Response("unauthorized", { status: 401 })
```

Six were correct. The seventh — `contextual-activity-notify.ts:55`, which landed
2026-07-26 with the contextual run engine — was:

```ts
if (!expected || request.headers.get('Authorization') !== expected) {
```

A plain `!==` on attacker-supplied input against the token-signing key. That is
precisely the bug `sync-worker/src/lib/secure-compare.ts` exists to prevent, and
its own header says it was centralised because the same comparison had already
been duplicated ad hoc. `audio.ts:140` still carries the comment from the last
time this was fixed there: *"This gate previously used `===`, so it leaked a…"*.
Same bug, same worker, second occurrence, eleven months apart.

**Severity, stated honestly.** Remote timing recovery of a secret through
Cloudflare's edge, across the public internet, against a single string compare,
is at the far difficult end of practical — this is not an exploit anyone is
running tomorrow. **JUDGMENT:** the finding that matters is not this line, it is
the mechanism that produced it. Three prior reviews read these gates and passed
them, because each one is individually fine and the wrong one is only visible
next to its six siblings. A codebase whose strongest control is a single
construction site with an ESLint rule behind it (`AuthorizedEvent`, praised in
every pass so far) had seven construction sites for its shared-secret check and
no rule at all.

**Fixed:**

- `sync-worker/src/lib/service-auth.ts` — one `serviceBearerMatches()`, modelled
  on OPS-2's `lib/admin-secret.ts`. All seven gates now call it; the `!==` is
  gone.
- `sync-worker/src/lib/service-auth.test.ts` — the part that matters. Two source
  scans over the whole worker: no `Authorization` header may be compared with
  `===`/`!==`, and no receiver may build `Bearer ${SYNC_SECRET_KEY}` to compare
  by hand. **Both scans self-test against the exact offending lines this change
  removed**, so a scan that has silently stopped matching fails loudly instead of
  reading as clean — the failure mode `pnpm audit:deps` already guards against
  with its implausible-dependency-count check.

Two notes for whoever touches this next:

- The scan discriminates **senders from receivers** by whether the bearer
  template sits inside a headers literal. That is not cosmetic:
  `events/route.ts` and `events/link-sync-route.ts` both read an `Authorization`
  header (to verify a *sync-token JWT* — a signature check, not a secret
  compare) *and* forward `Bearer ${SYNC_SECRET_KEY}` to the DO. A cruder scan
  flags both, and a test that cries wolf is a test someone deletes. Worth
  recording: these two files are invisible to `grep`, which classifies them as
  binary — the scan reads them because it is a scan and not a grep, which is
  part of why it found what three passes of reading did not.
- `serviceBearerMatches` deliberately does **not** trim, unlike
  `resolveAdminSecret`. admin-secret can trim because it also owns its senders;
  here the sender is another Worker building the header from its own binding, so
  trimming one side only converts a secret stored with a trailing newline from
  "works" into "401s in production". Asserted in the test so nobody tidies it.

### OPS-12 — [FACT] The Stripe webhook rejects every event during a webhook-secret rotation — **fixed in this change**

`verifyStripeSignature` (`auth-worker/src/lib/billing/stripe.ts`) parsed the
`Stripe-Signature` header with `Object.fromEntries`, which keeps the **last**
value for a repeated key. The header repeats `v1` in exactly one situation: a
webhook secret rollover, during which Stripe signs each event with both the old
and the new secret and sends both signatures.

So an endpoint mid-rotation verifies against whichever signature happened to be
last, holds the secret matching the other one, and returns 400 to every event
until the rollover completes. Fail-closed, so nothing is *forged* — but billing
state drifts silently behind Stripe's for the length of the window
(subscriptions not applied, add-on packs not credited, cancellations not
reflected), and Stripe's retries eventually give up.

**This is an OPSEC finding, not a billing bug.** A control that breaks during
credential rotation is a control that teaches its operator not to rotate. This
series' top recommendation for three consecutive passes has been a secrets
change (SEC-1); shipping a rotation-hostile verifier in the same codebase works
directly against that.

**Fixed:** every `v1` candidate is checked, with no early return so the work does
not depend on which position matched. Tests cover both orderings, the all-wrong
case, and that a `v0` signature is not accepted in place of `v1` (v0 covers a
different payload).

### OPS-13 — [FACT] The required CI check is red on `dev`, and its fail-fast structure means the credential scan never runs — **partially fixed in this change**

Found by opening this pass's own PR: `Workers Builds: aquilla-web-preview`
failed on a diff containing no `src/` change at all. `git diff` against `dev`'s
head confirms `src/`, `e2e/`, `scripts/` and `package.json` were byte-identical,
so the failure could not be the PR's.

It is `dev`'s. Verified by checking out `9890424c` (dev's head) and running the
lanes directly:

- `pnpm lint` → **484 errors, 375 warnings across 390 files**, every error
  `i18n/no-unkeyed-string` from the gate added 2026-08-12. None of the 390 files
  is one this change touches.
- `pnpm test` → **7 failures**, i18n catalogue collisions
  (`src/lib/i18n/namespaces/no-duplicates.test.ts`: "Stop" leaves `common.stop`
  and `agentWorkspace.stop` colliding).

The structural consequence is the finding. `scripts/cloudflare-ci-checks.mjs`
runs three sequential *phases* of parallel *lanes*; lane steps are a
`for (…) await run(…)` loop, and a phase that fails throws before the next one
starts. So a red step does not merely fail the build — **everything after it in
its lane, and every later phase, does not execute**:

| Never ran while phase 1 is red | Why it matters |
|---|---|
| `pnpm run scan:secrets` | Sat last in the lint lane. Its own comment in the script says it was put there deliberately so it would ride an already-required check, "because a secret scan that can be merged past is decoration". It is now past skippable: it does not run. |
| `pnpm run i18n:check` | Same lane, same position problem. |
| phases 2–3 entirely | sync-worker suite, identity suite, release contracts, `test:worker`, the SPA build. |

That is OPS-4 and V4's exact class — a control that quietly stopped running —
and it swallowed the one control this series has cited as working in every pass
since 2026-08-10. It is also why **this PR cannot be green**: the check dies in
phase 1, before reaching the lanes the OPS-11/OPS-12 code lives in. Those two
suites were run directly instead (1240 and 1257 passing).

**Fixed (the OPSEC half):** `scan:secrets` now runs **first** in the lint lane,
so an unrelated lint regression can no longer take the credential scan off the
board, and a committed credential fails the build in seconds rather than after
a full lint pass. `scripts/cloudflare-ci-checks.test.ts` pins the position —
position, not presence, is the control, and the old test only checked presence.

**Not fixed:** the 484 lint errors and 7 test failures themselves. They are an
i18n backlog, not a security matter, and draining them inside an OPSEC PR would
bury a security diff under a few hundred string changes. **They need an owner
now** — while phase 1 is red, no backend or SPA lane is gating anything that
merges to `dev`.

**JUDGMENT, worth stating plainly:** a fail-fast pipeline is the right design
for build speed and the wrong design for controls that must not be skippable.
Anything whose value is "it cannot be bypassed" — the credential scan today,
`audit:deps` if it is ever folded in — should not sit downstream of a step that
can go red for unrelated reasons. Moving the scan to first is the cheap fix; the
durable one is a lane that runs the non-negotiable checks and nothing else.

### New surface reviewed with no finding — [FACT]

Recorded deliberately. A review series that only ever publishes hits gives no
information about the code it read and cleared.

- **Knowledge base** (`auth-worker/src/routes/knowledge.ts`, 569 lines, largest
  new surface). Role floors on both routers (VIEWER to read, PROJECT_LEAD to
  upload/delete/reindex; org: member to read, MAINTAINER to write).
  Cross-scope reads go through `projectVisibleDoc`, which re-derives the
  project's org rather than trusting the doc — no IDOR. Size caps on both the
  original and the extraction input. R2 object rolled back when the metadata
  insert fails, so a failure leaves no dangling blob. Most notably, the
  stored content type is derived from the **validated extension**, never the
  client's `Content-Type`, with a comment explaining that `/original` serves it
  back `inline` and a mislabelled `.md` would otherwise be stored XSS on the
  worker origin. Someone had already asked the OPS-8 question here.
- **Stripe billing** beyond OPS-12: webhook secret absent ⇒ 503 unless
  `WRANGLER_LOCAL`, so an unconfigured deploy fails closed; HMAC-SHA256 over
  `t.payload` with a 300s tolerance (replay-bounded) and a constant-time compare;
  `packs` and `orgId` read from **Stripe-attested** session metadata, not from
  the request; authenticated routes require maintainer+; `retrieveSubscription`
  re-reads from Stripe rather than trusting the webhook body.
- **EPUB importer** (`src/lib/parsers/epub.ts`): guarded by
  `assertSafeArchiveInputSize` / `assertSafeZipArchive` before anything is read,
  and `normalizeZipPath` resolves `..` segments away, so the classic zip-slip and
  decompression-bomb paths are covered. Extracted chapter HTML reaches
  `originalHtml` verbatim, exactly like the HTML importer — which is safe
  **because of** the OPS-8 fix, and would not have been before it.
- **OPS-8's fix survived a refactor.** `SanitizedRichHtml` moved out of
  `EditorTable.tsx` into `src/components/cell/EditorCellContent.tsx`; it still
  calls `sanitizeSourceDisplayHtml` and still carries `data-ph-mask`. Verified
  by reading, not assumed from the test passing.

### Observation — [FACT] `auth-worker` type-check has two pre-existing errors

`npm run type-check` in `auth-worker/` fails with two `ExecutionContext` variance
errors at `src/index.ts:172,182` — a `@cloudflare/workers-types` drift, not a
security issue. Confirmed pre-existing by stashing this change and re-running.
Recorded because a type-check that is already red is a check nobody reads, which
is the same failure class as OPS-4. `sync-worker` type-checks clean.

### Carried forward, unchanged

- **SEC-1 / V7** — prod and dev share `SECRET_KEY` / `SYNC_SECRET_KEY`. **Fourth
  review running as the top item.** OPS-11 raises its cost: the shared key now
  authorises seven internal endpoints as well as minting tokens.
- **OPS-2** — `SYNC_SECRET_KEY` accepted as an admin bearer on sync-worker's
  operator routes. `ADMIN_SECRET` is accepted; the fallback branch is still
  there. Re-verified this pass that provisioning `ADMIN_SECRET` **cannot** break
  the identity → sync service calls: those four endpoints are dispatched before
  `handleAdminRequest` and verify `SYNC_SECRET_KEY` directly, so
  `adminBearerMatches`'s exclusive precedence does not reach them. The 08-13
  claim holds; it is now checked rather than asserted.
- **OPS-10 / SEC-9** — `sync-token` still auto-registers an unknown project ID
  with the caller as OWNER (`sync-token.ts:98-111`, unchanged).
- **OPS-1 / V2** — CSP still mostly report-only, `img-src`/`connect-src` still
  `https:` wildcards. See §5 recommendation 3, unchanged from 08-13.

---

## 4. Risk assessment

Likelihood over roughly the next year, assuming current practices.

| ID | Vulnerability | Likelihood | Impact | Risk | State |
|---|---|---|---|---|---|
| SEC-1 / V7 | Prod and dev share `SECRET_KEY` / `SYNC_SECRET_KEY` | Low | **Critical** — mints any credential, and now authorises seven internal endpoints | **High** | **Open — top item, fourth pass** |
| OPS-2 | Signing key accepted as admin bearer | Medium — one careless paste | **Critical** | **High** | Partially addressed |
| OPS-11 | Seven hand-written copies of the service bearer gate; one non-constant-time | Certain (it had already happened) — exploitation of the timing leak itself: very low | Medium-High — the leak is impractical; the *recurrence mechanism* is what reaches the critical secret | **Medium** | Fixed |
| OPS-1 / V2 | CSP mostly report-only | Medium | High — one XSS ⇒ 30-day token + user API keys | **Medium** | Partial |
| SEC-2 / V8 | 30-day access tokens | Medium | High | **Medium** | Partial (revocation exists) |
| OPS-13 | Credential scan (and every backend lane) not running, because the required check is red upstream of them | Certain — it is the current state of `dev` | Medium-High — a committed secret would merge unflagged | **Medium-High** | Partially fixed |
| OPS-12 | Webhook verification breaks during secret rotation | Certain, *if* the secret is ever rotated | Low-Medium — billing drift; no forgery | **Low-Medium** | Fixed |
| OPS-10 / SEC-9 | Auto-register grants OWNER on an unknown project ID | Low | Low-Medium — quota bypass | **Low-Medium** | Open |

The pattern the last three passes identified holds for a fourth: **none of the
high-risk rows is a sophisticated attack.** SEC-1 is a documented convenience
trade-off; OPS-2 is a habit; OPS-11 is copy-paste. The new observation this pass
adds is about *why they survive review*: OPS-8 hid behind a correct-looking
comment, OPS-9 behind an audit pointed at the wrong directory, OPS-11 behind six
correct siblings. In each case the code was individually readable and the
problem was only visible from a different altitude.

---

## 5. Countermeasures

### Applied in this change

| Control | Where | Test |
|---|---|---|
| One constant-time service-bearer helper, used by all seven internal gates | `sync-worker/src/lib/service-auth.ts` + `member-removed.ts`, `project-archive.ts`, `project-settings-notify.ts`, `contextual-activity-notify.ts`, `project-do.ts` ×3 | `sync-worker/src/lib/service-auth.test.ts` |
| Source scan banning a hand-rolled `Authorization` compare anywhere in sync-worker | same | same — and the scans self-test against the removed lines |
| Stripe webhook survives a secret rollover | `auth-worker/src/lib/billing/stripe.ts` | `auth-worker/src/__tests__/billing-routes.test.ts` |
| Credential scan runs first in its lane, so an unrelated lint failure cannot take it off the board | `scripts/cloudflare-ci-checks.mjs` | `scripts/cloudflare-ci-checks.test.ts` (pins the position, not just the presence) |

The series convention holds: every control above has a test, or is itself the
test. OPS-11's real deliverable is the scan, not the helper — the helper fixes
seven sites, the scan fixes the eighth one nobody has written yet.

### Recommended next, in order

0. **Get `dev` green (OPS-13).** Listed ahead of SEC-1 not because it is more
   dangerous but because it is blocking: while phase 1 of the required check is
   red, nothing in phases 2–3 gates a merge, and the reordering shipped here
   only rescues the credential scan. 484 lint errors and 7 test failures, all
   i18n, all pre-existing on `dev`. Needs an owner with the i18n context.
1. **Split `SECRET_KEY` / `SYNC_SECRET_KEY` per environment (SEC-1).** Fourth
   review running as the top item. A dev-environment compromise mints
   production-valid tokens, and neither environment can be rotated alone.
   OPS-11 widened what the key authorises, so the case is stronger than last
   pass, not weaker.
2. **Give the service calls their own credential, and finish OPS-2.**
   `service-auth.ts` is now the single place that would change: add
   `SERVICE_SECRET` with the same exclusive-precedence contract
   `admin-secret.ts` uses, teach the identity Worker's four callers to send it,
   then delete the `SYNC_SECRET_KEY` branches on both sides. Sequence it
   receiver-first (accept both) → sender (send the new one) → receiver (drop the
   old), so no step can lock the pair out. Before this change that plan touched
   seven files; now it touches one plus the senders.
3. **Narrow `img-src` and `connect-src`, then promote the CSP.** Unchanged from
   08-13 and still not done. `img-src … https:` permits every host on the
   internet, so promoting the report-only policy as-is would not have stopped
   OPS-8. The blocker is real — the API, sync, PostHog and model hosts are
   injected at build time (`VITE_*`), so a static `_headers` cannot name them —
   and the way through is to **generate** the policy at build time from the same
   env the SPA is built with, keeping `worker/security-headers.ts` and
   `public/_headers` in parity by construction rather than by assertion. That is
   a build-pipeline change, not a header edit, which is why it keeps not
   happening in an unattended pass.
4. **An E2E assertion that a source cell cannot issue an outbound request.**
   Unchanged from 08-13. The OPS-8 unit test pins configuration because
   happy-dom cannot pin behaviour; only a real browser can test the property.
5. **Add the quota check to project auto-registration (OPS-10).**
6. **Shorten the access-token TTL (SEC-2).** Revocation exists; 30 days is now a
   UX choice.
7. **Fix the two `auth-worker` type errors** so the check is worth reading.

### Operator-side practices — still not verifiable from here

Unchanged from 08-13 and repeated because a phished maintainer still outranks
every technical control in this document: hardware-backed MFA (not SMS, not
TOTP) on Cloudflare, GitHub, Neon, OpenRouter, Stripe and the Apple developer
account; a password manager with unique credentials per service;
code-signing keys compartmentalised away from any session that reads a PR;
`CLOUDFLARE_API_TOKEN` scoped to the Workers it deploys; invite links and access
links treated as credentials; never paste a signing key into a shell
(`pnpm admin:request` exists for this).

**New this pass:** the Stripe dashboard is now a production credential store.
It can issue refunds, read customer records, and rotate the webhook secret this
codebase verifies against. It belongs on the hardware-MFA list, and its API keys
belong in the same rotation plan as the Worker secrets.

### Training

Unchanged from 08-13 (console-targeted phishing; what the product's data means;
imported files are untrusted input), plus one this pass adds:

- **Copy-paste is a security decision.** OPS-11 is not a lapse of care — the
  seventh copy was written by someone doing exactly what the six before it did.
  When a check is about to be written a second time, the correct move is to
  extract it, and when it is about to be written a *seventh* time, the correct
  move is to extract it and add the scan that stops the eighth.

---

## 6. Effectiveness of existing controls

Re-verified against the tree at this commit, not assumed.

### Working, keep

- **`AuthorizedEvent` perimeter** — symbol-branded, ESLint-enforced, single
  construction site. Still the strongest thing in the codebase, and now the
  explicit model for OPS-11's fix.
- **Secret scanning** — `pnpm scan:secrets` clean across every tracked file when
  run by hand. Qualified sharply by OPS-13: it had not been running in CI at
  all, so "clean" here is this review's own run, not a standing guarantee.
- **Dependency audit** — `pnpm audit:deps` reports **0 advisories across all
  four lockfiles**. OPS-6/OPS-9's weekly job is doing exactly what it was added
  to do: the nine-advisory backlog has not returned, and the `hono` floor that
  went stale in three consecutive reviews has not gone stale again.
- **Session-replay masking (OPS-3)** — survived the `EditorTable` →
  `EditorCellContent` refactor; the selector ↔ markup parity test is what makes
  that verifiable rather than lucky.
- **Source-HTML allowlist (OPS-8)** — survived the same refactor. It is also
  what makes the new EPUB importer safe by default.
- **`unauthenticatedBypassError`, PAT hashing, security-header parity,
  `WRANGLER_LOCAL` gating** — unchanged since 08-13; no re-verification
  performed this pass beyond reading the call sites touched by other work.

### Needs adjustment

| Control | Problem | Action |
|---|---|---|
| Secret scanning in CI | Ran last in a lane whose first step is red on `dev`, so it did not run at all (OPS-13) | Fixed — runs first, position pinned by a test |
| The required check itself | Red on `dev`; phases 2–3 never execute, so no backend or SPA lane gates a merge | Open — recommendation 0 |
| Service-to-service bearer check | Seven hand-written copies; one non-constant-time (OPS-11) | Fixed — one helper + a drift scan |
| Stripe webhook verification | Broke during secret rollover (OPS-12) | Fixed — all `v1` candidates checked |
| `SYNC_SECRET_KEY` as service bearer | One secret authorises seven endpoints *and* signs every sync token | Open — recommendation 2 |
| `SYNC_SECRET_KEY` as admin bearer | Fallback branch still live (OPS-2) | Partially fixed |
| Environment separation | Explicitly defeated for signing keys (SEC-1) | Open — recommendation 1 |
| Report-only CSP | `img-src … https:` would not have blocked OPS-8 | Open — needs build-time generation, recommendation 3 |
| `auth-worker` type-check | Two pre-existing errors; a red check is an unread check | Open — recommendation 7 |

### June findings, re-checked

| Finding | Status | Evidence |
|---|---|---|
| SEC-1 — shared signing keys across envs | **Open** | Top item, fourth pass. |
| SEC-2 — 30-day tokens, no revocation | **Substantially fixed** | `jti` denylist + server-side logout; TTL unchanged. |
| SEC-3 — unbounded LLM proxy | **Fixed** | `creditGuard`/`recordCredit`, model allowlist, budgets. |
| SEC-4 — no auth rate limiting | **Fixed** | Login, reset, contact, register, admin step-up. Access-link redemption is throttled by its own scrypt + per-link lockout (pen-tested 2026-07-27, including the counter race). |
| SEC-5 — `SYNC_SECRET_KEY` as admin bearer | **Improving** | `ADMIN_SECRET` accepted since 08-13; carried as OPS-2. The *service* half is OPS-11 and is now behind one helper. |
| SEC-6 — no CSP; script-readable token storage | **Half fixed** | Enforced subset + report-only full policy + `_headers` parity. Storage unchanged. |
| SEC-7 — dependency CVEs | **Fixed, and watched** | All four lockfiles at zero advisories, unprompted, four days after the last manual pass. |
| SEC-8 — misleading dev-bypass comment | **Fixed** | Closed 2026-08-10 as OPS-5. |
| SEC-9 — sync-token auto-registers as OWNER | **Open** | Unchanged. Carried as OPS-10. |
| SEC-10 — scrypt work factor | **Open (accepted)** | Legacy byte-compatibility constraint unchanged. |
| SEC-11 — error detail leaked outside production | **Substantially closed** | Two narrow residuals recorded 08-13, unchanged. |

**Reading of the trend.** Mixed, and the mix is the lesson. The controls that
run on their **own** schedule earned their keep unsupervised: the weekly
dependency audit carried a 150-commit window to zero advisories with nobody
watching, and the OPS-3/OPS-8 fixes survived a refactor that moved their call
sites to another file. The control that runs **downstream of something else**
did not: `scan:secrets` was placed inside a required check precisely so it could
not be skipped, and then stopped executing entirely the moment an unrelated lane
step went red (OPS-13).

Stated as a rule the next pass can use: **a control's reliability is bounded by
what it depends on to run.** Independent schedule → held. Shared conditional
path → silently gone. Every prior finding in this series about a control that
stopped working (V4, OPS-4, OPS-6, now OPS-13) has that same shape.

What remains is what has remained since June: the items that need a **secrets or
settings decision** rather than a patch. SEC-1, the rest of OPS-2, and the CSP
host lists cannot be closed by an unattended change, and they have now been the
recommended next step four reviews running. Recommendation 2 is materially
cheaper than it was last week — the service-credential migration went from seven
files to one plus its senders — which is the most useful thing this pass can
hand to the person who eventually does it.

## Next review

Whichever comes first: `ADMIN_SECRET`/`SERVICE_SECRET` and the per-environment
signing keys being provisioned (verify the fallbacks can be removed, then remove
them); the CSP report-only console coming back clean with narrowed host lists;
the first paying org that self-identifies as working in a restricted context; or
three months.

_Re-run the mechanical parts with: `pnpm run scan:secrets`, `pnpm run audit:deps`,
`pnpm run test:worker`, `pnpm test`, `cd sync-worker && npm test`, and
`cd auth-worker && npm test`._
