# Operational Security Review — 2026-09-14

_Eleventh pass in the standing series. Follows `docs/OPSEC-REVIEW-2026-09-03.md`
(OPS-27…OPS-28), `docs/OPSEC-REVIEW-2026-08-31.md` (OPS-25…OPS-26),
`-08-27.md` (OPS-22…OPS-24), `-08-24.md` (OPS-18…OPS-21), `-08-20.md`
(OPS-15…OPS-17), `-08-17.md` (OPS-11…OPS-13), `-08-13.md` (OPS-8…OPS-10),
`-08-11.md`, `-08-10.md` (OPS-1…OPS-7) and `docs/OPSEC.md` (V1…V9). New
findings continue the **OPS-n** series at **OPS-29**._

**Scope for this pass: third-party data egress from the browser** — what leaves
the client for a processor we don't control, chiefly PostHog (analytics,
exception capture, session replay). This theme has been touched once before, at
OPS-3 (`-08-13.md`, replay masking for cell text), but never swept end to end.
It is deliberately *not* one of the five rotating pen-test themes (auth/session,
authz, injection, API/data exposure, infra): those examine what an attacker can
pull out of our servers. This one examines what we hand to someone else on
purpose, which is the class of exposure where the D2/D3 linkage in §1 leaves the
building without anybody attacking anything.

Today's auth/session slot is already covered by an open pen-test PR (#651,
absolute session-age cap), so this pass takes the egress theme rather than
duplicating it.

Every finding is labelled **FACT** (verified against a file:line or a command
run at this commit) or **JUDGMENT** (reasoned inference).

**Numbering note.** `dev` currently carries OPS-1…OPS-28. Open PR #615
(`docs/OPSEC-REVIEW-2026-09-10.md`, branched before 09-03 landed) also numbers
its finding OPS-27; that collision is the same one 08-31/09-03 hit and is
resolved the same way at merge — whichever landed first keeps the number. This
pass takes **OPS-29 and OPS-30**, which are free under either resolution.

---

## 1. Critical data — what this pass is about

Unchanged from `docs/OPSEC.md` §1; the rows that matter here are:

| # | Asset | Why it matters *for egress* |
|---|---|---|
| D2 | Unpublished translation drafts and their source text | Masked in replays since OPS-3 — but *which passage, language and project* can leak through a URL, an error string, or a route name without any cell text at all. |
| D3 | Translator identity + activity | PostHog holds IP, timestamps, and a `distinct_id`. Anything that links that to a project or an invite is the linkage the threat model in §2 turns on. |
| D5 | Bearer tokens in circulation | **Five of this app's routes carry one in the URL itself** (§3). PostHog attaches the URL to every event it sends. |
| D8 | Session replays | A US third-party processor by design; the question is only what rides along. |

## 2. Threat actors — who this pass is about

Same table as `docs/OPSEC.md` §2. Two rows drive this pass:

- **State or para-state actors in restricted-access regions.** The `/link/:token`
  flow exists *specifically* for them (`src/components/AccessLinkPage.tsx:1-14`:
  "a translator in a surveillance-sensitive context… a Brave profile that wipes
  on close"). Anything that flows out of that page to a third party undoes some
  of what the feature was built to do.
- **Opportunistic credential harvesters.** A credential that reaches a
  third-party analytics store is outside every control in this repo — it now
  depends on that vendor's retention, access control, and breach history rather
  than on ours.

Neither actor needs to attack anything for these two findings to pay off. That
is what distinguishes an egress finding from a pen-test finding.

---

## Findings

### OPS-29 — Live credentials in URLs were exported to PostHog on every event — **FIXED** [FACT]

**Five routes put a bearer credential in the URL** (`src/App.tsx:320-332`):

| Route | Credential | Lifetime / power |
|---|---|---|
| `/join/:token` | project invite token | Joins a project; stored **plaintext** at rest (OPS-26) |
| `/join-org/:token` | org invite token | Joins an org; same |
| `/link/:token` | per-user access link (`AccessLinkPage`) | Bound to one account; PIN-gated |
| `/reset-password?token=&username=` | password-reset token + username | **Account takeover on its own, for 24h** (`src/pages/ResetPassword.tsx:222-223`) |
| `/verify-email?token=` | email-verification token | Confirms an address (`src/components/VerifyEmailPage.tsx:21`) |

That much is V9, known and accepted. What this pass found is where those URLs
went: `src/lib/posthog.ts` initialises with `capture_pageview: true`,
`capture_exceptions: true` and session recording, and had **no
`before_send`/`sanitize_properties` hook of any kind**. PostHog attaches
`$current_url` and `$pathname` to *every* captured event, persists
`$initial_current_url` / `$initial_referrer` as person properties, and rrweb
stamps the page `href` onto the replay's own Meta event. So for as long as one
of those five pages was open — and, via the `$initial_*` person properties,
afterwards — the credential was exported verbatim to a third-party US processor,
on every pageview, every `$exception`, and every replay snapshot.

Three details make this worse than it first looks:

1. **Masking did not cover it.** `maskAllInputs: true` and the OPS-3
   `maskTextSelector` both mask *rendered DOM text*. A URL is neither an input
   nor page text — exactly the gap V3 found for `console` output, in a different
   sink.
2. **Consent defaults to on.** `isAnalyticsEnabled()` returns `true` when no
   choice has been recorded (`src/lib/analytics-consent.ts:6-8`), so a *fresh
   browser* — the `/link/:token` diode-zone case, which is by construction a
   browser with no stored choice — captures and records by default.
3. **The `/link/` page is the surveillance-sensitive one.** Its token is
   PIN-gated, so the token alone grants nothing; the disclosure is the **D3
   linkage** (this account, this link, this IP, this minute), which is precisely
   what that feature was designed to withhold. **JUDGMENT** on impact; **FACT**
   that the value was exported.

**Fixed:** `src/lib/analytics-redaction.ts` — a `before_send` hook
(`redactCaptureEvent`) wired into `posthog.init`, redacting by *position*
(the segment after `/join`, `/join-org`, `/link`) and by *query-parameter name*
(`token`, `t`, `pin`, `code`, `key`, `secret`, `password`, `invite`, `username`,
`email`, …) across:

- every property whose name says it holds a URL (`$current_url`, `$pathname`,
  `$referrer`, `$initial_*`, `$session_entry_*`, and our own `route` property in
  `report-problem.ts`) — name-based rather than an allowlist, so a new
  PostHog-added property inherits it;
- `$set` / `$set_once`, so the persisted person properties are covered;
- `$snapshot_data`, so the replay's rrweb `href` is covered too.

The hook never drops an event and leaves everything else byte-for-byte alone:
non-URL properties, user-authored text, and ordinary URLs are untouched, so
analytics keep working and `/join/[redacted]` still says "someone opened an
invite link".

`src/lib/posthog-redaction-guard.test.ts` is the drift guard (same shape as
OPS-11's): every `posthog.init(` call site in `src/` must pass
`before_send: redactCaptureEvent`, so a second entry point — another brand, the
desktop shell — cannot ship without it.

### OPS-30 — Parser errors quoted the document's own text into import telemetry — **FIXED** [FACT]

Import failures are telemetry: both import surfaces send the thrown message to
PostHog as `IMPORT_FAILED.error_message` *and* again through
`captureException` (`src/components/ImportDialog.tsx:1221-1228,1374-1381`,
`src/components/import/UploadPanel.tsx:230-236,370-377`).

Four parsers interpolated parser-produced detail into that message:

- `src/lib/parsers/json-i18n.ts:80` — `Invalid JSON in ${label}: ${err.message}`.
  **V8 quotes the input verbatim in that message.** Verified at this commit:
  `JSON.parse('{"verse": The LORD is my shepherd}')` throws
  `` Unexpected token 'T', ..."{"verse": The LORD i"... is not valid JSON `` —
  a ~20-character slice of the document, shipped as an event property.
- `src/lib/parsers/tmx.ts:89`, `usx.ts:103`, `xliff.ts:376` — 200 characters of
  the browser's `<parsererror>` body, which quotes markup and element/attribute
  names from the document (**JUDGMENT** on how much prose a given engine's
  message includes; **FACT** that it is document-derived and untruncated of
  content).

Why it matters at all, given it's only a slice: for D2 the sensitive fact is
*which passage, in which language* — and a slice of a verse answers both. It is
also the one path where draft content reaches PostHog as an **event property**,
which OPS-3's replay masking by construction does not cover.

**Fixed:** `src/lib/parsers/parse-error-detail.ts` — `sanitizeParseDetail`
strips the quoted document spans (both shapes V8 emits) and collapses
`<parsererror>` whitespace, keeping every structural detail a person debugging
an import actually uses: the offending token, `at position N`, `line L column C`.
All four parsers now route their detail through it. The user-facing message is
unchanged in shape, so the import UI still explains the failure.

Deliberately **not** done: attaching `{ cause: err }` at the JSON site (the
`preserve-caught-error` lint warning there predates this change). The cause
would carry the original, unredacted V8 message, and exception capture walks
cause chains — that would re-open the finding to satisfy a lint warning.

---

## 3. Risk assessment

| ID | Finding | Likelihood | Impact | Risk | State |
|---|---|---|---|---|---|
| OPS-29 | Invite / access-link / password-reset tokens exported to PostHog in `$current_url` and replay `href` | **High** — no attacker needed; it happened on every visit to those routes with analytics on (the default) | High — a password-reset token is 24h account takeover; the `/link/` case is a D3 linkage for the population most at risk | **High** | Fixed |
| OPS-30 | Document slice in `IMPORT_FAILED.error_message` / `$exception` | Medium — needs a malformed import, which is exactly when it fires | Low-Medium — a ~20-char slice identifies passage and language (D2/D3), not the corpus | **Medium** | Fixed |

Both rows share the shape `docs/OPSEC.md` §4 already noted for the highest-risk
findings: neither is an attack. They are data we exported on purpose, in fields
nobody re-read after adding them.

## 4. Countermeasures applied in this change

| Control | Where |
|---|---|
| Credential redaction on every outbound analytics event (`before_send`) | `src/lib/analytics-redaction.ts`, `src/lib/posthog.ts` |
| Redaction covers `$set`/`$set_once` person properties and replay `$snapshot_data` hrefs | `src/lib/analytics-redaction.ts` |
| Drift guard: every `posthog.init(` site must wire the redactor | `src/lib/posthog-redaction-guard.test.ts` |
| Document text stripped from parser error detail | `src/lib/parsers/parse-error-detail.ts` + `json-i18n.ts`, `tmx.ts`, `usx.ts`, `xliff.ts` |

Each has a test: `src/lib/analytics-redaction.test.ts` (14 cases — each of the
five credential routes, the `?t=` media token, non-sensitive URLs left
byte-identical, replay hrefs, `$set_once`), `src/lib/parsers/parse-error-detail.test.ts`
(the real V8 messages, verified against the engine, plus the position-only
message that must survive intact), and the drift guard above.

## 5. Reviewed and confirmed safe — no change needed

- **Worker-side logging** — swept `auth-worker/src` and `sync-worker/src` for
  `console.*` calls naming a token, password, secret, bearer or credential:
  every hit logs an error object or a fingerprint, never the material itself.
  V3's fingerprinting convention has held (`src/lib/sync/invites.ts` logs
  `tokenFingerprint(token)`).
- **`?t=` media tokens** (`src/lib/audio/upload.ts:238`) — accepted by
  `sync-worker/src/audio.ts:236` for **GET only**, with writes header-only and an
  explicit comment saying why; the sync token is 15-minute and file-scoped. The
  URL is now redacted on the analytics path as well (OPS-29), and the `<audio>`
  element it feeds is constructed detached, not mounted into the recorded DOM.
- **Invite link unfurls** — `worker/index.ts:29-40` still serves deliberately
  generic OG copy with no token, project, org or inviter name (AQU-471);
  `/link/:token` gets no invite meta at all.
- **Other capture sites** — `IMPORT_*`, `OUTBOX_QUARANTINED`, `FIRST_CELL_*`,
  export, org/invite events: re-read every `posthog.capture(` call in `src/`.
  They send ids, counts, kinds and extensions — no cell text, no email, no
  token. `report-problem.ts` sends a user-authored description, which is the
  point of the feature and is consent-gated.
- **Identity** — `posthog.identify()` uses `sha256Hex(username)` as the
  distinct id (`src/hooks/useFrontierSession.ts:32,41`), not the username.

## 6. Effectiveness of existing controls — what needs adjustment

| Control | Finding | Action |
|---|---|---|
| PostHog input/text masking (`maskAllInputs`, OPS-3 `maskTextSelector`) | Covers rendered text only; missed URLs (OPS-29) and event properties (OPS-30) — the same blind spot V3 found for `console` | Fixed at the event boundary, which covers all three sinks at once |
| Analytics consent default | `isAnalyticsEnabled()` defaults to **enabled** before any choice is recorded, so a fresh browser is captured and recorded by default | **Flagged, not changed** — see below |
| V9 "tokens in URL paths are mitigated" | The mitigations listed (referrer policy, generic unfurls) did not cover our own outbound analytics | `docs/OPSEC.md` V9 should now read "mitigated, including on the analytics path" |

**Flagged for a product/privacy decision, not changed here:** opt-out-by-default
analytics. Making capture opt-*in* would be the stronger posture for the
`/link/:token` population specifically, but it is a product and data-volume
decision with a real cost to the funnel instrumentation the business plan in
`docs/SELF-DRIVING-ROUTINES.md` depends on — not something to flip as a side
effect of a security pass. A narrower option, if the full flip is unwanted:
suppress capture *only* on the credential-bearing routes. Recorded here so the
choice is deliberate rather than inherited.

## 7. Operator-side practices — unchanged, still the likeliest weak link

`docs/OPSEC.md` §5 lists these and none are verifiable from this repo:
hardware-backed MFA on Cloudflare / GitHub / Neon / OpenRouter / Apple, a
password manager with unique credentials, compartmentalised code-signing keys, a
CI `CLOUDFLARE_API_TOKEN` scoped to the Workers it deploys, and treating invite
links as credentials (never in a screenshot or a ticket — OPS-29 is the
machine-side half of that rule; the human half is still human). Re-flagged
rather than restated at length.

## 8. Not fixed here — needs follow-up

- **V7/SEC-1** — production and development still share `SECRET_KEY` /
  `SYNC_SECRET_KEY`. Unchanged, still the highest-leverage open item in the whole
  series.
- **OPS-24** — the credit-guard check-then-act race; still needs a billing-scoped
  pass.
- **OPS-26** — invite tokens stored plaintext at rest; a product decision about
  re-displaying live invite tokens, not a mechanical port of OPS-20.
- **OPS-27's enforce-flag question** — whether to ever set
  `AI_BUDGET_ENFORCE` / `CREDIT_ENFORCE` / `TTS_BUDGET_ENFORCE` to `true`.
- **Opt-out-by-default analytics** — §6 above.

---

_Re-run the mechanical parts of this review with: `npx tsc -b`,
`npx vitest run src/lib/analytics-redaction.test.ts
src/lib/posthog-redaction-guard.test.ts src/lib/parsers`, and
`node -e "try{JSON.parse('{\"v\": The LORD}')}catch(e){console.log(e.message)}"`
to re-confirm OPS-30's premise against the current engine._
