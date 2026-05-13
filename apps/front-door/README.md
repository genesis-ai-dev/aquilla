# @aquilla/front-door

Front-door Worker for the Aquilla monorepo (AD-11; spec §21-monorepo.md).

Cloudflare Workers Routes handles the real dispatch (`aquilla.app/<slug>/*` → `aquilla-<slug>`). The front-door is bound under the root and the 404 fallback only:

```
aquilla.app/*           → aquilla-front-door   (root + fallback only)
aquilla.app/<slug>/*    → aquilla-<slug>       (handled by Workers Routes directly)
```

## Behavior

- `GET /` ⇒ `302 → /projects` (the default landing app).
- `GET /__routes` ⇒ JSON dump of the `routes.json` registry. Debug aid; not authenticated.
- Anything else ⇒ `404` (Workers Routes' more-specific patterns claim every other path before it reaches the front-door).
- Every response gets a baseline CSP header injected.

## Build-time `routes.json`

The Worker imports `routes.json` at the repo root via Vite's JSON-module support — bundled into the deploy artifact rather than re-read at runtime. Adding a new app means editing `routes.json` and redeploying the front-door (cheap; the front-door has no per-app coupling beyond this list).
