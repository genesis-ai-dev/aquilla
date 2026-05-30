# Bare-Domain Routing for aquilla.app — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the aquilla SPA from `web.aquilla.app` to bare `aquilla.app`, routing signed-in users directly to the app and signed-out visitors to a static placeholder homepage via a lightweight edge hint cookie.

**Architecture:** A non-credential `aq_hint=1` host-only cookie is written to the browser whenever the IDB session envelope has an active session, and cleared on sign-out. The `aquilla-web` Cloudflare Worker (currently assets-only) gets a tiny `main` entry that reads this cookie at the edge: if present, serve `index.html` (the SPA); if absent on `/`, serve `homepage.html`; `/homepage` always serves `homepage.html`; all other paths pass through to the static-asset fallback unchanged.

**Tech Stack:** Cloudflare Workers (wrangler 4.x, `@cloudflare/workers-types`), Vitest + happy-dom (existing project test runner), pure HTML/CSS for the homepage, TypeScript throughout.

---

## File Map

| Status | File | Purpose |
|---|---|---|
| **Create** | `worker/index.ts` | Worker `fetch` handler: hint check + asset delegation |
| **Create** | `worker/index.test.ts` | Worker unit tests (mocked ASSETS, runs under root vitest) |
| **Create** | `public/homepage.html` | Static placeholder homepage (copied to `dist/` by Vite automatically) |
| **Modify** | `src/lib/frontier/session-store.ts` | Add `setAuthHint` / `clearAuthHint` helpers; wire into `writeEnvelope` |
| **Modify** | `src/lib/frontier/session-store.test.ts` | 3 new tests for hint cookie behavior |
| **Modify** | `src/hooks/useFrontierSession.tsx` | Clear hint on boot when no session (edge-case 2 mitigation) |
| **Modify** | `wrangler.toml` | Add `main`, update route to `aquilla.app/*`, add `[env.staging]` block |
| **Modify** | `auth-worker/wrangler.toml` | Update `BASE_URL` in all three vars blocks |
| **Modify** | `auth-worker/src/routes/auth.ts` | Update fallback default at line 300 |
| **Modify** | `.github/workflows/deploy.yml` | Update stale comment at line 117 (doc-only) |

---

## Deployment Phases

This plan is written as four deploy phases that map to the spec's zero-downtime migration sequence. Tasks 1–4 can be committed together but **must be deployed in order**:

- **Phase A** (after Tasks 1–4): Add `aquilla.app` route; Worker always serves SPA. Hint cookie starts propagating to signed-in users. No UX change.
- **Phase B** (after Task 5): Flip Worker to read `aq_hint`. Bare-domain routing is now live.
- **Phase C** (after Task 6): Update `BASE_URL` in auth-worker. New emails use `aquilla.app`.
- **Phase D** (after Task 7): Remove `web.aquilla.app` route. Hard cutover.

---

## Task 1: `aq_hint` cookie helpers in session-store

**Files:**
- Modify: `src/lib/frontier/session-store.ts`
- Modify: `src/lib/frontier/session-store.test.ts`

The existing `writeEnvelope` function is the single chokepoint for all IDB session mutations (login, logout, account switch). Add `setAuthHint` / `clearAuthHint` there so every code path is covered automatically.

- [ ] **Step 1.1: Write the failing tests**

Add this block at the bottom of `src/lib/frontier/session-store.test.ts`, after the existing `describe` blocks. The `clearSession` call in the existing `beforeEach` will call `writeEnvelope` with `active: null`, which clears the cookie before each test — no extra cleanup needed here.

```ts
describe("aq_hint cookie", () => {
  beforeEach(async () => {
    const { _resetDbForTesting } = await import("./session-store")
    await _resetDbForTesting()
    // Also clear any residual cookie
    document.cookie = "aq_hint=; Path=/; Max-Age=0"
  })

  function getHint(): string | null {
    const match = document.cookie.match(/(?:^|;\s*)aq_hint=([^;]*)/)
    return match ? match[1] : null
  }

  it("sets aq_hint=1 after saveSession", async () => {
    const { saveSession } = await import("./session-store")
    await saveSession({ jwt: "tok", username: "alice", createdAt: "2026-01-01T00:00:00Z" })
    expect(getHint()).toBe("1")
  })

  it("clears aq_hint after clearSession", async () => {
    const { saveSession, clearSession } = await import("./session-store")
    await saveSession({ jwt: "tok", username: "alice", createdAt: "2026-01-01T00:00:00Z" })
    expect(getHint()).toBe("1")
    await clearSession()
    expect(getHint()).toBeNull()
  })

  it("keeps aq_hint=1 when switching between two active sessions", async () => {
    const { addSession, activateSession, sessionKey } = await import("./session-store")
    const a = { jwt: "tok-a", username: "alice", createdAt: "2026-01-01T00:00:00Z" }
    const b = { jwt: "tok-b", username: "bob",   createdAt: "2026-01-01T00:00:00Z" }
    await addSession(a)
    await addSession(b)
    await activateSession(sessionKey(b))
    expect(getHint()).toBe("1")
  })
})
```

- [ ] **Step 1.2: Run tests and confirm they fail**

```bash
cd /Users/ryderwishart/prototypes/codex-web-app
npx vitest run src/lib/frontier/session-store.test.ts
```

Expected: the three new `aq_hint cookie` tests fail. Existing tests should still pass.

- [ ] **Step 1.3: Add helpers and wire into `writeEnvelope`**

In `src/lib/frontier/session-store.ts`, add the two helpers immediately before the `writeEnvelope` function and call them inside it:

```ts
// ---- auth-hint cookie ----
// A non-credential, host-only 1-bit cookie that the aquilla-web Worker reads
// at the edge to decide whether to serve the SPA or the homepage without
// waiting for IDB. No Domain attribute → cookie is scoped to whichever host
// (aquilla.app, dev.aquilla.app, localhost) wrote it, keeping envs isolated.
const HINT_COOKIE = "aq_hint"

function setAuthHint(): void {
  document.cookie = `${HINT_COOKIE}=1; Path=/; Max-Age=31536000; SameSite=Lax`
}

export function clearAuthHint(): void {
  document.cookie = `${HINT_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`
}
// --------------------------

async function writeEnvelope(env: Envelope): Promise<void> {
  const d = await db()
  await d.put(STORE, env, ENVELOPE_KEY)
  if (env.active != null) {
    setAuthHint()
  } else {
    clearAuthHint()
  }
  notify()
}
```

`clearAuthHint` is exported because `useFrontierSession` will call it on boot (Task 3).

- [ ] **Step 1.4: Run tests and confirm they pass**

```bash
npx vitest run src/lib/frontier/session-store.test.ts
```

Expected: all tests pass, including the three new `aq_hint cookie` tests.

- [ ] **Step 1.5: Commit**

```bash
git add src/lib/frontier/session-store.ts src/lib/frontier/session-store.test.ts
git commit -m "feat(session-store): write aq_hint cookie alongside IDB session writes"
```

---

## Task 2: `useFrontierSession` — clear hint on boot when no session

**Files:**
- Modify: `src/hooks/useFrontierSession.tsx`

Edge case 2 from the spec: if `aq_hint` is set but IDB was cleared (e.g. user cleared storage), the Worker serves the SPA, which on mount finds no session and navigates to `/onboarding`. Add an opportunistic hint-clear so the *next* cold visit goes straight to the homepage.

- [ ] **Step 2.1: Add the effect to `useFrontierSession`**

The hook already has access to `{ active, loading }` from `useAccounts`. When loading completes and `active` is null, clear the hint cookie. The import of `clearAuthHint` is the only new dependency.

Open `src/hooks/useFrontierSession.tsx`. Add the import and effect:

```ts
import { clearSession, clearAuthHint } from "@/lib/frontier/session-store"
```

(Replace the existing `import { clearSession } from ...` line.)

Then add a `useEffect` inside the `useFrontierSession` function, before the `return`:

```ts
  // Edge-case mitigation: if IDB is empty but aq_hint cookie was somehow
  // set (storage cleared, old cookie, first deploy), clear the hint so the
  // next cold visit to aquilla.app/ serves the homepage directly instead of
  // briefly flashing the empty app shell.
  useEffect(() => {
    if (!loading && active === null) {
      clearAuthHint()
    }
  }, [loading, active])
```

- [ ] **Step 2.2: Verify existing useFrontierSession tests still pass (or run all unit tests)**

```bash
npx vitest run src/
```

Expected: all passes. (There are no dedicated tests for the hook's boot behaviour; the effect is lightweight and covered by the session-store tests indirectly.)

- [ ] **Step 2.3: Commit**

```bash
git add src/hooks/useFrontierSession.tsx
git commit -m "feat(useFrontierSession): clear aq_hint on boot when IDB has no session"
```

---

## Task 3: `public/homepage.html` placeholder

**Files:**
- Create: `public/homepage.html`

Pure HTML/CSS — no React, no Vite imports. Vite copies everything in `public/` to `dist/` unchanged, so this ships automatically on the next build.

- [ ] **Step 3.1: Create the file**

Create `public/homepage.html` with the following content:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Aquilla</title>
  <meta name="description" content="Translation, lifted — the steering system your team can live in." />
  <link rel="icon" type="image/svg+xml" href="/favicon-aquilla.svg" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: oklch(0.985 0.002 264);
      color: oklch(0.27 0.008 264);
      min-height: 100dvh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 2rem;
      padding: 2rem;
    }

    .logo {
      display: flex;
      align-items: center;
      gap: 0.625rem;
    }

    .logo img {
      width: 2.5rem;
      height: 2.5rem;
    }

    .logo-name {
      font-size: 1.5rem;
      font-weight: 600;
      letter-spacing: -0.02em;
    }

    .tagline {
      font-size: 1.125rem;
      color: oklch(0.5 0.008 264);
      text-align: center;
      max-width: 28rem;
      line-height: 1.5;
    }

    .actions {
      display: flex;
      gap: 0.75rem;
      flex-wrap: wrap;
      justify-content: center;
    }

    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0.625rem 1.25rem;
      border-radius: 0.5rem;
      font-size: 0.9375rem;
      font-weight: 500;
      text-decoration: none;
      cursor: pointer;
      transition: opacity 0.15s;
    }

    .btn:hover { opacity: 0.8; }

    .btn-primary {
      background: oklch(0.27 0.008 264);
      color: oklch(0.985 0.002 264);
      border: none;
    }

    .btn-secondary {
      background: transparent;
      color: oklch(0.27 0.008 264);
      border: 1px solid oklch(0.8 0.005 264);
    }
  </style>
</head>
<body>
  <div class="logo">
    <img src="/favicon-aquilla.svg" alt="" aria-hidden="true" />
    <span class="logo-name">Aquilla</span>
  </div>

  <p class="tagline">Translation, lifted — the steering system your team can live in.</p>

  <div class="actions">
    <a href="/onboarding" class="btn btn-primary">Sign in</a>
    <a href="/onboarding" class="btn btn-secondary">Create account</a>
  </div>
</body>
</html>
```

- [ ] **Step 3.2: Verify it appears in the build output**

```bash
npm run build 2>&1 | tail -5
ls dist/homepage.html
```

Expected: `dist/homepage.html` exists.

- [ ] **Step 3.3: Commit**

```bash
git add public/homepage.html
git commit -m "feat(homepage): add static placeholder homepage for unsigned-out visitors"
```

---

## Task 4: `worker/index.ts` (passthrough) + Worker tests + `wrangler.toml` Phase A changes

**Files:**
- Create: `worker/index.ts`
- Create: `worker/index.test.ts`
- Modify: `wrangler.toml`

Phase A of the migration: introduce the Worker `main`, add `aquilla.app` route **alongside** `web.aquilla.app`, add the staging env. The Worker simply passes everything through (no hint-reading yet). This lets the `aq_hint` cookie propagate to signed-in users before the gate is enabled in Task 5.

- [ ] **Step 4.1: Write Worker tests (full final behaviour)**

The tests cover the *final* Worker logic (including hint check). We write them now against the full spec so that when Task 5 flips the switch, these tests pass immediately.

Create `worker/index.test.ts`:

```ts
import { describe, it, expect } from "vitest"

// Minimal mock for the ASSETS binding: returns a Response whose body is the
// resolved pathname so tests can assert which file was requested.
function makeEnv() {
  return {
    ASSETS: {
      fetch: async (req: Request | string): Promise<Response> => {
        const url = new URL(typeof req === "string" ? req : req.url)
        return new Response(`served:${url.pathname}`, {
          status: 200,
          headers: { "Content-Type": "text/html" },
        })
      },
    },
  }
}

// Dynamic import so tests can re-import after module resets if needed.
async function fetchWorker(path: string, cookie?: string) {
  const { default: worker } = await import("./index")
  const headers: HeadersInit = {}
  if (cookie) headers["Cookie"] = cookie
  const req = new Request(`https://aquilla.app${path}`, { headers })
  return worker.fetch(req, makeEnv())
}

describe("worker/index — routing", () => {
  it("GET / with no cookie serves homepage.html", async () => {
    const res = await fetchWorker("/")
    expect(await res.text()).toBe("served:/homepage.html")
  })

  it("GET / with aq_hint=1 cookie serves index.html", async () => {
    const res = await fetchWorker("/", "aq_hint=1")
    expect(await res.text()).toBe("served:/index.html")
  })

  it("GET / with unrelated cookie still serves homepage.html", async () => {
    const res = await fetchWorker("/", "session=abc123")
    expect(await res.text()).toBe("served:/homepage.html")
  })

  it("GET /homepage always serves homepage.html (no cookie)", async () => {
    const res = await fetchWorker("/homepage")
    expect(await res.text()).toBe("served:/homepage.html")
  })

  it("GET /homepage always serves homepage.html (even with aq_hint=1)", async () => {
    const res = await fetchWorker("/homepage", "aq_hint=1")
    expect(await res.text()).toBe("served:/homepage.html")
  })

  it("GET /project/abc passes through to ASSETS unchanged", async () => {
    const res = await fetchWorker("/project/abc")
    // Falls through to env.ASSETS.fetch(req) with original URL
    expect(await res.text()).toBe("served:/project/abc")
  })

  it("GET /join/xyz passes through to ASSETS unchanged", async () => {
    const res = await fetchWorker("/join/xyz")
    expect(await res.text()).toBe("served:/join/xyz")
  })

  it("GET /__dev/login passes through to ASSETS unchanged", async () => {
    const res = await fetchWorker("/__dev/login")
    expect(await res.text()).toBe("served:/__dev/login")
  })
})
```

- [ ] **Step 4.2: Run tests and confirm they fail**

```bash
npx vitest run worker/index.test.ts
```

Expected: all 8 tests fail — the module doesn't exist yet. You should see "Cannot find module './index'".

- [ ] **Step 4.3: Create `worker/index.ts` (passthrough version)**

Create `worker/index.ts`:

```ts
// aquilla-web Worker entry
//
// Phase A (initial deploy): this Worker is in passthrough mode — every
// request is forwarded directly to the static-asset binding. The aq_hint
// cookie check is enabled in Phase B (Task 5) once the hint has had time
// to propagate to existing signed-in users.
//
// See docs/superpowers/specs/2026-05-30-bare-domain-routing-design.md

// Use a structural type instead of `Fetcher` from @cloudflare/workers-types
// so this file compiles under the root tsconfig (which doesn't pull in
// workers-types) and so worker/index.test.ts can call fetch() with a plain
// mock without needing the full ExecutionContext.
export interface Env {
  ASSETS: { fetch(req: Request | string): Promise<Response> }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    // Phase A: unconditional passthrough — hint check not yet enabled.
    return env.ASSETS.fetch(req)
  },
}
```

- [ ] **Step 4.4: Run Worker tests — expect most to fail (passthrough doesn't honour hint)**

```bash
npx vitest run worker/index.test.ts
```

Expected: `GET /project/abc`, `/join/xyz`, `/__dev/login` pass. The `/` and `/homepage` tests fail because passthrough doesn't redirect to `homepage.html`. **This is intentional** — these tests will pass after Task 5.

- [ ] **Step 4.5: Update `wrangler.toml` — add `main`, add `aquilla.app` route, add staging env**

Open `wrangler.toml`. Make these four changes:

1. Add `main = "worker/index.ts"` after the `name` line (line 25 area):

```toml
name = "aquilla-web"
main = "worker/index.ts"
account_id = "6a80496d1e59948a9cbaa3c643ba81d7"
```

2. In the `[env.production]` block, add `aquilla.app/*` **alongside** the existing `web.aquilla.app/*` (keeping both routes during Phase A):

```toml
[env.production]
name = "aquilla-web"
account_id = "6a80496d1e59948a9cbaa3c643ba81d7"
workers_dev = true
routes = ["aquilla.app/*", "web.aquilla.app/*"]
```

3. Re-declare the assets binding under `[env.production]` (it's already there — leave it unchanged).

4. Add a new `[env.staging]` block at the end of the file:

```toml
# ---------------------------------------------------------------------------
# Staging environment — serves SPA at dev.aquilla.app/* with same hint-check
# logic as production. Uses same Worker code; assets deploy is separate.
# Deploy: wrangler deploy --env=staging
# ---------------------------------------------------------------------------
[env.staging]
name = "aquilla-web-staging"
account_id = "6a80496d1e59948a9cbaa3c643ba81d7"
workers_dev = true
routes = ["dev.aquilla.app/*"]

[env.staging.assets]
directory = "./dist"
not_found_handling = "single-page-application"
```

Also update the stale header comment at the top of the file (around L51) that says "attaches web.aquilla.app/* to this Worker" to reflect the new dual routes.

- [ ] **Step 4.6: Verify the build still compiles**

```bash
npm run build 2>&1 | tail -10
```

Expected: build completes with no errors. Vite does not compile `worker/index.ts` (it's not in the SPA's entry graph) — wrangler handles that separately.

- [ ] **Step 4.7: Commit Phase A changes**

```bash
git add worker/index.ts worker/index.test.ts wrangler.toml
git commit -m "feat(worker): add aquilla-web Worker entry (passthrough) + aquilla.app route (Phase A)"
```

> **⚠️ DEPLOY PHASE A NOW** before proceeding:
> ```bash
> npm run build && rm -f dist/_redirects && wrangler deploy --env=production
> ```
> This deploys the passthrough Worker at both `aquilla.app/*` and `web.aquilla.app/*`. The `aq_hint` cookie starts writing to signed-in users' browsers. No UX change — both domains serve the SPA as before.

---

## Task 5: Flip Worker to read `aq_hint` (Phase B)

**Files:**
- Modify: `worker/index.ts`

Enable the hint check now that the cookie has had time to propagate to existing signed-in users.

- [ ] **Step 5.1: Update `worker/index.ts` with the full hint-check logic**

Replace the contents of `worker/index.ts` with:

```ts
// aquilla-web Worker entry
//
// Routes requests on aquilla.app to either the SPA (index.html) or the
// static placeholder homepage (homepage.html) based on the presence of the
// aq_hint=1 cookie — a non-credential, host-only 1-bit cookie written by the
// SPA's session-store whenever there is an active IDB session.
//
// Request flow:
//   /homepage          → always serve homepage.html (bypass for QA / sharing)
//   /  (no aq_hint)   → serve homepage.html  (signed-out visitor)
//   /  (aq_hint=1)    → serve index.html      (signed-in user)
//   /* (anything else) → env.ASSETS.fetch(req) (SPA fallback, React Router handles it)
//
// See docs/superpowers/specs/2026-05-30-bare-domain-routing-design.md

// Structural type avoids a @cloudflare/workers-types dependency in tests.
export interface Env {
  ASSETS: { fetch(req: Request | string): Promise<Response> }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)

    // Bypass: always show the homepage regardless of hint state.
    if (url.pathname === "/homepage") {
      const target = new URL("/homepage.html", req.url)
      return env.ASSETS.fetch(new Request(target, req))
    }

    // Root: serve SPA or homepage based on the auth hint cookie.
    if (url.pathname === "/") {
      const cookie = req.headers.get("Cookie") ?? ""
      const signedIn = /(?:^|;\s*)aq_hint=1(?:;|$)/.test(cookie)
      const target = new URL(signedIn ? "/index.html" : "/homepage.html", req.url)
      return env.ASSETS.fetch(new Request(target, req))
    }

    // Everything else: hand off to the static-asset binding.
    // Workers `not_found_handling = "single-page-application"` rewrites
    // unknown paths to index.html — React Router handles the rest.
    return env.ASSETS.fetch(req)
  },
}
```

- [ ] **Step 5.2: Run Worker tests — all 8 should now pass**

```bash
npx vitest run worker/index.test.ts
```

Expected: all 8 tests pass.

- [ ] **Step 5.3: Run full unit test suite**

```bash
npx vitest run
```

Expected: all tests pass.

- [ ] **Step 5.4: Commit Phase B changes**

```bash
git add worker/index.ts
git commit -m "feat(worker): enable aq_hint-based routing at root (Phase B)"
```

> **⚠️ DEPLOY PHASE B NOW:**
> ```bash
> npm run build && rm -f dist/_redirects && wrangler deploy --env=production
> ```
> Bare-domain routing is now live. Both `aquilla.app/` and `web.aquilla.app/` run the hint check.

---

## Task 6: auth-worker BASE_URL updates (Phase C)

**Files:**
- Modify: `auth-worker/wrangler.toml`
- Modify: `auth-worker/src/routes/auth.ts`

New password-reset and invite emails should link to `aquilla.app`, not `web.aquilla.app`.

- [ ] **Step 6.1: Update `auth-worker/wrangler.toml`**

There are three `BASE_URL` entries. Change all of them:

**Top-level `[vars]` (around line 77):**
```toml
BASE_URL = "https://aquilla.app"
```

**`[env.production.vars]` (around line 107):**
```toml
BASE_URL = "https://aquilla.app"
```

**`[env.staging.vars]` (around line 136):**
```toml
BASE_URL = "https://dev.aquilla.app"
```

Also update the comment above the `[vars]` BASE_URL (around line 75) from "web.aquilla.app" to "aquilla.app":
```toml
# BASE_URL points at the SPA — used to construct password-reset / invite
# links sent in email. The apex aquilla.app is the canonical app domain.
```

- [ ] **Step 6.2: Update fallback in `auth-worker/src/routes/auth.ts:300`**

Find the line:
```ts
const baseUrl = c.env.BASE_URL || "https://web.aquilla.app"
```

Change it to:
```ts
const baseUrl = c.env.BASE_URL || "https://aquilla.app"
```

- [ ] **Step 6.3: Run auth-worker tests**

```bash
cd auth-worker && npm test
```

Expected: all tests pass. (The `BASE_URL` change is a string value, no logic changes.)

- [ ] **Step 6.4: Commit**

```bash
cd ..
git add auth-worker/wrangler.toml auth-worker/src/routes/auth.ts
git commit -m "fix(auth-worker): update BASE_URL to aquilla.app for email links"
```

> **⚠️ DEPLOY PHASE C NOW:**
> ```bash
> npm run deploy:aquilla:auth
> ```
> New password-reset and invite emails now use `https://aquilla.app/…` as their base URL.

---

## Task 7: Retire `web.aquilla.app` route (Phase D)

**Files:**
- Modify: `wrangler.toml`
- Modify: `.github/workflows/deploy.yml`

Remove the old `web.aquilla.app` route from the Worker and clean up stale comments.

> **Prerequisites before deploying this task:** Wait until it is safe to retire `web.aquilla.app`. For a pre-public app with no live email links, this can happen immediately. If there are any outstanding password-reset emails pointing to `web.aquilla.app`, wait until they expire (24h per auth-worker token TTL).

- [ ] **Step 7.1: Remove `web.aquilla.app/*` from `wrangler.toml`**

In `[env.production]`, change the `routes` line from:
```toml
routes = ["aquilla.app/*", "web.aquilla.app/*"]
```
to:
```toml
routes = ["aquilla.app/*"]
```

- [ ] **Step 7.2: Update stale comments in `wrangler.toml`**

At the top of the file (around lines 8–12), the comment mentions `web.aquilla.app`. Update it to reflect the new setup:

Find:
```toml
# Backend Workers (aquilla-identity, aquilla-sync-worker) are reached from
# the browser via Workers Routes on the api.aquilla.app subdomain (paths
# /identity/*, /sync/*, /chat/*). Cross-subdomain calls work because auth is
# bearer-token-only and both workers use `Access-Control-Allow-Origin: *`.
# No service bindings needed — the SPA fetch()es absolute URLs from
# VITE_AUTH_BASE / VITE_SYNC_WORKER_HOST / VITE_CHAT_BASE wired in deploy.yml.
```

Replace with:
```toml
# Backend Workers (aquilla-identity, aquilla-sync-worker) are reached from
# the browser via Workers Routes on the api.aquilla.app subdomain (paths
# /identity/*, /sync/*, /chat/*). Cross-subdomain calls work because auth is
# bearer-token-only and both workers use `Access-Control-Allow-Origin: *`.
# No service bindings needed — the SPA fetch()es absolute URLs from
# VITE_AUTH_BASE / VITE_SYNC_WORKER_HOST / VITE_CHAT_BASE wired in deploy.yml.
#
# aquilla.app is the canonical app domain. web.aquilla.app is retired.
# Signed-out visitors see public/homepage.html; signed-in users go straight
# to the SPA via the aq_hint cookie check in worker/index.ts.
```

Also update the `[env.production]` comment (around line 51) from "attaches web.aquilla.app/*" to "attaches aquilla.app/*".

- [ ] **Step 7.3: Update stale comment in `.github/workflows/deploy.yml:117`**

Find:
```yaml
          # the SPA (web.aquilla.app) and the marketing apex (aquilla.app).
```

Replace with:
```yaml
          # the SPA (aquilla.app — the canonical app domain, no web. prefix).
```

- [ ] **Step 7.4: Run full test suite one final time**

```bash
npx vitest run
```

Expected: all tests pass.

- [ ] **Step 7.5: Commit**

```bash
git add wrangler.toml .github/workflows/deploy.yml
git commit -m "chore(infra): retire web.aquilla.app route, clean up stale comments (Phase D)"
```

> **⚠️ DEPLOY PHASE D NOW:**
> ```bash
> npm run build && rm -f dist/_redirects && wrangler deploy --env=production
> ```
> The `web.aquilla.app/*` route is removed. `aquilla.app` is now the sole canonical domain. Hard cutover complete.

---

## Manual Smoke Test Checklist

After all four phases are deployed, verify in an incognito browser:

- [ ] `aquilla.app/` — shows the Aquilla placeholder homepage (logo + tagline + Sign in / Create account buttons)
- [ ] Click "Sign in" → lands on `/onboarding`, complete sign in → redirected to Dashboard
- [ ] Reload `aquilla.app/` → SPA loads directly (no homepage flash)
- [ ] Visit `aquilla.app/homepage` while signed in → shows homepage
- [ ] Visit `aquilla.app/project/<any-id>` → SPA loads the project route
- [ ] Visit `aquilla.app/join/<token>` → SPA loads the join page
- [ ] Sign out → reload `aquilla.app/` → homepage appears again
- [ ] `web.aquilla.app/` (after Phase D) → Cloudflare "Worker not found" or DNS error (not the app)
