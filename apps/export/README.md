# @aquilla/export

Standalone Cloudflare Worker app for exporting Aquilla translation projects back to their original file formats (AD-11; spec §21-monorepo.md).

Mounted under `/export` (see `routes.json` at the repo root). The Worker serves a Vite-built SPA via the Workers Assets binding plus the boot-time `assertEnvBindings()` guard from `@aquilla/errors`.

Planned outputs mirror the importer: USFM, DOCX, PPTX, Markdown, plaintext, VTT/SRT — reconstructed via the rebuilder pipeline so round-tripping a docx/pptx preserves non-translatable content.

**Phase 3d (current):** placeholder UI only. The real export flow — surgical rebuilders, format selection, packaging — is deferred until after Phase 2c-β rewrites the underlying parser + import pipeline.
