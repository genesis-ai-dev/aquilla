# Operational Security Review — 2026-09-17

_Continues the standing series. Most recent entries: `docs/OPSEC-REVIEW-2026-09-14.md`
(OPS-29…OPS-30, third-party analytics egress) and `docs/OPSEC-REVIEW-2026-09-07.md`
(OPS-31…OPS-32, auth/session). New findings continue the **OPS-n** series at **OPS-33**._

**Scope for this pass: API security & data exposure**, the sixth pass on this theme in the
rotating weekly cycle (auth/session Mon, authz/access Tue, injection Wed, **API/data exposure
Thu**, infra/deployment Fri). The prior pass on this theme (`docs/OPSEC-REVIEW-2026-09-10.md`,
OPS-27) closed a broad "raw driver/upstream error text echoed to the client" class across both
workers; this pass did not find a new instance of that class and does not re-open it.

Since 09-10, a large batch of new external-facing surface landed on `dev`: the Agent API's
cell-comments read route (AQU-1233), the Living Memory read surface (AQU-1229), agent-connect
device-authorization grants with org scope, membership/org-membership commands, changeset
lifecycle, validation guardrails, cell-field/structure commands, `CreateOrg`/`CreateProject`,
org-scoped reads, and the autopilot policy-key opt-in gate — all PAT-authenticated, all added
after AQU-1180 (`sync-worker/src/external/pii.ts`, commit `27e93fa2e`) established the canonical
identity-scrubbing contract for this API. A dedicated survey agent inventoried the whole surface
end to end — endpoint/auth-gate map, authz/IDOR sweep, response data-exposure sweep, rate
limiting, and the `CreateOrg`/policy-gate escalation questions — with file:line evidence for
every claim, then this pass verified the two real findings that inventory turned up by reading
the flagged files directly and confirming against `pii.ts`'s own documented invariant.

Every finding is labelled **FACT** (verified against a file:line or a test run at this commit)
or **JUDGMENT** (reasoned inference).

---

## Findings

### OPS-33 — Comment reads never checked the project's `agentAuthorship: 'none'` opt-out, only the credential's `pii` flag — **FIXED** [FACT]

`external/pii.ts` (AQU-1180) establishes a three-valued, strictest-wins authorship policy:
`'none'` (project opted out — author fields **absent** from the payload), `'pseudonymous'`
(default — stable per-project opaque id), `'real'` (credential minted `pii: true` by an OWNER).
Its own header states the invariant explicitly: *"The project setting wins over the token flag
in the safe direction only: a project that has opted its translators out of identity exposure
cannot have that undone by a token."* Every other agent-facing read route
(`sync-worker/src/external/read-routes.ts:70,272-273,383-384`, cells and cell-history) calls
`resolveAuthorshipPolicy()`/`scrubAuthorField()` from `pii.ts` to get this.

`sync-worker/src/external/comments-route.ts` (AQU-1233, commit `82e30d41b`, merged 2026-09-10 —
*after* `pii.ts` already existed on `dev`) instead carried its own, independent implementation:
a local `resolveIdentityMode(cred)` (former `comments-route.ts:71-73`) that returned `'real'` or
`'pseudonymous'` based **solely** on `cred.pii`, plus a hand-rolled HMAC pseudonymizer matching
`pii.ts`'s hex length and `u_` prefix by construction but never calling it. The route's own
comment at the time said as much: *"That column \[`pii`\] is not on `main` yet... When AQU-1180
lands this becomes a call to `resolveAuthorshipPolicy()`"* — but AQU-1180 had already landed
before this route merged, and the follow-up was never made across two subsequent touches to the
file (`3f693ac7e`, `3b72fdf2f`, both 2026-09-15).

**Concrete impact:** a project that explicitly set `agentAuthorship: 'none'` — the restricted-
region translator-safety control `pii.ts` and `docs/OPSEC.md` D3 describe as the reason this
policy exists at all — still had `GET /api/v1/external/projects/:id/comments` hand back author
identity on every comment: pseudonymous by default, or **real usernames** for any `pii: true`
credential (which need only be minted by an OWNER *somewhere in scope* of the credential, not
necessarily by the stricter project's own admin). No special access was needed beyond the
route's ordinary VIEWER floor — this fired on every ordinary read. Verified with a failing test
before the fix (`author` present, pseudonymous, under `agentAuthorship: 'none'`) and a passing
one after.

**Fix:** `comments-route.ts` no longer implements its own identity logic. It builds the row as
before, then calls the same `resolveAuthorshipPolicy()` / `scrubAuthorField()` pair `read-
routes.ts` already uses, so `agentAuthorship: 'none'` now drops the `author` key entirely
(present-vs-absent, not blanked, matching `pii.ts`'s own documented reasoning for why a dropped
key differs from a null one) and `pii: true` still yields real names when the project hasn't
opted out. The local HMAC/pseudonymizer code (`hmacHex`, `commentAuthorPseudonym`,
`resolveIdentityMode`, the duplicated `NON_HUMAN_AUTHORS`/`PSEUDONYM_HEX` constants) is deleted;
`pii.ts` is the only place this logic now lives.

No response shape changed for the default and `pii: true` cases — `author` is still a string,
still the same `u_<8hex>` format. The only behavioral change is that `author` is now *absent*
under `agentAuthorship: 'none'`, which is the contract every other read route already honors.

### OPS-34 — Living Memory reads ran a second, independent pseudonymizer that honored neither `agentAuthorship: 'none'` nor a `pii: true` credential — **FIXED** [FACT]

`sync-worker/src/external/memory-read-routes.ts` (AQU-1229, commit `48520b7e3`, also merged
after `pii.ts` existed) implemented its own `createPseudonymizer()`: an HMAC-SHA256 keyed by
`SYNC_SECRET_KEY`, 6 bytes (12 hex) truncated, prefixed `author_`. `grep -n
"resolveAuthorshipPolicy|agentAuthorship|cred.pii"` over the file returned zero matches before
this fix. Two distinct problems, both confirmed with tests:

1. **Never consulted `agentAuthorship: 'none'`** — same class of gap as OPS-33, on a different
   route family (Living Memory: the project brief plus approved examples/decisions/notes, AQU-932
   parity). `createdBy`/`reviewedBy`/`brief.updatedBy` were unconditionally pseudonymized, never
   dropped, for a project that had asked for no identity exposure at all.
2. **Never consulted `cred.pii`** — the opposite-direction bug: an OWNER-minted `pii: true`
   credential, explicitly authorized by `credentials.ts` (`:131-158`, OWNER-only, scope-checked)
   to see real names, still only ever got a pseudonym here. Fail-safe rather than a leak, but a
   genuine cross-route inconsistency — an agent's Living Memory reads and its comment/cell reads
   disagreed about whether its own credential could see real identities.

A third effect, lower severity but worth recording: because the two ad hoc schemes used different
hex lengths, prefixes, and (before OPS-33) the comments route's own separate copy, the *same*
translator resolved to three different opaque ids across three route families on the same
project — undermining `pii.ts`'s stated cross-surface goal ("the same person wrote both of
these" surviving pseudonymization) for exactly the surfaces it was supposed to hold across.

**Fix:** `memory-read-routes.ts`'s bespoke pseudonymizer is replaced with a thin memoized wrapper
(`createIdentityMapper`) around `pii.ts`'s `resolveAuthorshipPolicy()` / `mapAuthor()`. `createdBy`,
`reviewedBy`, and `brief.updatedBy` are now typed to allow `undefined` (omitted from the
serialized response under `'none'`) and resolve to the same `u_<8hex>` id the comments and cells
routes would produce for the same (project, user) pair. No caller-visible change under the
default (`'pseudonymous'`) policy beyond the id format switching from `author_<12hex>` to
`u_<8hex>` — a JSON-shape-compatible change (still a string field) that only a caller doing an
exact-format match on the old prefix would notice, and no in-repo caller does (`grep` for
`author_` against the id shape in `src/`, `auth-worker/src`, `sync-worker/src` found none).

---

## Reviewed, no new finding

- **`CreateOrg` / `CreateProject` escalation path** — cannot be reached by a PAT alone. Scope is
  checked at both prepare (`prepare.ts:1054-1059`) and commit (`commit.ts:1189-1194`): only an
  *unscoped* credential can attempt `CreateOrg`, billing/entitlement fields are rejected by name
  (`CREATE_ORG_BILLING_FIELDS`, `commands.ts:308-326,710-722`), the command is force-pinned to
  `ask` mode at both prepare and commit regardless of the credential's own mode, and the org
  owner is resolved server-side from the credential's minting user with no parameter to redirect
  ownership. A human OWNER approval via `/approve/:id` is required before anything is created.
  Same shape for `CreateProject`. Not a finding.
- **Autopilot / policy-key opt-in gate** (`agentAuthorship`, `cellEditingFloor`,
  `validationRoleFloor`, …) — `commands-patch-settings.ts`'s `POLICY_SETTINGS_KEYS` enforces a
  directional-only change (an agent may tighten, never loosen), checked against the *live* blob
  at both prepare and commit, with the module's own comment naming the exact attack this pass
  was checking for: *"An agent able to flip \[`agentAuthorship`\] could talk a human into
  approving a settings changeset that turns its own team's names back on."* This closes the
  self-modifying-oversight path OPS-33/OPS-34's fix would otherwise be undermined by. Not a
  finding — a correctly-designed mitigation.
- **Membership / org-membership commands** (`InviteMember`/`SetRole`/`RemoveMember`,
  `AddOrgMember`/`SetOrgRole`/`RemoveOrgMember`) — MAINTAINER-or-OWNER floors, grant caps,
  effective-role target caps, last-owner guard, forced `ask` mode. Internally consistent, no
  sibling-command asymmetry found.
- **Rate limiting** — every mutating and every project-scoped read route in the newly-landed
  surface carries a per-credential sliding-window throttle; `discovery-route.ts:236`'s claim to
  that effect held up under inspection. The only unthrottled routes are `GET /skills`, `GET
  /setup-template`, `POST /setup-template/parse` — unauthenticated, stateless, touch no project
  data, and the POST is size-capped at 256KB. Reviewed as low-severity, not a data-exposure
  finding, and out of this pass's theme regardless.
- **PAT `pii` grant minting** (`auth-worker/src/routes/credentials.ts:84-206`) and the RFC 8628
  device-authorization flow (`auth-worker/src/routes/agent-connect.ts:71-228`) — both re-verified:
  OWNER-only for the `pii` grant, scope ceiling checked before mint, live-role re-check at
  token-mint time (not just approval time), atomic consume-and-mint. Not a finding.
- **`GET /orgs`, `/orgs/:orgId/projects`** — ids/names/caller's-own-role only, no roster, no
  emails; an out-of-scope org id returns `scope_denied` rather than either an empty list or a
  generic 404, which is a deliberate, documented choice (not an existence-oracle leak in the
  unsafe direction — it already tells the caller "you have no access here," not "here is what's
  in this org"). Not a finding.

## Secondary checks (confirmed still open, not re-investigated — out of this pass's theme)

- **OPS-24** (credit-guard check-then-act race, `auth-worker/src/lib/credits.ts:303-321`) — still
  a plain read-then-check with no locking between concurrent calls. Billing-scoped fix needed,
  not a side effect of an API/data-exposure pass.
- **V7/SEC-1** (`auth-worker/wrangler.toml:271` — prod and dev share `SECRET_KEY`/
  `SYNC_SECRET_KEY`) — still present, still the highest-leverage open item in the whole series.

---

## Risk assessment

| ID | Finding | Likelihood | Impact | Risk | State |
|---|---|---|---|---|---|
| OPS-33 | Comment reads ignored `agentAuthorship: 'none'`, keying identity solely off the credential's `pii` flag | High — fired on every comments read for an opted-out project, no special access needed | High for the population the control exists to protect — this is the exact D3 (translator-identity) linkage `agentAuthorship: 'none'` is supposed to withhold, and could surface real usernames given only an in-scope `pii` credential | **High** | Fixed |
| OPS-34 | Living Memory reads ran an independent pseudonymizer honoring neither `agentAuthorship: 'none'` nor `pii: true` | Medium-High for the `'none'` half (same trigger condition as OPS-33, narrower content — curated brief/decision text rather than free-form comments); Low for the `pii` half (fail-safe direction, a consistency bug not a leak) | Medium for the `'none'` half; Low for the `pii` half | **Medium** | Fixed |

## Countermeasures applied in this change

| Control | Where |
|---|---|
| `comments-route.ts` delegates identity resolution entirely to `pii.ts`'s `resolveAuthorshipPolicy`/`scrubAuthorField`; local pseudonymizer deleted | `sync-worker/src/external/comments-route.ts` |
| `memory-read-routes.ts` delegates to `pii.ts`'s `resolveAuthorshipPolicy`/`mapAuthor` via a thin memoized wrapper; local pseudonymizer deleted | `sync-worker/src/external/memory-read-routes.ts` |
| Regression tests: `agentAuthorship: 'none'` drops the author field (not just pseudonymizes it), a `pii: true` credential reads real identities through the full route, and the project setting overrides a `pii` credential | `sync-worker/src/__tests__/external-comments.test.ts`, `sync-worker/src/__tests__/external-memory-reads.test.ts` |

## Verification

* `sync-worker`: `npx tsc --noEmit` clean; `npx eslint` clean on every changed file; targeted
  suite (`external-comments.test.ts`, `external-pii.test.ts`, `external-memory-reads.test.ts`)
  green (44 tests); full `npx vitest run` green.
* No response status code or field *type* changed for the default/`pii:true` paths; the only
  shape change is `author`/`createdBy`/`reviewedBy`/`brief.updatedBy` becoming absent (not null)
  under `agentAuthorship: 'none'`, and the memory route's pseudonym prefix changing from
  `author_<12hex>` to `u_<8hex>` (still a string field; no in-repo caller pattern-matches the old
  prefix). No UX/UI impact: both routes are read-only Agent API surfaces with no in-app consumer.

---

_Re-run the mechanical parts of this review with: `cd sync-worker && npx tsc --noEmit && npx
eslint src/external/comments-route.ts src/external/memory-read-routes.ts && npx vitest run
src/__tests__/external-comments.test.ts src/__tests__/external-pii.test.ts
src/__tests__/external-memory-reads.test.ts`._
