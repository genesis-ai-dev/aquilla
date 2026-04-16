
Here is a concise, high-level picture of how the Codex Translation Editor fits together, based on the extension entry flow, `CodexCellEditorProvider`, the webview, and project/navigation code.

## What the app is

Codex is a **VS Code extension** whose main job is to host a **scripture-aligned translation workspace**: paired **source** and **target** content in a **cell-based notebook** (`.codex`), with **rich text (Quill/HTML)**, **audio**, **video timelines**, and **LLM-assisted drafting** (completion, batch translation, back-translation, etc.). The “harness” idea is accurate: the UI and file model keep **source and target aligned by cell**, persist edits and metadata, and feed **structured context** to models and validators.

---

## Layers

1. **Extension host (`src/`)**  
   Node side: registers commands, **custom editor** for `.codex`, sidebar **webviews** (navigation, main menu, comments, parallel passages), **project lifecycle** (`projectManager/`), **sync**, **SQLite-backed search index**, audio tooling (FFmpeg), and **smart edits / LLM** calls. Activation wires SQLite (native or WASM `fts5-sql-bundle`), tools, and providers in `extension.ts`.

2. **Webviews (`webviews/codex-webviews/src/`)**  
   Separate Vite-built React apps per surface. **`CodexCellEditor`** is the main translation UI; it talks to the host only via **`postMessage`** (typed in `types/index.d.ts`).

3. **Shared types and utils**  
   `types/index.d.ts` is the contract between host and webviews; `sharedUtils` holds logic used on both sides (e.g. progress/validation helpers).

---

## Core editor: provider + webview

- **`CodexCellEditorProvider`** implements `vscode.CustomEditorProvider<CodexCellDocument>`. It owns **webview panels**, **document lifecycle**, **queues** for AI translation and validation, **revision** tagging to avoid stale UI updates, and routing of **all webview messages** (via `codexCellEditorMessagehandling.ts`). It also ties into **sync**, **state store** (e.g. current cell id for cross-webview behavior), and **LLM completion** helpers.

- **`CodexCellDocument`** is the in-memory model of a `.codex` notebook: JSON notebook shape, **edit map** / history, **milestones**, **dirty cell tracking**, and hooks to **SQLite index manager** so saved cell text is reflected in **FTS search**. Persistence is **notebook JSON on disk** (with safe save utilities), not “the whole project in SQLite.”

- **`CodexCellEditor` (React)** renders the chapter/cell list, **Quill** editors, **source** display (context), audio/video components, floating search, unsaved-state handling, etc. It uses hooks like `useVSCodeMessageHandler` to mirror the host protocol.

So: **provider = authority for files, indexing, AI, and VS Code integration**; **webview = presentation and local UX**.

---

## User journey (simplified)

1. **Startup / onboarding**  
   Welcome + **Startup Flow** (commands registered from `extension.ts`) handle auth-aware project creation or clone, guided setup, and coordination with **project metadata** and git (see `projectUtils` / `initializeProjectMetadataAndGit`).

2. **Project initialization**  
   `initializeProject` in `projectInitializers.ts` runs in a workspace context: it creates **notebooks**, **comment files**, can **split USFM/source by book**, and related setup (fonts, etc. are also handled from this area). The **source of truth for project config** is **`metadata.json`** at the workspace root (languages, display names, importer settings, etc., evolved over time via migrations).

3. **SQLite**  
   On activation, the extension ensures a **SQLite runtime** (native binary or WASM) for tooling that needs it. The **search/indexing** path uses a **global `SQLiteIndexManager`** (`sqliteIndexManager.ts`) to maintain an **FTS index** of cell content; `CodexCellDocument` syncs **dirty cells** into that index on save. That is distinct from older project-local dictionary files (noted as removed in `fileUtils.ts` comments).

4. **Main menu**  
   **`MainMenuProvider`** is a sidebar webview (`codex-editor.mainMenu`) for **project-level settings** and actions (including reopening Startup Flow, sync-related behavior, etc.).

5. **Navigation**  
   **`NavigationWebviewProvider`** builds a **book/file tree** from project metadata and scans the workspace, shows progress-style info, and on **`openFile`** resolves paths and opens the **codex** document with the **custom editor**, while also trying to open the **corresponding source** file so translators see **source + target** together (`getCorrespondingSourceUri`, basename pairing in the handler around the `openFile` command).

6. **Editing**  
   Opening a `.codex` file loads **`CodexCellDocument`**, spins the **CodexCellEditor** webview, and then a **message loop** drives: load/save, scroll-to-cell, AI completions, validation, audio merge/attach, comments counts, milestone refresh, etc.

7. **AI / “few-shot” alignment**  
   The host pulls **completion config** and uses **`llmCompletion`**, **translation queues**, and **`smartEdits`** (e.g. chat-style completions via configured LLM endpoint from the Frontier/auth API in `smartEdits/chat.ts`). The **notebook structure** (source cells, prior target cells, milestones) is what supplies **context** to the model—not a separate “prompt IDE,” but the same aligned cells and metadata.

---

## How to think about a future web app

You would need to **replace** the VS Code shell (workspace, custom editor, webview bridge, some native tooling) with a **browser app + backend or OPFS**, but **preserve**:

- The **`.codex` / metadata** document model and pairing with **source** files.
- The **provider ↔ React** responsibility split (today: `CodexCellEditorProvider` + `CodexCellEditor`; tomorrow: API + same or extracted UI).
- **Search/indexing** (SQLite or another index) and **sync** story.
- **Multimodal cells**: Quill HTML, attachments, audio/video pipelines.

That is the high-level map: a **file-backed translation notebook** with **paired source**, **sidebar navigation and settings webviews**, **extension-hosted intelligence and persistence**, and a **React cell editor** as the primary surface for aligned, LLM-assisted translation work.
---

## Desktop target (Tauri)

The same React/Vite source tree builds for two targets:
- Web → Cloudflare Pages (`npm run build` → `dist/` → `npm run deploy`)
- Desktop → Tauri 2.x (`npm run tauri:build` → signed platform binaries)

A small `FsProvider` indirection (`src/lib/fs/`) routes git working-tree I/O to OPFS in the browser and to a Rust IPC bridge (`src-tauri/src/fs_bridge.rs`) on desktop. Implementation details and the multi-phase rollout plan live in `docs/superpowers/plans/2026-04-16-tauri-desktop-shell.md`.

### Release secrets (GitHub repo settings)

Required by `.github/workflows/tauri-release.yml`:

- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` — notarization (Apple Developer portal → app-specific password)
- `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY` — Developer ID Application cert exported as base64 .p12
- `WINDOWS_CERTIFICATE`, `WINDOWS_CERTIFICATE_PASSWORD` — code-signing cert as base64 .pfx
- `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — generated via `npx tauri signer generate`; store private key in 1Password and paste public key into `src-tauri/tauri.conf.json` under `plugins.updater.pubkey`
