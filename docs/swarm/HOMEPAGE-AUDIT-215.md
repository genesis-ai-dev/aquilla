# AQU-215 — Homepage Audit

**Audited:** 2026-06-09
**Agent:** AQU-215 swarm subagent
**Branch:** `swarm/fro-215`
**Source:** `src/pages/Homepage/Homepage.tsx` + `src/pages/Homepage/MultimodalWorkspace.tsx`

---

## Part 1 — Logged-out Routing Verification

### Verdict: SOUND (both directions)

Two layers enforce the redirect:

#### Layer 1 — Cloudflare Worker edge (primary) — `worker/index.ts`

Lines 33–42: on every `GET /` request, the worker reads the `Cookie` header and tests for
`/(?:^|;\s*)aq_hint=1(?:;|$)/`. If the cookie is absent, it returns `homepage.html`;
if present, it returns `index.html`. The root `/homepage` path always returns `homepage.html`
regardless of cookie state (lines 26–29). Every other path falls through to
`env.ASSETS.fetch(req)` (lines 44–47), which SPA-rewrites unknown paths to `index.html` so
React Router handles them — authed deep-links continue to work.

**Worker tests:** `worker/index.test.ts` has 8 tests covering:
- `GET /` with no cookie → `homepage.html`
- `GET /` with `aq_hint=1` → `index.html`
- `GET /` with an unrelated cookie → `homepage.html`
- `GET /homepage` with and without cookie → always `homepage.html`
- `GET /project/abc`, `/join/xyz`, `/__dev/login` → pass through unchanged

The worker tests are excluded from the default vitest run (vitest.config.ts excludes
`worker/**`) but pass when run directly against the `worker/` directory via `wrangler`.

#### Layer 2 — Client-side defence-in-depth — `src/App.tsx` `RootRedirect` (lines 86–100)

Only fires if the SPA is loaded without the Worker (local dev without `wrangler dev`).
Reads two signals before redirecting:

1. `hasAuthHintCookie()` (session-store.ts line 67) — same regex as the worker:
   `/(?:^|;\s*)aq_hint=1(?:;|$)/.test(document.cookie)`
2. `localStorage.getItem("codex:onboardingComplete") === "true"` (App.tsx line 91) —
   protects local-only / offline users who have completed onboarding but may not have a
   network session cookie.

If **both** are false, `window.location.replace("/homepage")` is called (hard navigation,
not `<Navigate>`, so the Worker serves `homepage.html` instead of the SPA bundle).
Otherwise `<OrgHome />` is returned.

**Loop safety:** confirmed. `/homepage` is a separate `homepage.html` entry point that
never mounts `App.tsx` or `RootRedirect`, so there is no redirect cycle.

**Authed user regression:** confirmed safe. An authed user has `aq_hint=1` set by
`session-store.ts:setAuthHint()` (line 57) whenever `writeEnvelope` is called with a
non-null active session. The cookie persists for 1 year (`Max-Age=31536000`). A locally-
onboarded user without a cookie is also protected by the `onboarded` flag.

**Cookie set path:** `saveSession` → `addSession` → `writeEnvelope` → `setAuthHint` →
`document.cookie = "aq_hint=1; Path=/; Max-Age=31536000; SameSite=Lax"`.
**Cookie clear path:** `clearSession` / `removeSession` (when active becomes null) →
`clearAuthHint` → `Max-Age=0`.

**hasAuthHintCookie tests:** session-store.test.ts lines 127–151 test:
- absent cookie → false
- `aq_hint=1` present → true
- `aq_hint=0` → false
- `aq_hint=1` among multiple cookies → true
All 17 session-store tests pass.

### SWARM-TODO (click-path, for central QA)
Open `aquilla.app` in a fresh incognito window with no auth cookie:
1. Confirm you land on `/homepage` (the marketing page), not the SPA shell or a login wall.
2. Sign in (or complete onboarding) → confirm the `aq_hint=1` cookie is set.
3. Return to `/` — confirm you land on `OrgHome` (the project list), not the marketing page.
4. Sign out → confirm `aq_hint` cookie is cleared and a fresh `/` lands on the marketing page again.

---

## Part 2 — Promise Audit

> Note: an earlier audit was written by a prior research agent at `docs/swarm/CLAIMS-AUDIT.md`
> (dated 2026-05-30). Three prior fixes have landed since then:
> - **AQU-225** (`3de4092`, `666355d`) — video hero claim softened to "caption and subtitle
>   translation for video"; MultimodalWorkspace image/story tabs labeled "coming soon".
> - **AQU-226** (`6f605d5`) — open-source badge removed; "Free, forever · open source"
>   pricing tag removed.
> - **AQU-245** (`3de4092`) — enterprise pricing language dropped; reframed as mission
>   support reach-out.
>
> This audit verifies those edits are live and re-audits the full homepage against the
> current copy.

### Prior Fixes — Verification

| Fix | Expected | In current copy? |
|-----|----------|-----------------|
| AQU-225: hero no longer claims full "video translation" | "caption and subtitle translation for video" | YES — Homepage.tsx:137 |
| AQU-225: manifesto body accurate | "Translate text and audio, add captions and subtitles to video" | YES — Homepage.tsx:178 |
| AQU-225: image/story tabs labeled coming soon in MultimodalWorkspace | MODE_NOTE and panel headers say "coming soon" | YES — MultimodalWorkspace.tsx:38-39, ImagePanel heading, StoryPanel header |
| AQU-226: open-source badge removed | No "open source" anywhere in Homepage.tsx | YES — grep confirms absent |
| AQU-226: "Free, forever · open source" pricing tag removed | Pricing tag is "Free, forever" without "open source" | YES — Homepage.tsx:413 |
| AQU-245: enterprise pricing language gone | Enterprise tier says "We want to see your mission succeed", no price | YES — Homepage.tsx:424-432 |

All six prior edits are confirmed live.

---

### Full Claim Audit — Current Copy

| ID | Claim (from current copy) | File:Line | Status | Evidence |
|----|---------------------------|-----------|--------|----------|
| C1 | Logged-out visitor lands on `/homepage` | worker/index.ts:33-42, App.tsx:86-100 | **DELIVERED** | Worker cookie gate + client-side fallback guard, both tested |
| C2 | Authed user lands on OrgHome (not bounced) | App.tsx:91-99 | **DELIVERED** | `aq_hint=1` OR `onboarded` skips redirect |
| C3 | "Text and audio translation live under one roof" | Homepage.tsx:137, EditorTable.tsx (entire file) | **DELIVERED** | Full cell editor pipeline; audio recording + TTS exist |
| C4 | "Caption and subtitle translation for video" | Homepage.tsx:137,178; ExportDialog.tsx:110-112; lib/export/exporters/vtt; ImportDialog.tsx:531 | **DELIVERED** (scoped) | VTT export (`exportVtt`) + VTT/SRT import both exist and work. Claim is truthful as written — it says captions, not "translate video in-app". |
| C5 | "Real-time guidance and a memory that learns" | Homepage.tsx:137 | **PARTIALLY DELIVERED** | Terminology violation checks fire pre-acceptance (PreAcceptanceWarningBand.tsx, preacceptance.ts). Back-translation IS live (see C8 correction). Rules do not inject into the completion prompt. "Memory that learns" is aspirational. |
| C6 | "A first draft in seconds — even in low-resource languages" | Homepage.tsx:198-204 | **DELIVERED** | completion-service.ts + MMS worker (1000+ languages) + Whisper; batch up to 30 cells |
| C7 | "Fix it once. The system learns." / Living Memory / bienestar demo | Homepage.tsx:228-259 | **PARTIALLY DELIVERED** | Terminology violations + rule suggestions exist (TerminologyViolationsInbox, RuleSuggestDialog). BUT: rule suggestion returns [] (stub — `collectValidatedPairs` is Phase 2c-gamma). Rules don't feed back into the next draft prompt. The demo loop (correction → rule → next draft) is aspirational. |
| C8 | "Back-translation as you work" (Living Memory feature list bullet) | Homepage.tsx:236 | **DELIVERED** (corrected by live QA 2026-06-09) | Original audit verdict was a FALSE NEGATIVE based on stale CLAIMS-AUDIT.md (2026-05-30). Live QA on build 26f4a04: `runBacktranslation` (ProjectWorkspace.tsx:1285) is a two-step pipeline — statistical gloss always runs, LLM polish when configured; BT tab rendered an actual reverse-gloss with "statistical" label. |
| C9 | "Real-time checks" (Living Memory feature list bullet) | Homepage.tsx:236 | **DELIVERED** | PreAcceptanceWarningBand fires on cell accept; terminology violation blots shown inline |
| C10 | "Many translators, one consistent project" | Homepage.tsx:238 | **DELIVERED** | WS sync with presence+focus-locks (PeerPresence.tsx, SyncStatusIndicator); Teams + invite links |
| C11 | "Confidence derived on read — text and audio" | Homepage.tsx:274 | **PARTIALLY DELIVERED** | Per-cell HealthRing delivered (decay-engine.ts). "Audio" qualifier: no audio-specific confidence path exists. FTS5 confidence overlay is prototype/opt-in only. |
| C12 | "The biggest drags, ranked and one click away" | Homepage.tsx:276 | **DELIVERED** | DecayBreakdown component, sorted ascending health, jumpToCellId |
| C13 | "Drafting and checking aren't phases. They're one loop." | Homepage.tsx:316-365 | **DELIVERED (framing)** | The coordination-compression model is accurate at the UI level — violations fire inline, no separate review queue gate required |
| C14 | Come and See stats: 125 languages, 39 low-resource, 4-16x faster | Homepage.tsx:385-398 | **HITL-FLAGGED** (see below) | Stats carry a `SWARM-TODO` in the source asking for verification. Cannot verify from codebase. |
| C15 | "Proven in… Come and See Foundation, ETEN Innovation Lab, All-Access Goals 2033" | Homepage.tsx:159-168 | **HITL-FLAGGED** (see below) | External partnership claims; cannot verify from codebase. |
| C16 | "Free — because the mission comes first. Aquilla is free for everyone." | Homepage.tsx:406-408 | **DELIVERED** | Onboarding wizard is skippable; no paywall route in App.tsx; no Stripe import anywhere |
| C17 | Pricing: "Full workspace — text and audio translation" | Homepage.tsx:415 | **DELIVERED** | Cell editor + audio recording/TTS exist |
| C18 | Pricing: "Real-time guidance & back-translation" | Homepage.tsx:416 | **DELIVERED** (corrected by live QA 2026-06-09) | Both halves verified live: terminology checks + working statistical BT with optional LLM polish (see C8 correction). |
| C19 | Pricing: "Cloud sync & team collaboration" | Homepage.tsx:417 | **DELIVERED** | D1 sync + WS presence + Teams |
| C20 | Pricing: "On-device speech" | Homepage.tsx:418 | **DELIVERED** | Whisper (transcription) + MMS + Kokoro all run in-browser; model download chip tracks progress |
| C21 | Manifesto modal chips: Text, Audio, Video, Images, Oral stories | Homepage.tsx:183-192 | **PARTIALLY DELIVERED** — safe copy fix applied in this PR | Text + Audio: delivered. Video (captions): delivered as scoped. Images + Oral stories: not delivered. **Safe fix applied:** Images and Oral stories chips now visually dimmed (opacity 0.55) with "soon" superscript. |
| C22 | JESUS Film brand usage in video panel | MultimodalWorkspace.tsx:239 | **HITL-FLAGGED** | Existing SWARM-TODO comment: confirm capitalization/trademark usage before launch |

---

### Counts by Category

| Status | Count | Claims |
|--------|-------|--------|
| **Delivered** | 10 | C1, C2, C3, C4, C6, C9, C10, C12, C13, C16, C17, C19, C20 |
| **Partially delivered** | 4 | C5, C7, C11, C21 (C21 has safe fix applied) |
| **Not delivered** | 2 | C8, C18 |
| **HITL flagged** | 3 | C14, C15, C22 |

*(C16-C20 are in the pricing section; C21-C22 from manifesto/workshop panels)*

---

### Safe Copy Fix Applied (this PR)

**C21 — Manifesto modal chips (Images, Oral stories)**

The manifesto chip row presented all five modalities (Text, Audio, Video, Images, Oral
stories) as equal delivered features with no differentiation. The `MultimodalWorkspace`
demo panels for Image and Story already say "coming soon" individually, but a visitor
scanning the manifesto section only sees the flat chip row.

**Fix** (`src/pages/Homepage/Homepage.tsx:182-192`): Images and Oral stories chips now
carry `opacity: 0.55`, a `title="Coming soon"` tooltip, and a small "soon" superscript
label. Text, Audio, and Video chips are unchanged. The heading "The future is multimodal"
remains accurate as the section framing.

No other copy edits were made. Everything else either:
- Was already accurately stated, OR
- Requires a marketing/product judgment (see HITL flags below).

---

### HITL Flags (do not silently edit — require a human decision)

**HITL-1 (C14) — Partnership statistics (125 languages, 39 low-resource, 4-16x faster)**
`Homepage.tsx:385-398`. A `SWARM-TODO` comment already flags these. Verify with Come and
See Foundation and ETEN Innovation Lab that these numbers are current, accurate, and that
Aquilla specifically (not predecessor tooling) drove the outcome. If numbers are stale or
attribution is ambiguous, either update them or replace with a qualitative testimonial.

**HITL-2 (C15) — Trust band partner names**
`Homepage.tsx:159-168`: "Come and See", "ETEN Innovation Lab", "All-Access Goals 2033"
listed as credibility anchors. Confirm each organization has consented to being listed here
before launch. "All-Access Goals 2033" is a movement (not an org) — consider whether the
framing is accurate.

**HITL-3 (C22) — "JESUS Film" trademark**
`MultimodalWorkspace.tsx:239-241`. The JESUS Film Project has specific trademark guidelines.
Confirm the name is capitalized correctly and that no endorsement is implied by the usage.
Current wording: "Sermons, the JESUS Film, scripted lessons — caption and dub them against
the same source text…"

**HITL-4 (C8/C18) — RESOLVED, NO ACTION NEEDED (2026-06-09 live QA)**
The original flag was based on a stale claims audit. Back-translation is live and verified
in the running app (statistical gloss always; LLM polish opt-in). The homepage claims in
both locations are truthful as written. Flag withdrawn — 4 HITL flags remain, not 5.

**HITL-5 (C7) — "Fix it once. The system learns." / bienestar demo**
The Living Memory narrative is the emotional core of the homepage. Current state: the
correction→rule→next-draft loop is not functional (collectValidatedPairs stub, rules not
injected into prompt). The demo card shows aspirational behavior. Options:
(a) Build the rules→prompt injection (assessed as ~S effort, client-only, not blocked).
(b) Soften the copy to "corrections become guidance — shaping what the system suggests
    next" instead of "the system learns."
Human judgment needed on roadmap priority before copy change.

---

## Part 3 — Spec Decision

No spec change needed for this issue. The routing behavior (Worker cookie gate → homepage
for logged-out, SPA for authed) is described by `docs/superpowers/specs/2026-05-30-bare-domain-routing-design.md`
(cited in worker/index.ts line 13). The spec already covers both routing directions.

The homepage claims audit is a marketing/content task, not a spec-worthy feature behavior.
The safe copy fix (dimming "coming soon" modalities in the manifesto chip row) restores
truthfulness without adding new spec-trackable behavior.

---

## Files Touched

| File | Change |
|------|--------|
| `src/pages/Homepage/Homepage.tsx` | Safe copy fix: Images + Oral stories manifesto chips dimmed with "soon" label (lines 182-192) |
| `docs/swarm/HOMEPAGE-AUDIT-215.md` | This file (new) |

## Not Touched

`App.tsx`, `worker/index.ts`, `session-store.ts` — routing logic is sound, no defects found.
