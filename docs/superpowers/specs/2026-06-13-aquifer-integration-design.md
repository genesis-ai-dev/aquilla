# Bible Aquifer Integration — Design Spec

**Date:** 2026-06-13
**Status:** Implemented & UI-verified (branch `feat/aquifer-integration`)
**Source resource:** `https://bibletranslation.org/llms.txt` (our own site)

## Problem

The translation agent and the editor have no access to external scholarly Bible
reference data. `bibletranslation.org` (ours) exposes a purpose-built,
token-frugal agent API over a large corpus — 25k verse-level passage pages,
3,426 people, 868 key terms, places, groups, deities, themes, the UW Translation
Manual, and translator-questions — synthesized from open-source scholarly sources
(UW Translation Notes/Words/Questions, Aquifer Open Study Notes, Biblica Study
Notes, SIL Open Translators Notes, ACAI). We want the agent and the editor UI to
leverage it.

## The external API (verified 2026-06-13)

- `GET /api/search?q=<query>&lang=en&limit=5`
  → `{query, lang, count, results: [{title, url, kind, description}], hints}`.
  `kind` ∈ `book | person | place | term | group | fauna | flora | deity |
  realia | theme | manual | translator-question | story`.
- `GET /api/page?path=/en/people/abraham/&max_chars=15000`
  → `{path, url, title, truncated, text}`. **`text` is plain text, not markdown.**
- `POST /api/answers` `{question, answer, status, citations[≥1], lang?, agent?}`
  → page URL `/qa/<slug>/`. Rate limit 30 posts/hour/IP. Idempotent on
  normalized question text. `status` ∈ `answered | undetermined`.

Notes that shaped the design:
- The site **403s generic User-Agents** — the client must send a descriptive UA.
- The model/UI supply a **path** (e.g. `/en/passages/RUT/1/8/`), never a full
  URL — the client composes the URL against an allowlisted base (no SSRF).
- `format=md` is **not** supported today; we send it speculatively so plain text
  upgrades to markdown the day the site adds it, with zero client rework.

## Surfaces (two) + a gate

Everything is gated behind a project setting `bibleResourcesEnabled`, **default
off**. When off, the Search-dock mode is not rendered and the agent's `aquifer`
branch is rejected — the feature "simply isn't a visible option." A project
setting (not per-user localStorage) is required so the server-side, project-scoped
agent reads the same gate as the client UI.

### 1. Agent — a 4th branch on the existing `execute` tool

Preserves the one-tool design. `execute` gains a mutually-exclusive `aquifer`
field:

```
aquifer: {
  op: "search" | "read" | "publish",
  q?: string, limit?: number,                       // search
  path?: string, maxChars?: number,                 // read
  question?: string, answer?: string,               // publish
  status?: "answered" | "undetermined",
  citations?: { url: string, title?: string, quote?: string }[]
}
```

- `search` / `read` → call the shared client, return compressed text into the
  loop (token-frugal, like SQL results). Metered as normal agent tokens.
- `publish` → **stages an `aquifer_publish` proposal** (reuses the `emit`
  staging pattern). Nothing leaves the worker until the user clicks Apply. Apply
  → `POST /api/v1/aquifer/answers` → which calls `aquiferPublishAnswer`. **This
  apply path deliberately skips the credit ledger** — publishing costs the user
  no credits (only the agent's own reasoning tokens during the run are metered,
  as today).
- New `auth-worker/src/lib/agent/aquifer-guard.ts` validates required fields per
  `op` and enforces the `bibleResourcesEnabled` gate.
- `schema-card.ts` L1 system prompt gains a short Aquifer contract (only when the
  gate is on). `docs.ts` gains an `aquifer` cookbook: the research loop
  (search → read → answer) and the publish etiquette ("publish what you learned,
  even when `undetermined`, with ≥1 citation").

### 2. Search dock — "Bible resources" mode

The reference reader lives inside `src/components/SearchDockPanel.tsx` (a
left-dock tab), **not** a new tab or right-aside panel. `SearchDockPanel` gains a
scope toggle: **Project** (today's cell/file search) vs **Bible resources**
(shown only when `bibleResourcesEnabled`). In Bible-resources mode:

- Query box → `GET /api/v1/aquifer/search` → results list (title · `kind` chip ·
  description).
- Select a result → `GET /api/v1/aquifer/page` → **reader view rendered inline in
  the dock**. Plain text via `whitespace-pre-wrap` now; the renderer swaps to the
  existing `ChatMarkdown` component automatically once responses arrive as
  markdown (`format=md`).
- **Current-verse quick action:** when a cell is focused, a one-tap button
  ("Notes for GEN 1:1") maps the focused `canonicalRef` → `/en/passages/{BOOK}/
  {chapter}/{verse}/`. Explicit tap, not auto-fetch — no surprise latency.
- These read-only endpoints require auth but **consume no credits** (no LLM
  involved).

`focusedCellCanonicalRef` already exists in `ProjectWorkspace` and is threaded to
right-aside panels; it must be threaded into `SearchDockPanel` too.

## Server architecture (auth-worker)

### Shared client — `auth-worker/src/lib/aquifer/client.ts`

Single typed wrapper used by the agent route and the read-only endpoints:

- `aquiferSearch(env, q, { lang?, limit? })`
- `aquiferReadPage(env, path, { maxChars? })` — sends `format=md` speculatively.
- `aquiferPublishAnswer(env, payload)`

Hardening:
- **Host allowlist** — URL composed from `env.AQUIFER_BASE_URL`
  (default `https://bibletranslation.org`); callers pass paths/queries only.
- Descriptive `User-Agent` header (env `AQUIFER_USER_AGENT`, sensible default).
- `AbortController` timeout (~5s).
- Response **size cap** (truncate defensively even when caller omits `max_chars`).
- Workers **Cache API** on the two idempotent GETs (search/page).
- Every method returns `{ ok: true, … } | { ok: false, error: string }` — never
  throws into the agent loop or the HTTP handler.

### Routes (auth-worker)

- `GET  /api/v1/aquifer/search` — auth required, gated, no credits → client.search
- `GET  /api/v1/aquifer/page`   — auth required, gated, no credits → client.readPage
- `POST /api/v1/aquifer/answers` — auth required, gated, **no credits** →
  client.publishAnswer (called by the proposal Apply path)

All three check `bibleResourcesEnabled` for the project and 403/404 when off.

### Config (Env, `auth-worker/src/types.ts`)

- `AQUIFER_BASE_URL?: string` (default `https://bibletranslation.org`)
- `AQUIFER_USER_AGENT?: string` (default e.g. `Aquilla/1.0 (+https://aquilla.app)`)

### Wire contract / proposals

`protocol.ts` (server + mirrored client) gains an `aquifer_publish` proposal
variant in the existing proposal union: `{ kind: "aquifer_publish", question,
answer, status, citations }`. `ProposalCard.tsx` renders it (question + answer
preview + citation list) with Apply/Discard; Apply calls the new POST endpoint
instead of flushing to the sync-worker `/events` outbox.

## Settings flag wiring

- `bibleResourcesEnabled: boolean` in the project settings model (server
  `project_settings` + client settings types), default `false`.
- A toggle in Project Settings UI (where other project-level feature flags live).
- Read paths: the agent reads it server-side (it already reads `project_settings`
  via SQL); the Search dock reads it from the client settings the UI already
  loads; the three routes verify it before doing any external call.

## Reference parsing

A small helper maps a `canonicalRef` like `"GEN 1:1"` →
`/en/passages/GEN/1/1/`. Book tokens in `canonicalRef` are USFM codes already
(GEN, RUT, …), so the mapping is a parse + format, not a lookup table. Reuse the
existing canonical_ref grammar (see the agent `files-and-refs` cookbook).

## Testing & verification

- `scripts/mock-aquifer.ts` — mirrors `scripts/mock-openrouter.ts`; serves canned
  `/api/search`, `/api/page`, `/api/answers`; `AQUIFER_BASE_URL` points at it so
  tests never hit the live site.
- **Unit:** `aquifer-guard` (op validation, gate), client (allowlist, truncation,
  cache hit, error surfacing, speculative `format=md`), ref→path helper.
- **Integration (agent route):** `search → read → publish` produces an
  `aquifer_publish` *proposal* (no live POST); gate-off rejects the branch.
- **Integration (endpoints):** the three routes — auth, gate on/off, no-credit
  assertion.
- **Real-UI walkthrough** (standing preference): drive the agent doing an Aquifer
  lookup, and the Search-dock Bible-resources mode searching + reading a page,
  with the project flag toggled on. Confirm the mode is absent when the flag is
  off.

## Out of scope (v1)

- Chat-side Aquifer affordance (explicitly dropped — the Search-dock reader
  replaces it).
- Auto-fetch of the current verse without a user tap.
- Caching contributed Q&A (`/qa/`) locally.
- Per-user (vs per-project) gating.

## Success criteria

1. With `bibleResourcesEnabled` **off**: no Bible-resources mode in the Search
   dock; agent `aquifer` calls are rejected; no external requests are made.
2. With it **on**: the agent can `search`/`read` Aquifer and stage a publish
   proposal that POSTs only on Apply, with no credit charge; the Search dock can
   search and render a page inline, including the current-verse quick action.
3. All new unit + integration tests pass; the real-UI walkthrough succeeds
   against the mock.
