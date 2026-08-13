# Operational Security Review — 2026-08-11

_Scope: the operational security of **this project** — the data Aquilla handles, who would want
it, where the practices around it are weak. This is a follow-up pass to
`docs/OPSEC-REVIEW-2026-08-10.md` (OPS-1…OPS-7) and `docs/SECURITY-NOTES-2026-06-10.md`
(SEC-1…SEC-11). §1 and §2 of the 08-10 review — the asset ranking and the threat model — are
**unchanged and not restated here**; read them there. This document records what is new._

New findings are numbered **OPS-8** onward. Each is labelled **FACT** (verified against the tree
at this commit) or **JUDGMENT** (reasoned inference).

> **Headline.** Yesterday's review closed OPS-6 with a recommendation rather than a control, and
> named the risk precisely: _"Nothing yet prevents the **next** advisory."_ The next advisory was
> already in the tree. This pass found a live XSS advisory in the SPA's own HTML sanitizer and
> four more in the HTTP framework of all three Workers — twelve hours after the review that
> predicted them. All are fixed here, and OPS-6 is now closed with an actual gate instead of a
> suggestion.

---

## 0.1. Three documents, two numbering series — read this first

_(Added 2026-08-13, after `origin/dev` was merged into this branch.)_

There were **two independent OPSEC efforts running in parallel**, on branches that could not see
each other. They have now met, and this repository currently holds three overlapping reviews:

| Document | Series | Origin |
|---|---|---|
| `docs/OPSEC.md` | **V1–V9** | Authored 2026-08-06 on a separate branch; reached `dev` after this branch was cut |
| `docs/OPSEC-REVIEW-2026-08-10.md` | **OPS-1–7** | On `dev` 08-10 |
| `docs/OPSEC-REVIEW-2026-08-11.md` (this) | **OPS-8–11** | This branch |

Neither series is wrong; they were written without knowledge of each other, and in several places
they **independently found and independently fixed the same thing**:

| V-series | OPS/SEC equivalent | Note |
|---|---|---|
| V2 — no HTTP security headers | **OPS-1** | Same finding, fixed twice on two branches |
| V4 — the SPA Worker's tests never ran | **OPS-4** | Same finding, same fix |
| V4a — GitHub Actions not producing meaningful results | OPS-4's `workflow_dispatch` note | Same root cause |
| V5 — no credential scanning | **closes OPS-6's scanning half** | See §5.10 — this review's original recommendation was stale |
| V6 — dependency vulnerabilities | **OPS-6 / OPS-8 / OPS-9** | V6 assessed them; OPS-6 adds the recurring gate |
| V7 — signing keys shared prod/dev | **SEC-1** | Open in both |
| V8 — 30-day access tokens | **SEC-2** | Open in both |
| D1 "plaintext admin bearer" | **OPS-2** | Closed in code by this change |

**Consolidation is deliberately not attempted here.** Rewriting someone else's review to fit this
one's numbering is an editorial call for a maintainer, not something to do unattended in a
security change — and picking the wrong survivor would lose findings (V1, V3 and V9 have no
OPS-series equivalent at all). The two series should be merged into one standing document with one
status table; until that happens, **`docs/OPSEC.md` §3 and this document's §6 must both be checked**
before concluding that something is open or closed. That duplication is itself the argument for
doing the merge soon.

## 0. A note on running this review again

This is the second OPSEC pass in two days, which is faster than the 08-10 document's own stated
cadence (_"or three months"_). That is fine for a pass that finds something, and wasteful for one
that does not.

**Guidance for the next run:** re-run the mechanical checks every time (they are cheap and they
are what caught OPS-8 and OPS-9), but **amend the most recent review in place** unless the finding
set materially changes. Create a new dated document only when there are new numbered findings.
A directory of near-identical dated reviews makes the current posture harder to find, not easier,
and the whole value of the status table in §6 is that there is exactly one of it.

The mechanical checks, in order of what they have actually caught:

```bash
pnpm audit:deps          # OPS-6 gate — advisories not in .github/audit-allowlist.json
pnpm test:worker         # OPS-4 — SPA Worker deployment-config guards
curl -sI https://dev.aquilla.app/some/never-requested/path | grep -i 'content-security\|x-content-type'
                         # OPS-7 — measure headers on a path the asset router serves, not the Worker
```

---

## 3. Vulnerabilities observed this pass

### OPS-8 — [FACT] The SPA's own HTML sanitizer carried an XSS advisory — **fixed in this change**

`dompurify` was pinned at `3.4.12`, which is covered by GHSA advisory _"IN_PLACE hook removal
leaves a detached subtree executable, causing XSS"_ (moderate, patched in `3.4.13`).

**Reachability, checked rather than assumed: not currently exploitable here.** The advisory
requires `IN_PLACE: true` or a removed hook, and this codebase uses neither — every call site
(`src/lib/richtext/editor-content.ts`, `EditorTable.tsx`, `CommentThread.tsx`, `CommentsPage.tsx`)
uses the default string-returning mode with an explicit tag/attribute allowlist, and
`grep -rn "IN_PLACE\|addHook\|removeHook"` over `src/` returns nothing.

It is still the most important dependency in the tree to keep current, because it is the single
control standing between synced HTML — content that arrives from other users through the event
log — and three `dangerouslySetInnerHTML` sinks. June's SEC-7 audit listed "XSS sinks are
sanitized" as a **strength** (S5). That strength is only as good as the sanitizer's version.

Fixed by raising the declared floor to `^3.4.13` and updating the lockfile.

### OPS-9 — [FACT] Four `hono` advisories across all three Workers — **fixed in this change**

Every Worker resolved a `hono` below `4.12.34`, which patches four advisories:

| Advisory | Severity | What it is |
|---|---|---|
| GHSA-f23p-vx2j-j53r | moderate | `memo()` retains SSR output across requests → **cross-user data disclosure** |
| GHSA-8j4g-w8fx-2239 | moderate | ReDoS in the CORS middleware via `Access-Control-Request-Headers` |
| GHSA-54fx-42gc-7vw4 | moderate | Algorithmic-complexity DoS in the Language middleware |
| GHSA-79qm-7rj5-m7r9 | low | Proxy helper does not strip response headers named in `Connection` |

**Reachability: none of the four are reachable today.** Verified by import analysis, not by
assumption — the workers hand-roll CORS (`sync-worker/src/cors.ts`, `withCors`/
`handleCorsPreflight`) rather than using `hono/cors`; `memo()` and `hono/jsx` are never imported;
neither is the language middleware or the proxy helper.

That is a statement about today's import graph, and it is exactly the kind of statement that
quietly stops being true. The `memo()` one is worth naming specifically: adding one SSR helper to
a Worker would turn a dormant advisory into cross-user data disclosure on a service that holds
asset #1.

Fixed by raising the declared floor to `^4.12.34` in all three Workers, with all six worker
lockfiles (`package-lock.json` + `pnpm-lock.yaml` each) updated to resolve `4.13.1`.

**This is SEC-7 recurring, exactly as predicted.** June fixed `hono` by hand; August found the
declared range still permitted a vulnerable resolution and raised the floor; twelve hours later
there were four new advisories in the same package. The lesson is not "bump `hono` again" — it is
that a dependency-advisory *control* was the missing piece, which is OPS-6, closed below.

### OPS-10 — [FACT] The second admin gate never received the SEC-5 constant-time fix — **fixed in this change**

June's SEC-5 flagged `SYNC_SECRET_KEY` being compared with a short-circuiting `===` on the admin
route, and it was fixed in `sync-worker/src/admin.ts` via `secureCompare`. There are **two**
admin gates. The other one — `DELETE /audio/*` in `sync-worker/src/audio.ts:135` — still read:

```ts
if (adminExpected && auth === adminExpected) {
```

So the fix landed on the route someone was looking at, and the identical pattern one file over
kept a timing oracle on the token-signing key. The `secure-compare.ts` module's own header comment
says it was centralised _"so every shared-secret comparison in the worker gets it, not just the
two routes someone happened to think of it for"_ — and then this call site was not migrated.

A network-observable timing side channel on a string compare is a hard attack in practice, so the
practical risk is low. The finding that matters is the pattern: **a security fix was applied to an
instance rather than to a class.** Both gates now route through one helper, so there is no longer
a second place to forget.

### OPS-11 — [FACT] SEC-11 remnant: raw internal errors echoed to unauthenticated callers in production — **fixed in this change**

SEC-11 was carried forward from June as "not re-verified". Re-verified now. The
`/password-reset/request` half is fixed. The `/register` half is not, and is worse than June
described — June said detail leaked _outside_ production, but this branch had no environment gate
at all (`auth-worker/src/routes/auth.ts:311`):

```ts
if (msg.includes("409")) {
  return c.json({ detail: msg, error: msg }, 409)   // every environment, including prod
}
```

Any internal exception whose message merely *contained* the substring `409` — a Postgres error
string, an upstream URL with a port or an ID in it, a constraint name — was reflected verbatim to
an unauthenticated caller on a public registration endpoint. The environment-gated branch below it
(leaking `msg` in non-production) is the one June actually described; it is also removed, since
`console.error` already logs the full error server-side where it belongs.

---

## 4. Risk assessment

| ID | Likelihood | Impact | Risk | Note |
|---|---|---|---|---|
| OPS-8 | Low today — needs an unused DOMPurify mode | High — XSS reaching a 30-day token and the user's own provider keys | **Medium** | Rated on what it guards, not on today's call sites. One refactor to `IN_PLACE` makes it live. |
| OPS-9 | Low today — none of the four middlewares are imported | High for `memo()` (cross-user disclosure) if it ever is | **Medium** | Dormant, not absent. Cost to close was one version bump. |
| OPS-10 | Very low — remote timing attack on an HMAC-length string | Critical if it landed — the key mints sync tokens for any project | **Low** | Kept for the pattern, not the exploit: a class-wide fix applied to one instance. |
| OPS-11 | Certain — it was the shipped behaviour on a public endpoint | Low-Medium — infrastructure strings, no credentials | **Medium** | Unauthenticated, in production, and free to trigger. |
| OPS-6 (prior) | — | — | **Closed** | Was the detection gap that let OPS-8 and OPS-9 exist. See §5. |

Ranked action order for what remains: **OPS-2 (secrets provisioning), SEC-1 (per-environment
keys), OPS-3 (consent copy), SEC-9**.

---

## 5. Countermeasures

### Implemented in this change (code)

1. **OPS-6 closed with a real gate — `scripts/audit-deps.mjs` + `.github/workflows/dependency-audit.yml`.**
   Weekly scheduled (Mondays 09:00 UTC) plus `workflow_dispatch`; `pnpm audit:deps` runs it
   locally. It normalises both audit JSON shapes (pnpm emits npm-v6 `advisories`, npm v7+ emits
   `vulnerabilities`) across the root workspace and all three Workers.

   Two design decisions, both taken from the prior review's own post-mortems:

   - **Not a pull-request gate.** A per-PR advisory check fails on advisories the PR author did
     not introduce and cannot fix, and the trained response is to ignore the lane. That is the
     OPS-4 failure mode — a check nobody reads is not a control.
   - **Fails only on advisories absent from `.github/audit-allowlist.json`.** Without an
     allowlist the job would be red on its first run from the unreachable transitive set below,
     and permanent red is the same as no signal. Each allowlist entry requires a written
     reachability argument and a `reviewBy` date, so "accepted" is a recorded decision rather
     than a silence. **Red therefore always means "something new arrived."**

2. **OPS-8 — `dompurify` floor raised to `^3.4.13`**, lockfile updated.

3. **OPS-9 — `hono` floor raised to `^4.12.34`** in `auth-worker`, `sync-worker` and
   `agent-worker`; all six worker lockfiles updated (resolving `4.13.1`).

4. **OPS-2 partially closed in code — `ADMIN_SECRET`.** New `sync-worker/src/lib/admin-secret.ts`
   is the single place that decides what counts as an admin bearer, used by both admin gates.
   Precedence is deliberately **one or the other, never both**: when `ADMIN_SECRET` is set it is
   the only accepted value, and `SYNC_SECRET_KEY` is accepted only while an environment has not
   been provisioned yet.

   The 08-10 review left this out of scope because it needs the secret provisioned first, in the
   right order, to avoid locking out ops. The fallback removes that ordering constraint — the
   code can ship now and each environment closes the gap when `wrangler secret put ADMIN_SECRET`
   runs against it. Tests in `sync-worker/src/__tests__/admin.test.ts` pin all of it, including
   the one that matters most: **provisioning the dedicated secret must narrow what is accepted,
   not widen it.**

5. **OPS-10 — `DELETE /audio/*` now uses the same constant-time helper** as `/admin/files/*`.

6. **OPS-11 — generic error responses on `/register`**, with detail kept to the server-side log.

7. **OPS-3 partially closed — `data-ph-mask` on the cell-text surfaces.** PostHog masks inputs,
   but the drafting surface is a TipTap **contenteditable** and the read surfaces are rendered
   page text, so `maskAllInputs` reached neither and session replay captured unpublished
   translation content verbatim. The attribute now sits on the shared target-read wrapper (so a
   new target-text renderer inherits it rather than having to remember it), on the editor content
   element, and on the source rich-text renderer. `src/lib/posthog.mask.test.ts` asserts the
   attribute and the configured `maskTextSelector` cannot drift apart — the same parity-guard
   pattern `worker/security-headers.test.ts` uses for `public/_headers`.

   Verified that `@tiptap/react`'s `EditorContent` spreads unknown props onto its rendered `div`
   (`...rest` in `node_modules/@tiptap/react/dist/index.js`), because an attribute silently
   dropped by a component would be precisely the kind of placebo control OPS-7 was.

### Recommended, requiring an owner decision (not implemented here)

8. **OPS-2 — provision `ADMIN_SECRET` per environment** (`wrangler secret put ADMIN_SECRET
   --env <name>`). The code is ready and backward-compatible; until this runs, the signing key is
   still accepted and the OPS-2 risk is unchanged. Once every environment has it, delete the
   fallback branch in `lib/admin-secret.ts` and drop `SYNC_SECRET_KEY` from the two admin `Env`
   types — that is when a signing key presented on an admin route starts being *rejected*, which
   is the actual goal.
9. **SEC-1 — split `SECRET_KEY`/`SYNC_SECRET_KEY` per environment.** Still the single
   highest-leverage change in the system, and still open since June.
10. **OPS-6 credential-scanning half — ~~enable GitHub secret scanning + push protection~~
    already done on `dev`, as V5.** _(Revised 2026-08-13 — see §0.1.)_ This originally read
    "the only part of OPS-6 that code in this repo cannot close." That was wrong at the time of
    writing and is wrong now: `scripts/secret-scan.ts` (`pnpm scan:secrets`) landed on the 08-06
    branch and runs in `scripts/cloudflare-ci-checks.mjs` — the lane that actually gates pull
    requests — as well as in the `ci.yml` fallback. Verified passing on this branch.

    What remains is genuinely a repository setting and still worth doing, because the two catch
    different things: the local scanner sees only what reaches a commit in this repo, while
    **GitHub push protection** blocks a credential at push time across every branch and fork, and
    **secret scanning** retroactively finds one already in history. Enable both; do not treat V5
    as making them redundant.
11. **OPS-3 remainder — make the replay trade-off explicit in the consent copy.** Masking is
    defence in depth; the consent text still says "analytics" while the asset at stake is
    unpublished translation content. For any org self-identifying as working in a restricted
    context, default replay off and do not offer it.
12. **SEC-9 — sync-token still auto-registers an unknown project and grants the caller OWNER**
    (`auth-worker/src/routes/sync-token.ts:98-111`). Unchanged since June; carried forward again.

### Practices (people, not code)

13. **Never paste a signing key into a shell.** `ADMIN_SECRET` exists so this is no longer
    necessary for admin routes — use it once provisioned, and read it from the environment rather
    than typing it.
14. **Treat "not reachable today" as an expiry date, not a verdict.** OPS-8 and OPS-9 are both
    non-exploitable *given the current import graph*. That is a property of the code, and code
    changes. This is why the allowlist entries carry `reviewBy`.
15. **Fix the class, not the instance.** OPS-10 is one line, and it existed because SEC-5 was
    fixed where it was found instead of everywhere it applied. When a finding names a pattern,
    grep for the pattern before closing it.
16. **Hardware-key 2FA on the Cloudflare and GitHub accounts** remains worth more than any single
    item in this section. Unchanged from 08-10 §5.12.

---

## 6. Effectiveness check — status of every open finding

Re-verified against the tree at this commit, not assumed.

| Finding | Status | Evidence |
|---|---|---|
| OPS-1 — no CSP / transport headers on the web build | **Holds** | `worker/security-headers.ts` present and wired; enforced set + report-only CSP unchanged. |
| OPS-2 — signing key doubling as the admin bearer | **Half closed (was: open)** | Code path done (`lib/admin-secret.ts`, both gates, tests). Closes fully when `ADMIN_SECRET` is provisioned — §5.8. |
| OPS-3 — session replay records draft translations | **Half closed (was: open)** | Masking landed with a drift guard (§5.7). The consent-copy half is still open — §5.11. |
| OPS-4 — worker suite no CI lane ran | **Holds** | `pnpm test:worker` still present in `scripts/cloudflare-ci-checks.mjs:34` (the lane Cloudflare Workers Builds actually runs) and mirrored in `ci.yml:108`. |
| OPS-5 — misleading dev-seed comment | **Holds** | Corrected comment still in place. |
| OPS-6 — no dependency/secret scanning | **Closed, both halves** | Dependencies: `scripts/audit-deps.mjs` + weekly workflow; green at 0 new / 8 accepted. Credentials: `scripts/secret-scan.ts` (V5) runs in the gating lane — verified passing here. GitHub push protection is still worth enabling and catches a different case — §5.10. |
| OPS-7 — assets bypass the Worker, headers reached one URL | **Holds** | `public/_headers` present; `worker/security-headers.test.ts` still enforces parity with `security-headers.ts`. Not re-measured against the live deployment this pass — worth a `curl` on the next one (§0). |
| SEC-1 — shared signing keys across environments | **Open** | Unchanged. Highest-leverage item outstanding. |
| SEC-2 — 30-day tokens, no revocation | **Substantially fixed** | Unchanged from 08-10. |
| SEC-3 — unbounded LLM proxy | **Fixed** | Unchanged. |
| SEC-4 — no auth rate limiting | **Fixed** | Unchanged. |
| SEC-5 — non-constant-time secret compare | **Now fully fixed** | The missed second gate was OPS-10; both gates share one helper. |
| SEC-6 — no CSP; script-readable token storage | **Half fixed** | Headers landed 08-10; storage locations unchanged by design. |
| SEC-7 — dependency CVEs | **Fixed again, and now *detected*** | The recurrence is OPS-9. The difference from June and from 08-10 is that a control now exists to catch the next one. |
| SEC-8 — misleading dev-bypass comment | **Fixed** | Unchanged. |
| SEC-9 — sync-token auto-registers unknown projects as OWNER | **Open** | `sync-token.ts:98-111` unchanged — §5.12. |
| SEC-10 — scrypt work factor | **Open (accepted)** | Legacy byte-compatibility constraint unchanged. |
| SEC-11 — internal error detail leaked | **Fixed** | Was "not re-verified" since June; re-verified and fixed as OPS-11. Worse than described — the leak was unconditional, not non-production-only. |

**Reading of the trend.** The 08-10 pass closed the items code alone could close and correctly
identified that what remained needed *secrets or settings* decisions. This pass says something
narrower and more useful: the two findings it turned up (OPS-8, OPS-9) were both invisible to
every control in the repo and both were found by a command a human had to remember to type. That
is now automated. The three findings that required judgment — OPS-10, OPS-11, and the OPS-3
contenteditable gap — were each an instance of the same failure mode: **a fix that stopped at the
first place the problem was seen.** Grep for the pattern before closing the finding.

## Next review

Amend this document in place for routine re-checks (§0). Trigger a full new pass on whichever
comes first: the CSP report-only console coming back clean (promote directives, then re-review),
`ADMIN_SECRET` being provisioned everywhere (delete the fallback, re-rate OPS-2), the first paying
org that self-identifies as working in a restricted context (re-weight the 08-10 §2 threat table
and OPS-3), or three months.
