# Smart Extensions (prototype)

Status: **prototype**, branch `dadukhankevin/aquilla-tools-prototype`. Not deployed; migration
`0157_project_tools.sql` has not been applied to any shared database.

Smart Extensions are small, sandboxed apps that run inside a project: built from a prompt by
the builder model (Claude Opus 5.5 via OpenRouter), or installed from reviewed starters. An
extension can read and change anything its user can. Its writes are **ordinary events** through
the normal outbox → `POST /events` path (head CAS, `authorize()`), not changesets. The safety
net is **attribution + revert**, not per-edit review. In code an extension is a "tool"
(`ToolManifest`, `/api/v2/projects/:id/tools`, the tool frame); "Smart Extensions" is the
product name in the UI, routes (`/project/:id/extensions`) and i18n (`extensions.*`).

## Where extensions show up (manifest `mounts`)

| Mount | Surface | Context the extension gets |
| --- | --- | --- |
| `page` | `/project/:id/extensions/:toolId` | — |
| `panel` | the editor's left dock, "Smart Extensions" tab | — |
| `inline` | a tab in each cell's expansion panel | `aquilla.context.cell` |
| `editor` | **replaces the standard editor** for a file | `aquilla.context.file` |

Installed extensions surface where they are relevant, without visiting the management page:
the extensions bar above the file view (editor switcher, pinned extensions, palette button),
the palette (Ctrl/Cmd+Shift+E: use as this file's editor, open in side panel, open full page),
the dock tab and the cell expansion tab. The editor choice is remembered per user, project and
file (or project-wide); pins and the panel's open extension per user and project
(localStorage, like the dock tab). The management page is for install, grants, revoke,
activity, revert, copy and build.

## Architecture

```
SPA host (React)                                   sandboxed frame (opaque origin)
 ToolFrame ─ srcdoc = CSP meta + boot JSON + runtime + tool source
 useToolHost ── createBridgeHost ◀── postMessage {channel, type, requestId, method, params} ── runtime (window.aquilla)
   │  source === frame.contentWindow, origin "null"         ──▶ {result | event}
   │  method → scope → standing grant / inline prompt / role ceiling
   ├─ LiveToolData: reads via sync-worker (cells, files, concepts);
   │   writes via typed emitters → IndexedDB outbox, payload.tool_origin
   └─ live push: outbox flush acks + project WebSocket (project-applied-bus) → cells.changed
auth-worker  /api/v2/projects/:id/tools*  store, versions, grants, activity, copy, build (Opus)
sync-worker  events route → verifies tool_origin against project_tool_versions → events.provenance
Postgres     project_tools / project_tool_versions (source, manifest, sha256, api_rev) / project_tool_grants
```

- **Sandbox.** `<iframe sandbox="allow-scripts allow-forms" srcdoc>` — never `allow-same-origin`,
  so the frame has an opaque origin: no cookies, no app storage, no app DOM. CSP:
  `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:;
  connect-src 'none'; form-action 'none'; base-uri 'none'`. `allow-forms` only makes `submit`
  events fire (Chrome drops them otherwise — the first real build hit this); `form-action 'none'`
  still blocks submission. Theme arrives as CSS variables.
- **Bridge.** `src/lib/tools/runtime-source.ts` is a source string (tests evaluate the exact
  bytes that ship). Boot data is embedded with `embedJson` (escapes `<`, `>`, `&`, U+2028/9).
  The host validates `event.source` and origin; the runtime only accepts its parent.
  Surfaces (apiRev 1): `files.list`, `cells.list`, `terms.list`, `cells.commit`, `cells.validate`,
  `storage.get/set/remove`, `permissions.request/list`, `ui.notify`, `tell`, `ai.generate`,
  `on("cells.changed")`. Added in apiRev 2 (additive only — rev-1 extensions run unchanged):
  `cells.page` / `cells.get` (server-paged and targeted reads), rich-text fields on every cell
  (`sourceHtml`, `targetHtml`, `type`, `lastEditor`, `lastEditAt`, `aiDrafted`) and an optional
  `html` per `cells.commit` edit (sanitized by the host to the editor's inline allowlist in
  both directions), `cells.unvalidate`, `presence.list/claim/release` + `presence.changed`,
  `comments.counts/open` + `comments.changed` (new scope `read:comments`), `audio.list/play/stop`
  (playback happens in the host — the frame has no network), `ui.hostKey` + automatic
  forwarding of the app's own shortcuts (`boot.hostShortcuts`; the host replays only its
  allowlist), and `editor.reveal` (+ `context.file.revealCellId`) for deep links.
  A tool never supplies a parent id: the host chains on the live head.
- **Permissions.** Scopes `read:cells`, `read:terms`, `write:target`, `write:validation`,
  `ai:generate`. Install approves a standing grant (reads pre-checked, writes ask on first use);
  an ungranted call pauses on "Allow <Extension> to <scope>? Deny / Allow / Always".
  Grants never exceed the user's role (client mirror of the role policy); the server's
  `authorize()` still checks every event. Revoke on the management page.
- **Attribution & revert.** Writes carry `payload.tool_origin = {origin:"tool", toolId, version,
  codeHash}`; the sync-worker stamps `events.provenance` with `verified` = that exact
  (project, tool, version, hash) exists. The activity read lists them; "Revert everything since
  then" emits compensating commits restoring each cell's value from before the extension's first
  write in the window, **skipping and listing** cells someone else edited since
  (`shared/tools/revert.ts`).
- **Builder.** `build_tool` / `edit_tool` = `POST /tools/build` (one model call; base present =
  edit). Gates: parse → manifest → lint (banned globals, size) server-side, then a **client-side
  smoke render** in a hidden sandboxed frame against a stub bridge (empty, then populated + a
  live push); any failure goes back to the model, ≤2 repairs. Generated code never executes in
  auth-worker or sync-worker. "Change it" (full page), "Heal it" (runtime error banner) and
  "Rebuild it" (stale API) all run edit_tool and save a new version.
- **API revisions.** `TOOLS_API_REV` + `shared/tools/api-rev.ts`: removed calls keep a runtime
  stub; the host answers `api_removed` with the replacement and offers "Rebuild it".
- **Sharing.** Copy to another project = an owned copy (`origin copy`, `upstream_tool_id`, same
  hash, no grants) with a code-review stub.
- **Capability twins.** `capability-contract.test.ts` keeps runtime, handlers, permission map,
  smoke stub and builder prompt in agreement.

## The default editor is an extension

The standard translation editor ships as a **first-party extension**, "Aquilla Editor"
(`shared/tools/first-party/default-editor*.ts`), and is the default editor for every file. It
runs exactly like any other extension — the same sandboxed frame, CSP, bridge, permission gate
and event path, with tool provenance on every write — so it doubles as the proof that the
extension API can carry the whole editing experience. Nothing privileged: it reaches the
workspace's live focus locks and comment panels only through the apiRev 2 bridge calls above,
which any `editor` extension gets.

- **Install.** The SERVER installs it (`POST /tools/first-party {key:"default-editor"}`) from
  the repo's reviewed source — a client cannot choose the bytes. Idempotent via a deterministic
  per-project tool id (no schema change). Upgraded in place to the shipped code only while the
  current version is pristine (a project's "Change it" edit is left alone). Removing it on the
  management page keeps it removed (the built-in editor becomes the default again).
- **Grants — explicit and visible.** Its declared scopes (`read:cells`, `write:target`,
  `write:validation`, `read:comments`) are auto-granted to each user the first time only; a
  later revoke sticks. The editor bar says so ("…granted these permissions automatically…",
  with a Manage link), the switcher labels it "(default)", and its card on the management page
  carries a "First-party · auto-granted at install" badge. Role ceilings and the server's
  `authorize()` apply as for any extension.
- **Fallback.** The built-in editor stays one switch away ("Standard editor" in the editor
  switcher; remembered per file or project-wide). The client waits for the project's
  extensions before choosing, so the built-in never flashes first.
- **Off switch.** `localStorage["aquilla.extensions.defaultEditor"]="off"` (per browser) or
  build env `VITE_EXTENSION_DEFAULT_EDITOR=off`. The e2e stack builds with it off so the
  editor smoke journeys keep guarding the built-in editor; the extension-editor specs opt in.

**Parity.** `docs/SMART-EXTENSIONS-PARITY.md` is the feature-by-feature matrix against the
built-in editor (EditorTable + TranslatedEditor + the workspace around them). In short: an
`editor` mount gets the workspace's **editor services** (apiRev 3, `src/lib/tools/editor-services.ts`,
assembled by `useExtensionEditorServices`). The extension reads the workspace's own cell store
(the file is read once, not twice) and writes through the host's own commit/validate pipeline
(auto-validate own edit, repetition propagation on `cells.settle`), attributed via `tool_origin`.
Host-owned features (AI drafting with credits and evidence, back-translation, rules/health,
key terms, TTS, the recorder, the history/comments/attachments drawers, the bulk selection bar)
are reached as bridge calls or host panels. The extension takes EditorTable's place inside
the same workspace layout, so the media lens's timeline and video, the footnote tray and the
file toolbar (drawn by the host over the frame's chapter row, `editor.chrome`) are the host's
own. The frame matches the app's tokens, light/dark, breakpoints (from the app viewport), font
(sent as bytes) and strings (`ui.strings`, the user's locale).

Added in apiRev 3 (additive): `editor.config/setLane/setLens/openSettings/visible`,
`cells.sections/signals/pericopes/settle`, `terms.matches/open`, `ai.draft/draftParagraph`
(scope `ai:draft`), `backtranslation.list/run/save`, `history.open`, `attachments.open`,
`rules.open`, `presence.peers/typing/view`, `audio.record/generate` (scope `write:audio`),
`selection.set`, `suggestions.get/feedback` (a host-side ghost-text provider registry,
`src/lib/tools/suggestions.ts`: PR #1295's forecaster registers there; translation memory ships
as the first provider) and `ui.strings`. Events: `signals.changed`, `presence.peers`,
`selection.changed`, `config.changed`, `backtranslation.changed`, `pericopes.changed`,
`cells.structure`, `cells.loaded`, `editor.chrome`, `fonts`.

Revert now also **puts back validations an extension withdrew** (`revalidates` in
`shared/tools/revert.ts`): only the reverting user's own, and only while the text they
validated is still the live head.

## Prototype-only vs production follow-ups

- **Origin.** Prototype uses srcdoc + meta CSP. Production: serve frames from a dedicated
  origin (`tools.aquilla.app`) with the CSP as a header; add it to `frame-src` in
  `public/_headers`, `worker/security-headers.ts` and the Tauri CSP; srcdoc becomes `src=`.
- **Provenance trust.** `tool_origin` is caller-declared and verified against stored hashes;
  production should mint a per-frame tool session token server-side so a page script cannot
  claim a tool identity.
- **Builds** are synchronous (≈1–2 min) with a progress card; move to background jobs.
- **Activity read** lives in auth-worker reading `events`; move behind a sync-worker route.
- **Storage** (`aquilla.storage`) is per-browser localStorage; move server-side per tool/user.
- **Not built:** revertible settings/comment writes with saved prior values (bridge has no
  settings/comment writes yet), handing `tell()` to the in-app agent (it is a user-facing
  message today), a Checking View starter (the Focus Editor covers verse-by-verse checking),
  pulling upstream versions into copies, i18n catalogs beyond English.

## Tests

- Unit: `src/lib/tools/__tests__/` (bridge trust + round trips against the shipped runtime,
  embedJson/srcdoc, permissions, builder gates + repair loop + every starter's smoke, editor
  choice, capability twins), `shared/tools/revert.test.ts`.
- Workers: `auth-worker/src/__tests__/tools-routes.test.ts`, `tools-builder.test.ts`;
  `sync-worker/src/__tests__/tool-provenance.test.ts`.
- E2E: `e2e/specs/tools/tools-heatmap.spec.ts`, `e2e/specs/tools/extension-editor.spec.ts`,
  `e2e/specs/tools/default-editor-extension.spec.ts` (first-party default editor: edit, rich
  text, validate, a second user's lock + live edit, switch to built-in and back, revert since T),
  `e2e/specs/tools/default-editor-perf.spec.ts` (full gospel, extension vs built-in; reports).
- Unit (apiRev 2): `api-rev2.test.ts`, `live-data-rev2.test.ts`, `default-editor.test.ts`;
  auth-worker `tools-routes.test.ts` "first-party extensions".
- Unit (apiRev 3): `api-rev3.test.ts` (store-backed reads, host pipeline delegation with
  provenance, bound-file refusal, param validation, scopes, runtime round trips, ui.strings,
  suggestion registry); `shared/tools/revert.test.ts` (re-validation).
- E2E (apiRev 3): `e2e/specs/tools/default-editor-parity.spec.ts`; the core editor journeys run
  against the extension editor with `E2E_EDITOR=extension` (`pnpm test:e2e:extension-editor`,
  `e2e/helpers/editor-mode.ts`: the Workspace page object targets the extension's frame).
- Recordings: `e2e/recordings/specs/aquilla-tools.showcase.ts` (real build),
  `extension-editor.showcase.ts`, `extension-editor-build.showcase.ts` (real build),
  `default-editor-extension.showcase.ts`.
