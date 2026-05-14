# @aquilla/auth-client

Auth API wrapper + parent-domain JWT cookie reader for the Aquilla
monorepo (AD-5 / AD-11).

## What's in it

```ts
import {
  login,
  signup,
  requestPasswordReset,
  submitPasswordReset,
  verifyPasswordResetToken,
  logout,
  currentJwt,
  AuthClientError,
  COOKIE_NAME,
} from "@aquilla/auth-client"
```

All of `login`, `signup`, `submitPasswordReset` write the JWT to a cookie
scoped to the parent domain (see `src/cookie.ts` for the derivation
table). Every other app on the same parent domain reads the cookie via
`currentJwt()` / `getJwt()`. The login app is the only writer; the
workspace SPA and other apps are readers.

`requestPasswordReset` POSTs to the password-reset endpoint and resolves
on any 2xx (the server always returns 2xx so we don't leak whether the
email is registered).

`AuthClientError` carries `{status, body, detail}`. `error.message` is
populated from `detail.detail || detail.error || detail.message` so
callers can surface the server's intended copy verbatim.

## Base URL

`AUTH_BASE` reads `import.meta.env.VITE_AUTH_BASE`, falling back to the
current production aquilla-frontier-server host. Each consuming app sets its
own `VITE_AUTH_BASE` at build time (see each app's `wrangler.toml`
`[vars]`). The auth-worker is being renamed `aquilla-frontier-server` in
Phase 3e; consumers don't need to care — they go through the env var.

## Cookie behavior

- Name: `aquilla_jwt`
- `SameSite=Lax`, `Secure` on https origins
- Domain attribute derived from `window.location.hostname`:
  - `localhost` / single-label / IP → no Domain (host-only)
  - `pr-N.aquilla.app` / `dev.aquilla.app` → `.aquilla.app`
  - `*.aquilla-web-4ih.pages.dev` → `.aquilla-web-4ih.pages.dev`
- Max-Age: 30 days

**HttpOnly:** we *cannot* set HttpOnly via `document.cookie`; the
intended end state is for the auth-worker to return Set-Cookie with
HttpOnly itself. Until that lands, the SPA writes the cookie client-side
because the auth apps need to read it back for subsequent fetch calls.

## Tests

```bash
pnpm --filter @aquilla/auth-client test
```
