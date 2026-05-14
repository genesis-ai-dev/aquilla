# @aquilla/signup

Standalone signup app for Aquilla (AD-11). Mounted at `/signup/*` per
`routes.json`.

Single React route. Collects `username` + `email` + `password` (with
confirmation), validates locally, then POSTs to
`${VITE_AUTH_BASE}/api/v2/auth/register` via `@aquilla/auth-client`. On
success the JWT lands in the parent-domain cookie and the user is
hard-navigated to `?return=<same-origin>` or `/projects`.

See `apps/login/README.md` for the shared dev/build/deploy/test
conventions — this app follows the same shape.
