# @aquilla/reset

Standalone password-reset app for Aquilla (AD-11). Mounted at `/reset/*`
per `routes.json`.

Two client-side routes within the same Vite SPA + Worker:

- `/reset/` — `RequestForm`. Email entry → POSTs
  `${VITE_AUTH_BASE}/api/v2/auth/password-reset/request`. Server
  always returns 2xx (no enumeration disclosure); UI shows
  "Check your email" regardless.
- `/reset/:token?username=…` — `SubmitForm`. New-password entry.
  Verifies the token via `/password-reset/verify`, then on submit POSTs
  to `/password-reset/reset` (the route is literally `/reset` on the
  auth-worker; the auth-client renames it to `submitPasswordReset`).
  On success hard-navigates to `/login/?reset=1`.

The reset email's link carries both `token` and `username` as query
params; we accept the token from either path or query for permissiveness
but always read `username` from the query string.

See `apps/login/README.md` for the shared dev/build/deploy/test
conventions — this app follows the same shape.
