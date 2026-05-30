# Bare-domain routing for aquilla.app

**Status:** Design approved, ready for implementation plan
**Date:** 2026-05-30
**Scope:** Aquilla brand only (codex / honeycomb / context brands ship separately and are out of scope here)

## Problem

The aquilla SPA is deployed at `web.aquilla.app/*`. The bare apex `aquilla.app` is unrouted (the wrangler comments call it the "marketing apex" but no Worker is bound to it). We want `aquilla.app` to be the canonical app domain — signed-in users land directly on the app, signed-out visitors see a placeholder homepage. Linear's UX is the target: visit `linear.app` and you're instantly on your workspace if you're signed in; visit `linear.app/homepage` to bypass.

## Constraint that shapes the design

Linear can do server-side routing because their session lives in an HttpOnly cookie — the server reads the cookie and decides what HTML to return before any JS runs. **We can't do that directly:** our JWT lives in IndexedDB (`frontier`/`session` store), invisible to any Cloudflare Worker at request time. All API auth is bearer-token-only (`Authorization: Bearer …`), and every worker sends `Access-Control-Allow-Origin: *`. That model was a deliberate choice (see `auth-worker/src/index.ts` CORS comments) and is not in scope to change.

So we cannot replicate Linear's exact mechanism. We can replicate the *UX* (instant routing, no flash, real SEO for the homepage) by introducing a single-bit **auth-hint cookie** that mirrors IDB state. The hint is not a credential — real auth is unchanged.

## Goals

1. `aquilla.app/` serves the SPA when the user has a session, the homepage when they don't.
2. `aquilla.app/homepage` always serves the homepage (bypass for QA / debug / sharing).
3. All deep links (`/project/:id`, `/join/:token`, `/__dev/login`, etc.) fall through to the SPA's React Router, unchanged.
4. CORS, JWT plumbing, and the api.aquilla.app surface stay untouched.
5. `web.aquilla.app/*` is retired (hard cutover — there are no live email links to it yet).

## Non-goals

- Moving any auth state out of IndexedDB.
- Changing the marketing copy beyond a one-page placeholder.
- Migrating non-aquilla brands (codex / honeycomb / context) to the same pattern.
- Server-side rendering of the SPA.

## Architecture

### Route layout after the change

| Domain | Worker | What it serves |
|---|---|---|
| `aquilla.app/*` | `aquilla-web` | App shell, with `/` and `/homepage` special-cased at the edge |
| `api.aquilla.app/identity/*` | `aquilla-identity` | unchanged |
| `api.aquilla.app/sync/*` | `aquilla-sync-worker` | unchanged |
| `api.aquilla.app/chat/*` | `aquilla-identity` | unchanged |
| `web.aquilla.app/*` | — | **removed (step 7 of migration)** |

Staging mirrors with `dev.aquilla.app/*` replacing `web.dev.aquilla.app/*`.

### Worker request flow (the new bit)

```
GET aquilla.app/<path>
       │
       ├─ /homepage  → env.ASSETS.fetch("/homepage.html")
       │
       ├─ /          → Cookie contains aq_hint=1?
       │              yes → env.ASSETS.fetch("/index.html")  // SPA
       │              no  → env.ASSETS.fetch("/homepage.html")
       │
       └─ /*         → env.ASSETS.fetch(req)  // SPA fallback unchanged
```

The `aquilla-web` Worker switches from assets-only to a tiny `main` (~40 lines) that runs this check and then delegates to the existing static-asset binding.

### Why this is safe

- `aq_hint` is **not a credential**. A spoofed/stolen hint cookie only makes a non-user see the empty SPA shell — they still can't make API calls because they have no bearer token. The SPA reads the empty IDB envelope on mount and redirects to `/onboarding`. Same failure mode as today.
- The real auth path (`Authorization: Bearer <jwt>` → `api.aquilla.app`) is completely unchanged. No new origins to allow-list, no new SameSite considerations.
- CORS is unchanged: every API worker still sends `Access-Control-Allow-Origin: *`. The SPA's origin moving from `web.aquilla.app` to `aquilla.app` requires zero CORS edits.

## Components

### `aquilla-web` Worker

**`wrangler.toml`** — add a `main`, swap the route, add a staging environment.

```toml
name = "aquilla-web"
main = "worker/index.ts"     # NEW: was assets-only
# ... existing top-level config ...

[env.production]
name = "aquilla-web"
routes = ["aquilla.app/*"]   # was: web.aquilla.app/*
# ... existing assets block ...

[env.staging]                # NEW: doesn't exist today
name = "aquilla-web-staging"
routes = ["dev.aquilla.app/*"]
# ... mirrored assets block ...
```

**`worker/index.ts`** — new file, ~40 lines:

```ts
export interface Env { ASSETS: Fetcher }

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)

    if (url.pathname === "/homepage") {
      return env.ASSETS.fetch(new Request(new URL("/homepage.html", req.url), req))
    }

    if (url.pathname === "/") {
      const cookie = req.headers.get("Cookie") || ""
      const signedIn = /(?:^|;\s*)aq_hint=1(?:;|$)/.test(cookie)
      const target = signedIn ? "/index.html" : "/homepage.html"
      return env.ASSETS.fetch(new Request(new URL(target, req.url), req))
    }

    return env.ASSETS.fetch(req)
  },
}
```

**`public/homepage.html`** — new file. Static HTML: aquilla logo, one-line tagline, "Sign in" + "Sign up" buttons linking to `/onboarding`. No React, no Vite imports — keep it pure HTML/CSS so Vite copies it into `dist/` untouched (Vite's default behaviour for `public/`).

### SPA (`src/`)

**`src/lib/frontier/session-store.ts`** — add hint helpers and call them at the IDB write points:

```ts
const HINT_NAME = "aq_hint"

function setAuthHint() {
  // No Domain attribute: cookie is host-only. This deliberately scopes
  // the hint to whatever host wrote it, so prod (aquilla.app) and staging
  // (dev.aquilla.app) each manage their own hint independently.
  document.cookie = `${HINT_NAME}=1; Path=/; Max-Age=31536000; SameSite=Lax`
}
function clearAuthHint() {
  document.cookie = `${HINT_NAME}=; Path=/; Max-Age=0; SameSite=Lax`
}
```

Wire into `writeEnvelope`: if `env.active != null` → `setAuthHint()`; else → `clearAuthHint()`. This covers login, signout, account switch, and last-session-removed in one place. Host-only scoping means `localhost`, `aquilla.app`, and `dev.aquilla.app` each get their own hint without any environment-specific branching.

**`src/lib/frontier/session-store.test.ts`** — extend the existing test file to assert:
- After `saveSession`, `document.cookie` contains `aq_hint=1`.
- After signing out of the last session, the cookie is cleared.
- Switching active accounts (multi-session envelope) keeps the cookie set.

### auth-worker (email links)

**`auth-worker/wrangler.toml`** — update `BASE_URL` in both env blocks:
- L77 (`[env.production.vars]`): `https://web.aquilla.app` → `https://aquilla.app`
- L107 (`[env.staging.vars]`): `https://web.dev.aquilla.app` → `https://dev.aquilla.app`

**`auth-worker/src/routes/auth.ts:300`** — update the fallback default:
- `c.env.BASE_URL || "https://web.aquilla.app"` → `c.env.BASE_URL || "https://aquilla.app"`

### Comments / docs

- `wrangler.toml` L51, L61 — header comment refers to `web.aquilla.app`; update to reflect the new route.
- `.github/workflows/deploy.yml` L117 — comment mentions "the marketing apex (aquilla.app)"; reword to "the app domain (aquilla.app)".

These are doc-only; behaviour is driven by the `routes` lines above.

## Data flow

### Sign-in
1. User submits credentials → `auth.ts:login()` POSTs to `api.aquilla.app/identity/api/v2/auth/token`.
2. Response → `finalizeSession` → `saveSession` → `writeEnvelope`.
3. `writeEnvelope` writes IDB and calls `setAuthHint()` → `document.cookie = "aq_hint=1; …"`.
4. Next request to `aquilla.app/` includes the cookie; Worker serves `/index.html`.

### Sign-out (last session)
1. `signOut()` removes the session from the envelope.
2. `writeEnvelope` runs; `envelope.active === null`; `clearAuthHint()` fires.
3. Next request to `aquilla.app/` has no `aq_hint`; Worker serves `/homepage.html`.

### Bypass `/homepage`
1. Worker special-cases `/homepage` and always serves `homepage.html`.
2. "Sign in" / "Sign up" buttons link to `/onboarding`, which is a real SPA route — the SPA loads there and behaves as today.

## Edge cases

1. **Stale hint, expired JWT** (cookie Max-Age=1y > JWT 30d lifetime). Edge serves SPA → SPA reads valid envelope → API call returns 401 → existing redirect to `/onboarding`. Acceptable; same behaviour as today.
2. **Cookie present, IDB cleared.** Edge serves SPA → SPA reads empty envelope → navigates to `/onboarding`. Mitigation: in `useFrontierSession`, when boot reveals "no session," opportunistically call `clearAuthHint()` so the next visit goes straight to homepage.
3. **IDB present, cookie missing** (first-deploy rollout for users already signed in, or users who cleared cookies). Edge serves homepage. User clicks Sign In → lands on `/onboarding` → SPA reads valid envelope → navigates to Dashboard → `setAuthHint()` re-sets the cookie. Self-healing after one nav. Expected one-time annoyance on rollout — call out in release notes.
4. **Multi-session envelope.** Hint reflects `envelope.active != null`. Account switching keeps the hint set; signing out of the *last* session clears it. Driven from `writeEnvelope`, so it's automatic.
5. **Deep links.** Worker only special-cases `/` and `/homepage`. Everything else (`/project/abc`, `/join/xyz`, `/__dev/login`, …) falls through to `env.ASSETS.fetch(req)` and the existing SPA fallback. Invite links keep working.
6. **Local dev.** SPA runs at `localhost:5173`. The hint cookie is host-only (no `Domain`), so it scopes cleanly to `localhost` without any branching. The bare-domain Worker logic doesn't apply in dev; you visit `localhost:5173/` and React Router handles routing as today.
7. **SEO.** `homepage.html` is static HTML — indexable by crawlers without executing JS. Crawlers hitting `aquilla.app/` with no cookie see it directly.

## Testing strategy

**Unit (vitest):**
- `session-store.test.ts`: hint cookie is set after `saveSession`; cleared after last `signOut`; preserved across account switch.
- New `worker/index.test.ts` (via `unstable_dev` or Miniflare): `GET /` with no cookie → response body matches `homepage.html`; with `Cookie: aq_hint=1` → body matches `index.html`; `GET /homepage` (any cookie) → `homepage.html`; `GET /project/abc` → SPA fallback.

**E2E (existing Playwright suite):**
- Anonymous visit to `aquilla.app/` asserts homepage content present.
- After programmatic login, reload `aquilla.app/` and assert the app shell renders without an extra navigation.

**Manual smoke (verify-dev-change pattern):**
- Anonymous incognito to `aquilla.app/` → homepage.
- Sign in, reload `aquilla.app/` → app shell.
- Visit `aquilla.app/homepage` while signed in → homepage.
- Visit `aquilla.app/project/<id>` → SPA loads project route.

## Migration sequence (zero-downtime)

Numbered for the implementation plan to reference. Each step is additive until step 7.

1. **Pre-flight grep** for `web.aquilla.app` across the repo. Current inventory (2026-05-30):
   - `wrangler.toml:51,61` — route + header comment.
   - `auth-worker/wrangler.toml:8,77,107` — comment + prod/staging `BASE_URL`.
   - `auth-worker/src/routes/auth.ts:300` — fallback default.
   - `.github/workflows/deploy.yml:117` — comment only.
   No SPA-side references; CI env vars (`VITE_AUTH_BASE` etc.) all point at `api.aquilla.app` and are unaffected.
2. **Add `aquilla.app` route alongside `web.aquilla.app`** in `aquilla-web` wrangler.toml's `[env.production]`. Deploy. Both domains serve the SPA; no behaviour change yet (Worker is still assets-only, no homepage shipped).
3. **Ship `homepage.html`, `worker/index.ts`, and `session-store.ts` hint helpers** in one deploy, but with the Worker **always serving the SPA** (no hint read yet). Reason: this lets the hint cookie propagate to existing signed-in users before the edge starts gating on it.
4. **Flip the Worker to read `aq_hint`** on `/` and special-case `/homepage`. Deploy. Bare-domain routing now live on both `aquilla.app` and `web.aquilla.app`.
5. **Update `BASE_URL` and the `auth.ts:300` fallback** in auth-worker (prod + staging). Deploy auth-worker. New emails use `aquilla.app`.
6. **Wait one cookie-propagation window** (~1–2 days) so anyone signed in but not actively browsing has a chance to pick up `aq_hint`.
7. **Remove `web.aquilla.app/*` route** from `aquilla-web` wrangler.toml. Deploy. Hard cutover complete.
8. **Cloudflare cleanup** — the route removal is the operative kill switch. The `web` DNS record can be deleted or left orphaned.

If steps 2–4 reveal a regression, rollback is one wrangler revert: bare `aquilla.app` keeps serving SPA via the SPA-fallback path, the homepage check is gone, no users are stranded.

## Open questions

None at design time. Resolved during brainstorm:
- Detection mechanism — **cookie-hint + Worker edge** (matches Linear UX without changing auth model).
- Homepage scope — **minimal placeholder** (logo + tagline + Sign in/Sign up).
- web.aquilla.app fate — **hard cutover** (no live email links to preserve).
- Bypass route — **yes, `/homepage`** (matches Linear).
