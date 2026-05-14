# @aquilla/migrate

Standalone Cloudflare Worker app for the one-time legacy migration tool (AD-11; spec §21-monorepo.md, AD-7 GitLab phase-out).

Mounted under `/migrate` (see `routes.json` at the repo root). The Worker serves a Vite-built SPA via the Workers Assets binding plus the boot-time `assertEnvBindings()` guard from `@aquilla/errors`.

Once running, this app surfaces a one-time migration flow for translators with legacy GitLab-backed projects, then becomes inert once migrations close.

**Phase 3d (current):** placeholder UI only. The real GitLab pull, project conversion, and `source.cell.create` event emission are deferred until after Phase 2c-β.
