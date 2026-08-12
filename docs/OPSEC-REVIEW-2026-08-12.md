# Operational Security Review — 2026-08-12

_Scope: the operational security of **this project** — what sensitive material Aquilla
handles, who would want it, where the practices around it are weak, and what actually
changed since the last pass. Follow-up to
[`OPSEC-REVIEW-2026-08-10.md`](./OPSEC-REVIEW-2026-08-10.md) (OPS-1…OPS-7) and
[`SECURITY-NOTES-2026-06-10.md`](./SECURITY-NOTES-2026-06-10.md) (SEC-1…SEC-11)._

This is a short-interval pass, run two days after the last one. It is deliberately not a
re-survey: §1 and §2 of the 2026-08-10 document still describe the assets and the threat
model accurately, and repeating them would obscure what is new. **§1 below records only
what changed.** New findings continue the **OPS-n** numbering.

Findings are labelled **FACT** (verified against the tree or a running process at this
commit) or **JUDGMENT** (reasoned inference), following the convention set by the June
audit. Where the last pass asserted something this one measured, the measurement wins and
the correction is stated explicitly.

---

## 1. What changed since 2026-08-10

Nothing changed in the asset inventory, and nothing changed in the threat model. Two
things changed in the world:

1. **Nine advisories were sitting in the production dependency tree**, one of them against
   the SPA's only HTML sanitizer. The last pass did not enumerate them — not because it
   judged them acceptable, but because nothing was looking. This is OPS-6, the detection gap
   it recorded as "nothing yet prevents the next advisory", being demonstrated rather than
   argued. (How many are strictly *new* since 2026-08-10 is unknown and not worth
   establishing: the point is that the count was unobserved either way.) See OPS-8.
2. **A control that read as implemented turned out to match nothing.** OPS-3's session-replay
   masking had a `maskTextSelector` in the PostHog config, which is what a reader checking
   for the control would find; the attribute it names existed nowhere in the tree. See OPS-9.

Both are the same failure shape as OPS-7 in the last pass, which was mis-rated Low on a
plausible reading of `wrangler.toml` that one `curl` disproved. The recurring lesson is in
§6.

## 2. Threats

Unchanged from
[2026-08-10 §2](./OPSEC-REVIEW-2026-08-10.md#2--threats--who-wants-this-and-why). The two
rows that bear on this pass:

- **Malicious or vulnerable dependency in the supply chain** → build output → every browser
  session. The mitigation named there was the CSP, "the mitigation that assumes this
  happened". OPS-8 is the same row from the other direction: the vulnerability arriving
  through a dependency we chose and declared.
- **State or non-state actor hostile to the translation work**, whose target is translator
  identity and location. OPS-9 is about that row: draft text and the identity of whoever is
  editing it, leaving our infrastructure inside a session replay.

## 3. Vulnerabilities

### OPS-8 — [FACT] A DOMPurify XSS advisory sat in the dependency tree with no gate to catch it — **fixed in this change**

`pnpm audit --prod` at the parent commit reported nine advisories. Eight are unreachable
(see below). The ninth, **GHSA-55q2-fjhq-7xh7**, is against `dompurify` — a *direct*
dependency at `^3.4.12`, matching the advisory's `<=3.4.12` range — and DOMPurify is the
only sanitizer standing between user-authored HTML and the DOM at four call sites:
`src/lib/richtext/editor-content.ts:22`, `src/components/EditorTable.tsx:3439`,
`src/components/CommentThread.tsx:80`, and `src/components/CommentsPage.tsx:410`.

**Exploitability here is low, and the reason matters.** The advisory concerns `IN_PLACE`
mode: removing a hook leaves a detached subtree executable. Nothing in this repo passes
`IN_PLACE` or `RETURN_DOM*` — every call site takes the string-in/string-out path. So this
was not a live XSS in Aquilla. It is recorded as a finding anyway because *nothing in the
repo established that*: the declared range permitted a vulnerable resolve, no check would
have reported the advisory, and the argument that our call sites are unaffected did not
exist anywhere until it was written here. The next advisory against a sanitizer will not
necessarily be as kind.

**Fixed** by raising the declared floor to `^3.4.13` with the lockfile updated — a
constraint rather than a coincidence, the same distinction the last pass drew for `hono`.

The eight remaining advisories (`tar` ×6, `adm-zip`, `sharp`) all sit under the *Node*
backends of `@huggingface/transformers` and `kokoro-js`. `pnpm audit` walks the dependency
graph, which has no notion of conditional exports: transformers resolves to
`dist/transformers.node.mjs` only under the `node` condition, and the web build we ship
stubs `onnxruntime-node` out entirely — its bundle carries `// ignore-modules:onnxruntime-node`
followed by an empty exports object, and the string `sharp` does not appear in it at all.
Verified by reading the package's `exports` map and grepping `dist/transformers.web.js`,
not inferred from the package names. No Worker imports transformers at all.

### OPS-9 — [FACT] The session-replay text mask matched no elements — **fixed in this change**

`src/lib/posthog.ts:22` configures `maskTextSelector: "[data-ph-mask]"`, alongside a comment
explaining the deliberate trade-off: mask inputs, keep the page visible so replays are
diagnosable. That reads like a considered control, and OPS-3 of the last pass described it
as "the right shape".

`git grep data-ph-mask src` returned exactly one hit: the config line itself. The selector
matched zero nodes, so every session replay from a consenting org captured **all** page
text — including the source scripture, the draft target text, and comment bodies naming
collaborators — verbatim, to a third-party US processor.

This is worse than having no mask configured, because the configuration is what a reviewer
finds when checking whether the control exists. Both the last pass and the June audit read
the same line and did not check that anything matched it.

Scope of the exposure: consent-gated and opt-out-by-default
(`opt_out_capturing_by_default`), so it applies only to orgs that turned analytics on.
That is the mitigating fact, and it is also exactly the population OPS-3 was written about
— the risk was always "which customer opts in", and until now opting in meant sending draft
text.

**Fixed** by putting `data-ph-mask` on the three surfaces that carry the content:
the editor's source and target columns (`EditorTable.tsx`, the `data-showcase="editor.source"`
and `editor.target` nodes — deliberately the two text surfaces rather than the whole table,
so chrome, controls and status still record and replays stay diagnosable) and comment
bodies in `CommentThread.tsx` and `CommentsPage.tsx`.

Guarded by `src/lib/posthog-mask.test.ts`, which reads the selector out of the real config
and fails if it matches nothing, and separately asserts the two editor columns carry it.
The guard was verified to fail when the attribute is removed — an unfalsifiable test would
reproduce the original defect one level up.

### OPS-10 — [FACT] Thirteen routes return raw error text to the client — **recorded, not fixed**

SEC-11 ("error detail leaked outside production") was carried forward from June unverified,
twice. Verified now, and it splits:

- The **global** handlers are clean. `auth-worker/src/index.ts:303` returns a flat
  `{ error: "Internal server error" }` and logs the detail server-side.
- **Individual routes are not.** Thirteen sites interpolate a caught error's `.message`
  into the response body, including `projects.ts:297` (`create failed: …`), `:621`, `:654`,
  `:700`, `:1170`, `source-linking.ts:137`, `:236`, `:316`, `parse-document.ts:196`,
  `monday.ts:609`, `merge-sibling.ts:70`, and `lib/agent/sql-guard.ts:313`.

In `projects.ts` and `source-linking.ts` the caught error is a Postgres error crossing the
`db/shim` boundary, so the message can carry table, column and constraint names to any
authenticated caller. That is schema disclosure, not credential disclosure — real, and a
tier below the findings above.

**Not fixed here deliberately.** Changing thirteen response payloads is a client-contract
change: the SPA renders some of these strings, and worker suites assert on others. Doing it
properly means a generic body plus a correlation id that ties the response to the logged
detail, which is its own change with its own tests. Bundling it into a security PR that is
otherwise mechanical would make the whole thing harder to review, and a half-done version
that breaks an error path is worse than the disclosure. Recommended owner action in §5.

### OPS-11 — [FACT] `pnpm lint` failed on five pre-existing errors, in the lane that gates merges — **fixed in this change**

The `lint` lane in `scripts/cloudflare-ci-checks.mjs` — the gate that actually runs on pull
requests — runs `pnpm lint`, which exited 1 on five errors already present on `dev` at the
parent commit (353 further warnings do not fail it). None were in files this change
otherwise touches, and all five are code-quality rather than security issues:

- three `prefer-const` in `auth-worker/src/__tests__/{contextual-runs,scene-briefs}.test.ts`,
  each a `let executor: PgExecutor` assigned exactly once on the next line;
- two `no-control-regex` in `db/shared/contextual-runs.ts:488,980` — both **deliberate**,
  stripping control characters out of model output and run errors before they are stored,
  so a NUL or an escape sequence cannot ride into a log line or a terminal.

This was in scope because it is load-bearing for the rest of the change: OPS-8's fix adds
the dependency audit to *this* lane. A new red step in an already-red lane is invisible —
the lane fails either way, and "lint is red again" stops carrying information. The audit
gate is worth exactly what the lane's signal is worth, and the lane's signal was zero.

**Fixed:** the three `let`s are now `const`, and the two intentional regexes carry an
inline `eslint-disable-next-line no-control-regex` with the rationale written above it,
rather than being silently rewritten — the control characters are the point of those
expressions. `pnpm lint` now exits 0 (353 warnings, which do not fail the lane).

## 4. Risk assessment

| ID | Likelihood | Impact | Risk | Note |
|---|---|---|---|---|
| OPS-8 | Certain — the advisory was already in the tree | Low **as it stands** (no `IN_PLACE` call site); High for the next sanitizer advisory, which nothing would have caught | **Medium** | Rated on the missing detection, not on this advisory's reachability. The gate is the fix; the version bump is housekeeping. |
| OPS-9 | Certain for any org with analytics on — this was the behaviour, not a contingency | Low for most orgs; **severe** for a team in a restricted-access jurisdiction, where the replay shows both the draft and who is editing it | **High** | Re-rated up from OPS-3's Medium, because the control assumed in that rating did not exist. |
| OPS-10 | Medium — needs an error path an authenticated caller can trigger | Low-Medium — schema disclosure, no credentials | **Low-Medium** | Long-standing; the June rating was right, it had just never been checked. |
| OPS-11 | Certain — it was the state of `dev` | Medium — degraded the signal of the lane this change adds a security gate to | **Medium** | Not a vulnerability. A control-effectiveness problem, which is what §6 of these reviews is for. |

Ranked action order for the owner, of what remains: **OPS-2 provisioning** (§5 item 6),
then **OPS-10**, then SEC-1. OPS-8, OPS-9 and OPS-11 are closed in code.

## 5. Countermeasures

**Implemented in this change (code):**

1. **A dependency-audit gate that fails on untriaged advisories** —
   `scripts/dependency-audit.ts` + `scripts/dependency-audit-allowlist.json`, wired into the
   `lint` lane of `scripts/cloudflare-ci-checks.mjs` (the gate Cloudflare Workers Builds
   actually runs on a pull request — `ci.yml` is `workflow_dispatch`-only and would not have
   run, a trap the last pass documented and this one obeyed).

   It deliberately does **not** gate on the advisory count. Eight of today's nine advisories
   are unreachable, and a check that fails every PR on unreachable findings is one everyone
   learns to skip — at which point the reachable one goes past with the rest. Instead every
   advisory must be triaged once into the allowlist with a reason and a review-by date;
   anything untriaged fails, and an expired entry fails again, so "look at it later" carries
   a deadline instead of becoming permanent silence. The allowlist's own test rejects
   one-word reasons and refuses to let `dompurify` be triaged at all.

   The parser **throws rather than reporting clean** when `pnpm audit`'s payload carries
   neither `advisories` nor `metadata` — an output-format change, or anything else writing
   unexpected JSON to stdout, must not read as "no advisories found". A gate that passes
   because it could not read its input is the one thing that would make it worse than no
   gate, and that is the failure this whole document is about.

   "Could not run the audit" and "ran it and found something" are separated into distinct
   types, because they need different reactions: an untriaged advisory is a decision for
   whoever opened the pull request, while an unreachable advisory endpoint is a builder
   problem no change to this repository will fix. The advisory endpoint
   (`/-/npm/v1/security/audits`) is a different surface from package downloads, so a mirror
   can serve installs perfectly and not implement it — the failure message says exactly
   that, and quotes the registry's own error, so a build log does not send the reader
   hunting for a parser bug.

   An environment that genuinely cannot reach the endpoint can set
   `AQUILLA_DEP_AUDIT_ALLOW_UNAVAILABLE=1` on the builder. It fails **by default**, and the
   skip prints a warning saying dependency vulnerabilities were not checked. The lever
   exists because the realistic alternative to a hard block nobody can clear is that
   somebody deletes the step — and a deliberate, loud, environment-scoped downgrade is
   better than a quiet deletion. All three paths (clean, unavailable-fails,
   unavailable-skipped) were exercised against a deliberately unreachable registry.

   The last pass recommended a *weekly, non-blocking* `pnpm audit` job for exactly the
   false-positive reason above. This solves the same problem the other way: blocking, but
   only on the part a human has not yet looked at. A non-blocking weekly job produces a
   notification, and §0 of `SELF-DRIVING-ROUTINES.md` is explicit that a loop whose output
   is a notification is an alert, not a routine.

2. **`dompurify` floor raised to `^3.4.13`**, lockfile updated (OPS-8).

3. **Session-replay masking that matches something**, plus the test that keeps it matching
   (OPS-9).

4. **A dedicated `ADMIN_SECRET` for sync-worker's `/admin/*` routes** (OPS-2 of the last
   pass, which had been deferred as "needs the secret provisioned first, in the right order,
   to avoid locking out ops"). `adminCredential()` in `sync-worker/src/admin.ts` prefers
   `ADMIN_SECRET` and falls back to `SYNC_SECRET_KEY` while it is unbound, so the code can
   ship before the secret exists and an operator can provision it whenever they get to it,
   with no coordinated deploy. Once `ADMIN_SECRET` is set the signing key stops being
   accepted — which is verifiable, and is asserted in `sync-worker/src/admin-credential.test.ts`.

   **One thing the last pass's one-line description would have got wrong**, found while
   implementing it: `/admin/*` has a machine caller. `auth-worker/src/routes/projects.ts`
   calls `DELETE /admin/files/…` for R2 cleanup when a file is deleted, and sends
   `SYNC_SECRET_KEY`. It is best-effort and only `console.warn`s on failure. Provisioning
   `ADMIN_SECRET` on sync-worker alone would therefore have 401'd every file-delete cleanup
   **silently**, leaving deleted files' blobs in R2 — a data-retention failure introduced by
   a security fix, discoverable only in logs. The caller now follows the same precedence, the
   401 case names the mismatch in its warning, and the provisioning note in
   `sync-worker/wrangler.toml` says in capitals to set both workers in one sitting.

5. **`pnpm lint` restored to zero errors** (OPS-11), so the lane the audit gate joins
   actually reports something.

**Recommended, requiring an owner decision (not implemented here):**

6. **OPS-2 completion — provision `ADMIN_SECRET`** on `aquilla-sync-worker` and
   `aquilla-identity`, same value, per environment, per the recipe in `sync-worker/wrangler.toml`.
   Then delete the fallback branch in `adminCredential()`; until that branch is gone the
   signing key is still an accepted admin credential wherever the new secret is unset.
7. **OPS-10 — replace the thirteen raw-error responses** with a generic body plus a
   correlation id logged alongside the detail.
8. **SEC-1 — split `SECRET_KEY`/`SYNC_SECRET_KEY` per environment.** Unchanged, and still the
   highest-leverage item in the system: a dev-environment compromise currently mints
   prod-valid tokens.
9. **OPS-3 residual — say what replay captures in the consent copy.** The mask closes the
   editor and comment surfaces; it does not make the consent text accurate about what a
   replay still contains. For any org that self-identifies as working in a restricted
   context, default replay off and do not offer it.
10. **SEC-9 — sync-token auto-registration.** Still open
    (`auth-worker/src/routes/sync-token.ts:98-111`): any authenticated caller supplying an
    unknown `projectId` plus a `projectName` gets the project created with themselves as
    OWNER, bypassing the projects API and whatever quota or entitlement lives there. Not a
    privilege escalation over an existing project — the branch is reached only when the
    lookup misses — which is why it keeps being deprioritised.

**Practices (people, not code):** unchanged from
[2026-08-10 §5](./OPSEC-REVIEW-2026-08-10.md#5-countermeasures) items 9–12 — never paste a
signing key into a shell (item 6 above is what finally retires the need to), treat the dev
environment as production-equivalent while SEC-1 is open, hold the line on invite-link
unfurl hygiene, and hardware-key 2FA on the Cloudflare and GitHub accounts. That last one
is still worth more than anything in this document.

## 6. Effectiveness check — what the last pass's fixes look like now

| Finding | Status | Evidence |
|---|---|---|
| OPS-1 — no CSP / security headers on the web build | **Holding** | `worker/security-headers.ts` + `public/_headers`, with `worker/security-headers.test.ts` asserting parity. The full policy is still report-only; promoting directives is still pending a clean console. |
| OPS-2 — `SYNC_SECRET_KEY` as admin bearer | **Code done, provisioning outstanding** | `adminCredential()` above. The exposure does not actually shrink until `ADMIN_SECRET` is set (§5 item 6). |
| OPS-3 — session replay captures draft text | **Was not implemented at all** | The mask selector matched nothing. Re-rated and fixed as OPS-9. |
| OPS-4 — a test suite no CI lane ran | **Holding** | `pnpm test:worker` runs in the `spa` lane. |
| OPS-5 — misleading dev-bypass comment | **Fixed** | Unchanged since. |
| OPS-6 — no dependency-vulnerability gate | **Fixed in this change** | `pnpm audit:deps` in the `lint` lane, which OPS-11 restored to a working signal. |
| OPS-7 — headers bypassed by the asset router | **Holding** | `public/_headers`, parity-tested. |
| SEC-11 — error detail leaked outside production | **Verified at last: half open** | Global handlers clean, thirteen routes not. Now tracked as OPS-10 rather than carried forward a third time. |

**Reading of the trend.** The last pass's headline was that what remained needed a *secrets
or settings* decision rather than a patch. Two days on, that is still true — the ranked list
is OPS-11, OPS-2 provisioning, SEC-1 — but this pass found something different and more
uncomfortable: **two of the three things it looked at closely were not doing what the
documentation said they were doing.** OPS-9's mask matched nothing while reading as a
considered trade-off. OPS-2's one-line fix would have broken R2 cleanup silently. OPS-7, in
the last pass, was rated Low on a reading that a single `curl` disproved.

Three for three, in the same direction: **the artifact that describes a control is not
evidence the control works, and reviewing this system by reading it has now been wrong every
time it has been checked.** The cheap discipline that catches all three is the same —
execute the check, grep for the thing the config claims to match, call the endpoint — and
each took under a minute. Future passes should treat any control whose evidence is a config
line or a comment as unverified until something is run against it. Every guard added in this
change was confirmed to fail when the thing it guards is removed.

## Next review

Trigger the next pass on whichever comes first: `ADMIN_SECRET` being provisioned on both
workers (re-check OPS-2, and confirm the file-delete R2 cleanup still succeeds — that is the
path a one-sided rollout breaks silently), the CSP report-only console coming back clean
(promote directives, then re-review), the first paying org that self-identifies as working in
a restricted context (re-weight §2 and the OPS-3 residual), or three months.

Whichever fires, start by re-running the checks rather than re-reading the tree — see §6.
