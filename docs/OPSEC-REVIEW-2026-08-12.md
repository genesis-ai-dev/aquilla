# Operational Security Review — 2026-08-12 (reconciled 2026-08-13)

_Scope: the operational security of **this project**. Follow-up to
[`OPSEC-REVIEW-2026-08-10.md`](./OPSEC-REVIEW-2026-08-10.md) (OPS-1…OPS-7) and
[`SECURITY-NOTES-2026-06-10.md`](./SECURITY-NOTES-2026-06-10.md) (SEC-1…SEC-11)._

## 0. Why this document looks different from the pass that produced it

This pass ran on 2026-08-12 against a tree that did not yet contain
[`OPSEC-REVIEW-2026-08-11.md`](./OPSEC-REVIEW-2026-08-11.md) — the two reviews were
follow-ups to the same 2026-08-10 pass, run independently, one day apart, each unaware of
the other. Both assigned the numbers OPS-8…OPS-11 to *different* findings. When the
branches met on 2026-08-13, the collision was reconciled in the 2026-08-11 pass's favour
(it landed on `dev` first): everywhere the two passes found and fixed the same thing, the
landed fix stands, and **this document renumbers what survives as OPS-12…OPS-14** so the
OPS-n series stays unambiguous. Future passes: check for an in-flight sibling review
before taking numbers.

The convergence itself is worth recording. Working blind, both passes independently
found the dompurify advisory, the placebo session-replay mask, and the signing-key-as-
admin-bearer problem — and *each found an edge of those findings the other missed*.
Independent reproduction is the strongest evidence yet that these were the real findings
of this tree, and the non-overlap is the argument for occasionally paying the cost of a
second pair of eyes.

## 1. Disposition of this pass's original findings

| This pass (2026-08-12) | Same finding in the parallel pass | Disposition |
|---|---|---|
| OPS-8: dompurify GHSA-55q2-fjhq-7xh7 in the tree, no advisory gate | 2026-08-11 OPS-8 (the advisory) + its OPS-6 closure (the gate) | **Superseded.** The landed fix — `dompurify@^3.4.13`, `scripts/audit-deps.mjs` + `.github/audit-allowlist.json` on a scheduled workflow, covering the Worker packages too — stands. This pass had built a *blocking per-PR* gate (triage allowlist with review-by expiry) instead; the parallel pass chose schedule-over-PR deliberately, and the merge respects the landed decision. One hardening from the discarded gate was ported to `audit-deps.mjs`: a payload that parses but carries none of the shapes the parser reads must **fail, not read as clean** — a gate that passes because it could not read its input is worse than no gate. |
| OPS-9: `maskTextSelector: "[data-ph-mask]"` matched zero nodes; replays captured draft text verbatim | 2026-08-11 OPS-3 (masking half) | **Superseded on the editor surfaces** (`EditorTable`, `TranslatedEditor`, parity-tested by `src/lib/posthog.mask.test.ts`) — **but the parallel fix stopped there.** Comment surfaces were still unmasked. Survives as **OPS-12**. |
| OPS-10: route-level raw error text to authenticated callers | 2026-08-11 OPS-11 fixed the *unauthenticated* `/register` case only | **Survives as OPS-14** (recorded, not fixed — same reasoning as before). |
| OPS-11: `pnpm lint` red on five pre-existing errors in the gating lane | Fixed independently on `dev` (same fixes: three `prefer-const`, two intentional `no-control-regex` disables) | **Superseded.** Both passes even chose the same eslint-disable-with-rationale treatment. |
| (found while implementing OPS-2) `/admin/*` has a machine caller the one-line rollout plan would have broken | Not found by the parallel pass | **Survives as OPS-13**, fixed in this change. |

## 2. Surviving findings

### OPS-12 — [FACT] Comment bodies were left out of the session-replay mask — **fixed in this change**

The parallel pass's `data-ph-mask` fix covered the two editor surfaces. Comment bodies
render draft text quoted in discussion and name collaborators — the same exposure OPS-3
was about, through a different door, and for a team in a restricted-access jurisdiction
the *names* are the sensitive part. `CommentThread.tsx` and `CommentsPage.tsx` now carry
`data-ph-mask` on the rendered comment body, and both files are added to the
`MASKED_SURFACES` parity list in `src/lib/posthog.mask.test.ts`, so removing either
attribute fails the suite.

Scope unchanged from the parallel pass's rating: consent-gated, opt-out by default;
applies only to orgs that turned analytics on — which is exactly the population the
finding was always about.

### OPS-13 — [FACT] Provisioning `ADMIN_SECRET` on sync-worker alone silently breaks R2 cleanup — **fixed in this change**

`/admin/*` is not operator-only in practice: `auth-worker/src/routes/projects.ts` calls
`DELETE /admin/files/…` on sync-worker for best-effort R2 cleanup when a file is deleted,
and it sent `SYNC_SECRET_KEY` as the bearer. The landed OPS-2 fix
(`sync-worker/src/lib/admin-secret.ts`) is deliberately one-or-the-other: the moment an
environment gets `ADMIN_SECRET`, the signing key stops being accepted there. Follow the
provisioning recommendation as written and every file delete starts leaving its blobs in
R2, with nothing but a `console.warn` to say so — a data-retention failure introduced by
a security fix, discoverable only in logs.

**Fixed:** auth-worker now follows the same precedence (prefers its own `ADMIN_SECRET`,
falls back to `SYNC_SECRET_KEY`; `Env.ADMIN_SECRET` in `auth-worker/src/types.ts`), the
401 case names the mismatch in its warning, and the provisioning recipe in
`sync-worker/wrangler.toml` says in capitals to set both workers to the same value in one
sitting. `.dev.vars.example` on both workers carries the pairing note.

#### OPS-13a — [FACT] The two sides normalised the fallback differently — **found on the merged tree, fixed in this change**

Caught while verifying the merge, and worth recording because it is the same failure
reaching the same place by a third route. `resolveAdminSecret` trims **both** candidates
(`env.SYNC_SECRET_KEY?.trim()`); auth-worker's call sent
`c.env.ADMIN_SECRET?.trim() || c.env.SYNC_SECRET_KEY` — the fallback **untrimmed**. So a
`SYNC_SECRET_KEY` carrying surrounding whitespace authenticated on neither side of the
pair, and did it down the identical silent-401 path: `console.warn`, blobs stranded in R2.

The trigger is not exotic. `echo secret | wrangler secret put` stores a trailing newline;
`printf %s secret |` does not, which is why the recipe in `wrangler.toml` uses `printf`.
Note also that this was a *regression window* opened by the OPS-2 fix itself: the previous
`admin.ts` compared against an untrimmed `SYNC_SECRET_KEY`, matching what auth-worker
sent, so an environment with a newline-terminated secret worked before and would have
stopped working after — silently, and only on the cleanup path.

**Fixed:** both branches trim, so the two ends normalise identically.
`sync-worker/src/lib/admin-secret.test.ts` pins the contract from the receiving side,
including an explicit case asserting that an *untrimmed* sender is rejected — so if either
end stops trimming, a test says so instead of R2 quietly filling up.

Blast radius checked rather than assumed: `adminBearerMatches` gates exactly two surfaces.
`DELETE /audio/*` cannot break this way (a failed match falls through to sync-token
verification, so the client path still works), and the `/admin/projects/*` notifications
(`member-removed`, `settings-changed`, `contextual-activity`, `archive`) are handled
earlier in the chain by their own `SYNC_SECRET_KEY` checks and never reach this gate. The
file-delete cleanup was the only affected caller.

### OPS-14 — [FACT] Route-level handlers return raw error text to authenticated callers — **recorded, not fixed**

The global handlers are clean (`auth-worker/src/index.ts` returns a flat
`{ error: "Internal server error" }` and logs the detail), and the parallel pass fixed
the one *unauthenticated* case (`/register`, its OPS-11). What remains is authenticated:
a dozen-plus catch blocks interpolate the caught error's `.message` into the response
body. Re-verified on the merged tree: `projects.ts` (create/rename/archive/delete paths),
`source-linking.ts` (link/detach/delete), `parse-document.ts`, `monday.ts`,
`routes/merge-sibling.ts`, `lib/agent/sql-guard.ts` — and the list grows
(`marketing-seed.ts` appeared since). In `projects.ts` and `source-linking.ts` the caught
error is a Postgres error crossing the `db/shim` boundary, so the message can carry
table, column and constraint names to any authenticated caller. Schema disclosure, not
credential disclosure.

**Still not fixed here, same reasoning as when this pass first recorded it:** changing
these payloads is a client-contract change (the SPA renders some of these strings; worker
suites assert on others). Done properly it is a generic body plus a correlation id tying
the response to the server-side log — its own change with its own tests.

## 3. Risk assessment

| ID | Likelihood | Impact | Risk | Note |
|---|---|---|---|---|
| OPS-12 | Certain for any org with analytics on | Low for most orgs; severe where collaborator identity is the asset | **Medium** (residual of a High, after the editor surfaces were closed) | Closed in code. |
| OPS-13 | Certain on the first one-sided provisioning — which was the *recommended* next step | Medium — unbounded R2 blob retention for deleted files, silent | **Medium** | Closed in code; the provisioning step itself is still the owner's. |
| OPS-14 | Medium — needs an error path an authenticated caller can trigger | Low-Medium — schema disclosure | **Low-Medium** | Long-standing (SEC-11 remainder). |

## 4. What remains for the owner, ranked

1. **Provision `ADMIN_SECRET`** on `aquilla-sync-worker` **and** `aquilla-identity`, same
   value, per environment, in one sitting — recipe in `sync-worker/wrangler.toml`. Then
   confirm a file delete still cleans up R2 (that is the path a one-sided rollout breaks
   silently). Once set everywhere, delete the `SYNC_SECRET_KEY` fallback on both sides.
2. **OPS-14** — generic bodies + correlation ids for the authenticated error routes.
3. **SEC-1** — split `SECRET_KEY`/`SYNC_SECRET_KEY` per environment. Unchanged, still the
   highest-leverage item in the system: a dev-environment compromise currently mints
   prod-valid tokens.
4. **OPS-3 residual** — make the consent copy say what a replay still contains; for any
   org that self-identifies as working in a restricted context, default replay off.
5. **SEC-9** — sync-token auto-registration (`auth-worker/src/routes/sync-token.ts`):
   any authenticated caller supplying an unknown `projectId` + `projectName` gets the
   project created with themselves as OWNER, bypassing the projects API and its quota and
   entitlement checks. Carried again.

## 5. Effectiveness check

The 2026-08-11 pass's §7 already covers the 2026-08-10 fixes; this pass re-verified
independently and agrees. What this pass adds is the meta-finding, now three-for-three
and confirmed by *both* reviews separately: **the artifact that describes a control is
not evidence the control works.** The mask selector read as a considered trade-off and
matched nothing. The OPS-2 one-line rollout plan read as safe and would have broken R2
cleanup. OPS-7, the pass before, was rated Low on a reading one `curl` disproved. Every
check that caught one of these ran in under a minute. Treat any control whose evidence is
a config line or a comment as unverified until something is run against it, and confirm
every new guard fails when the thing it guards is removed — every guard in this change
was.

## Next review

Trigger on whichever comes first: `ADMIN_SECRET` provisioned on both workers (re-check
OPS-2/OPS-13, confirm file-delete R2 cleanup), the CSP report-only console coming back
clean (promote directives, then re-review), the first paying org that self-identifies as
working in a restricted context (re-weight the threat model and the OPS-3 residual), or
three months. Start by re-running the checks rather than re-reading the tree — see §5.
