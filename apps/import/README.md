# @aquilla/import

Standalone Cloudflare Worker app for importing source documents into an Aquilla project (AD-11; spec §21-monorepo.md).

Mounted under `/import` (see `routes.json` at the repo root). The Worker serves a Vite-built SPA via the Workers Assets binding plus the boot-time `assertEnvBindings()` guard from `@aquilla/errors`.

Planned formats: USFM, DOCX, PPTX, Markdown, plaintext, VTT/SRT.

**Phase 3d (current):** placeholder UI only. The real import flow — parsers, file ingestion, event emission — is deferred until after Phase 2c-β lands its parser + import-pipeline rewrite (parsers emit `source.cell.create` events directly).
