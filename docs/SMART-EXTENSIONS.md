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
  Surfaces: `files.list`, `cells.list`, `terms.list`, `cells.commit`, `cells.validate`,
  `storage.get/set/remove`, `permissions.request/list`, `ui.notify`, `tell`, `ai.generate`,
  `on("cells.changed")`. A tool never supplies a parent id: the host chains on the live head.
- **Permissions.** Scopes `read:cells`, `read:terms`, `write:target`, `write:validation`,
  `ai:generate`. Install approves a standing grant (reads pre-checked, writes ask on first use);
  an ungranted call pauses on "<Extension> wants to <scope>. Allow once / Always allow / Deny".
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
- E2E: `e2e/specs/tools/tools-heatmap.spec.ts`, `e2e/specs/tools/extension-editor.spec.ts`.
- Recordings: `e2e/recordings/specs/aquilla-tools.showcase.ts` (real build),
  `extension-editor.showcase.ts`, `extension-editor-build.showcase.ts` (real build).
