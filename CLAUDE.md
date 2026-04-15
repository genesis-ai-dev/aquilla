# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Context

This is a **browser-based re-implementation** of the Codex translation editor (originally a VS Code extension — see `docs/SPEC.md` for the ancestor design). It is a local-first, file-backed translation notebook: translators import source documents, work cell-by-cell in paired source/target panes with LLM assistance, and export back to the original format. There is no backend — all state lives in the browser (IndexedDB + Y.Docs) and peer-to-peer sync happens over WebRTC.

## Commands

```bash
npm run dev         # Vite dev server
npm run build       # tsc -b && vite build (type-check THEN bundle)
npm run lint        # eslint .
npm run test        # vitest run (single pass)
npm run test:watch  # vitest watch mode
npm run preview     # preview built output
```

Run a single test file: `npx vitest run src/lib/rules/rule-engine.test.ts`
Run tests matching a name: `npx vitest run -t "validates cell"`

The test environment is `happy-dom` with `fake-indexeddb/auto` preloaded via `src/test-setup.ts` — tests can freely call the IndexedDB helpers without stubbing. Always call `_resetDbForTesting()` from `src/lib/store/project-index.ts` in `beforeEach` for tests that touch the shared DB.

TypeScript is configured with `noUnusedLocals`, `noUnusedParameters`, `erasableSyntaxOnly`, and `verbatimModuleSyntax` — imports of types must use `import type`, and enums/namespaces won't compile. `@/*` is aliased to `./src/*` in both `tsconfig.app.json` and `vite.config.ts`.

## High-Level Architecture

### Two-tier persistence

The app has **two separate storage surfaces**, and understanding which lives where is the single most important thing when editing this codebase:

1. **Project metadata → plain IndexedDB** via `idb` in `src/lib/store/project-index.ts`.
   - Stores: `projects` (ProjectRecord), `originals` (raw ArrayBuffer for docx/pptx re-export), `snapshots`, `shares`.
   - DB name: `codex`. Version bumps require an `upgrade` branch — see existing branches for the pattern (currently v3).
   - `ProjectRecord` holds `files: FileReference[]` — just IDs, names, types; the actual cell content is NOT here.

2. **Per-file content → one Y.Doc per file**, persisted through `y-indexeddb` under the key `codex:file:{fileId}`. Created/loaded via `createFileDoc` / `loadFileDoc` / `destroyFileDoc` in `src/lib/store/file-doc.ts`.
   - Each Y.Doc has three top-level shared types:
     - `meta` (Y.Map) — fileId, fileName, fileType, sourceLanguage, targetLanguage
     - `cells` (Y.Map keyed by cellId) — each value is a Y.Map
     - `order` (Y.Array of cellId strings) — authoritative cell order
   - Each cell Y.Map contains: `id`, `original`, `originalHtml?`, **`translatedXml` (Y.XmlFragment)**, `context`, `group`, `type`, `history` (Y.Array), `threads?` (Y.Array), `sourceLocation?`, `backtranslation?`.

The `translatedXml` Y.XmlFragment is critical: it's bound directly to a TipTap editor via `@tiptap/extension-collaboration` (see `TranslatedEditor.tsx`). Never write translated text with a plain string setter — use `setPlainText(frag, text)` / `getPlainText(frag)` from `src/lib/richtext/translated-xml.ts`. Legacy `cell.set("translated", ...)` fallbacks exist for pre-Milestone-9 docs but should not be used in new code.

### Document lifecycle

1. `importFile` (`src/lib/import.ts`) dispatches to a parser in `src/lib/parsers/*.ts`, produces `TranslatableString[]`, and calls `createFileDoc` to materialize a Y.Doc. For `docx`/`pptx`, the raw ArrayBuffer is also saved to the `originals` store so `surgicalExport` can re-patch the original XML.
2. `useFileDoc(fileId)` waits on `IndexeddbPersistence.synced` and hands back the Y.Doc.
3. `useCells(doc)` observes `cells` + `order` and produces a flat `CellData[]` for rendering. Cell `status` is derived from `translated` + `history` (`empty` / `unvalidated` / `validated` — validated means the last history entry is `validated: true`).
4. Mutations go through `appendCellHistory` / `validateCell` (in `src/hooks/useCellHistory.ts`) which ALWAYS run inside `doc.transact()` and update both `translatedXml` and the `history` array atomically.
5. `exportFile` (`src/lib/export/export-service.ts`) reconstructs the target file by dispatching on `fileType`. For docx/pptx with source locations, it uses `surgicalExport` to replace runs in the original zip's XML by `blockPath`; otherwise it falls back to a text rebuilder in `src/lib/export/rebuilders/`.

### LLM completion and few-shot retrieval

`useCompletion` (`src/hooks/useCompletion.ts`) drives both single and batch (3-worker) completion:
1. Tokenize the source → use `SearchIndex` (`src/lib/search/search-index.ts`) to find up to 5 high-scoring `(source, target)` pairs from already-translated cells (TF-IDF-weighted, with query-residual re-searching to maximize coverage).
2. Build a chat prompt with those pairs as few-shot examples.
3. POST to an OpenAI-compatible `{endpoint}/v1/chat/completions`. Streaming is preferred and writes back to `translatedXml` chunk-by-chunk via `setPlainText` so users see the translation type in.
4. On completion, append a history entry with `source: "llm"`, `validated: false`, and the `cellId`s of the examples used — this is what the health engine consumes.

### Health and rules

`computeHealthMap` (`src/lib/health/health-engine.ts`) is the single source of truth for `cellId → 0-100`:
- `validated` cells = 100.
- `unvalidated` (LLM-generated) cells = mean health of the example cells referenced in their last history entry, multiplied by `llmHealthPenalty` (default 0.9). Examples are ALWAYS already-computed because cells are processed in `order` and LLM examples reference earlier cells.
- Rule infractions (`src/lib/rules/rule-engine.ts`) subtract per-severity penalties (`major` default 15, `minor` default 5) from the cell health.
- File / project health are simple averages of non-empty cell healths.

Rules are regex-based (`target-forbids`, `source-requires-target`, `source-target-match`) and live on `ProjectRecord.rules`. Invalid regex is silently skipped.

### P2P sync (Milestone 10)

Sync is entirely peer-to-peer — no content ever hits a server.

- `createSyncProvider` (`src/lib/sync/webrtc-provider.ts`) wraps `y-webrtc` with public signaling + STUN + a free openrelay TURN fallback.
- Room naming is strictly scoped: `codex:share:{token}:file:{fileId}` for each file's doc, plus `codex:share:{token}:bootstrap` for the one-shot handshake.
- Share tokens (`src/lib/sync/share-tokens.ts`) are 8 URL-safe chars; optional 6-digit PINs are SHA-256-hashed with the token as salt. The hash travels peer-to-peer in awareness state — never to the signaling server.
- The **bootstrap handshake** (`src/lib/sync/bootstrap.ts`) is a separate ephemeral Y.Doc. The host publishes awareness `role: "host"` and watches for joiners with `role: "joiner", needsBootstrap: true`. On PIN match the host writes a `BootstrapMessage` (containing `ProjectRecord` + `fileIds`) keyed by the joiner's `clientID` into the bootstrap map. The joiner then creates its local project record and connects each file's sync room, where normal Yjs sync takes over.
- `useSync` (`src/hooks/useSync.ts`) manages provider lifetime for a single file doc and exposes awareness-derived `PeerState[]`. `ProjectWorkspace` also starts a long-lived `startBootstrapHost` for the active share token so joiners can land at any time.

### Snapshots

`src/lib/store/snapshots.ts` captures a `ProjectSnapshot` by calling `Y.encodeStateAsUpdate` on each file's doc and base64-encoding the result alongside a deep-cloned `ProjectRecord`. Restoration clears `y-indexeddb` data, applies the update to a fresh doc, then re-persists. `schemaVersion: 2` gates pre-M9 snapshots from being restored (their cell shape predates `translatedXml`) — if you introduce another incompatible schema change, bump this version and branch on it in `restoreSnapshot`. Restoration always creates a safety auto-snapshot first.

## Routing and component layers

- `src/main.tsx` → `BrowserRouter` → `src/App.tsx` defines every route. `/debug` variants exist at most paths and dump IndexedDB state as JSON via `DebugView` — use them when investigating data issues.
- `ProjectWorkspace.tsx` is the main editor surface; it composes the hooks (`useFileDoc`, `useCells`, `useCompletion`, `useHealth`, `useRules`, `useComments`, `useSync`, `useWorkspaceSearch`, `useBacktranslation`) and renders `Toolbar` + `ProjectSidebar` + `EditorTable` + drawers.
- `EditorTable.tsx` uses `@tanstack/react-virtual` for row virtualization. `TranslatedEditor.tsx` is a TipTap editor bound to `cell.translatedXml` via `Collaboration.configure({ fragment })` — when switching cells, the `fragment` prop dependency re-initializes the editor.
- UI primitives in `src/components/ui/` are shadcn-generated (`components.json`, style `base-nova`, neutral base color). Use `cn()` from `@/lib/utils` for conditional classes.

## Conventions

- **Tests are colocated** (`foo.ts` + `foo.test.ts` in the same directory). New library code should be TDD'd — every `src/lib/**/*.ts` has a matching test.
- **All Yjs mutations that touch multiple shared types must be wrapped in `doc.transact(() => { ... })`** so awareness observers fire once and sync messages batch correctly.
- When reading a cell's translated text, always go through `getPlainText(cell.get("translatedXml"))` with a legacy fallback to `cell.get("translated")`. The helpers `extractCellTranslated` (in file-doc.ts) and the body of `useCells` show the canonical pattern.
- IndexedDB version bumps: add a new branch inside the `upgrade` callback in `getDb()` guarded by `oldVersion < N` — never mutate existing branches.
- When adding a new file type, you need four things: a parser in `src/lib/parsers/`, a rebuilder in `src/lib/export/rebuilders/` (or surgical-export support), an entry in the `FileType` union and `detectFileType` map, and a MIME entry in `export-service.ts`.

## Design docs

Milestone-driven development is documented in `docs/superpowers/specs/*.md` (design) and `docs/superpowers/plans/*.md` (implementation plans). When adding a major feature, consult the most recent spec for conventions — in particular, Milestone 9 (rich text) and Milestone 10 (P2P sync) are load-bearing for any change to cell data or collaboration.
