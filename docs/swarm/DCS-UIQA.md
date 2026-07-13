# DCS importer — live browser UI-QA (2026-07-07)

Drove the **real dev stack** against **live git.door43.org** to prove the Door43 (DCS)
importer end-to-end in the UI. Honest split of what's proven on screen vs. what's blocked by
real code defects. Screenshots in `docs/swarm/dcs-proof-shots/`.

## Verdict

- **MILESTONE 1 (Door43 import UI against live DCS): PROVEN on screen, end-to-end.**
  Browse the live catalog → pick a resource → "Import as source" → source cells appear →
  survive reload (server projection) → the Door43-upstream freshness panel renders and a live
  "Check for updates" round-trips to DCS.
- **MILESTONE 2 (delta → downstream stale flags): BLOCKED in the UI by two real code defects
  (below); the delta ENGINE itself is proven correct on real changed data (1082 changed
  Translation Notes on en_tn v87→v89) via the real modules.**

## Stack / how it was booted

- Worktree: `.worktrees/dcs-browser-proof` (branch `claude/dcs-browser-proof`, build `9dacd2c`).
- Isolated ports (a concurrent session held the Playwright Chrome profile):
  `DEV_STACK_IDENTITY_PORT=9788 DEV_STACK_SYNC_PORT=9789 npm run dev -- --vite-port=6173`,
  registered as `stack-dcs-proof` in `.claude/launch.json` and started via the Preview MCP
  (the Playwright MCP browser was locked by another session — Preview owns its own browser).
- `pnpm install` in `auth-worker/` and `sync-worker/` (their own lockfiles) — required or the
  workers don't boot. The D1 migration error on boot is the known non-fatal one (workers run
  on the Postgres/Neon path now).
- Auth: `/__dev/login` (SPA) / `POST /__dev__/login` (worker) seeds the `dev` user, Dev Org,
  Dev Project. All screenshots captured headlessly with `scripts/dcs-proof-capture.mts`
  (isolated Chromium) since the Preview/Playwright MCP screenshots weren't persistable to disk.

## Milestone 1 — evidence (all screenshotted)

1. **`00-import-landing-dcs-option.png`** — Import dialog → Specialized → "Door43 (DCS) upstream
   (Beta)" option present and gated visible (the host can persist the cursor).
2. **`01-catalog-browser-live-dcs.png`** — the catalog browser listing **real live DCS entries**
   (`unfoldingWord/en_ult v89`, `en_ust v89`, `en_uag`, `en_t4t`, `en_ueb`, … 18 results for
   `lang=en owner=unfoldingWord stage=prod`). CORS from the SPA origin works (`access-control-
   allow-origin: *`), confirming the "client-side adapter, no worker proxy" design.
3. **Import as source** — picked `unfoldingWord/en_obs` (Open Bible Stories) → **50 files /
   598 cells imported, pinned to release v9** through the real `importDcsResource` →
   `bulkUploadSource` → `POST /import` path.
4. **`03-imported-source-cells-creation.png`** — the editor showing OBS 1 "The Creation" with
   16 real source cells (English source / Italian target), **including the OBS frame reference
   images** rendered inline from `cells.metadata.attachments`. Status Live · Synced.
5. **Server-state-after-reload** — full page reload; all 40 OBS story files + the 16 Creation
   cells rehydrated from the sync-worker (deterministic file id `b0fa6dfe-…`), proving the
   import projected server-side, not just optimistic client state.
6. **`05-upstream-panel-pinned-v8.png` / the Dev-Project equivalent** — the `DcsUpstreamPanel`
   ("Door43 upstream") renders in Project Settings for a DCS adapter, with the persisted cursor
   badges (`unfoldingWord/en_obs`, `pinned vN`, `tracking release`) + "Check for updates".
7. **Live "Check for updates"** — on the v9 Dev Project it round-tripped to DCS and correctly
   reported **"Up to date with v9."** (green). The freshness check hits live git.door43.org.

## Real code defects found (live-UI-only — mocks + unit tests miss all three)

### DEFECT 1 — `DcsClient` stores an UNBOUND native `fetch` → "Illegal invocation" in the browser
`src/lib/dcs/catalog.ts:102`
```ts
this.fetchImpl = opts.fetchImpl ?? fetch   // ← stores bare fetch
// …later:  const res = await this.fetchImpl(url)   // called with this = DcsClient instance
```
The browser rejects native `fetch` invoked with `this !== window`:
`TypeError: Failed to execute 'fetch' on 'Window': Illegal invocation`. This throws on the very
first catalog search — the catalog browser shows *"Failed to execute 'fetch' on 'Window':
Illegal invocation"* and **no results**. Verified in-page: the same URL with `fetch.bind(window)`
returns HTTP 200; unbound throws. Unit tests never hit it because they inject a plain
`fetchImpl` mock (a function that doesn't care about `this`). This blocks EVERY DCS network call
in the real browser.
**Fix (one line):** `this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis)` (or a
`(...a) => fetch(...a)` closure). All Milestone-1 UI evidence above required a runtime
`window.fetch` bind shim to work around this; the underlying app code is otherwise correct.

### DEFECT 2 — catalog language defaults to the DISPLAY NAME, not the ISO code
`DcsCatalogBrowser` is mounted with `defaultLang = <project sourceLanguage>` which is the
human-readable name (**"English"**), but the DCS catalog API needs the ISO code (**"en"**).
The app's own initial search fired `?lang=English` → **0 results** ("No released resources").
`?lang=en` returns 18. So even with fetch fixed, the browser opens empty for any project whose
source language is stored as a display name. **Fix:** normalize `defaultLang` to the ISO code
(there's already `src/lib/language-normalize.ts`) before seeding the field, or search by name→code.

### DEFECT 3 — "Check for updates" resolves the entry AT THE PINNED REF, so a new tag is never seen
`src/components/dcs/DcsUpstreamPanel.tsx:119`
```ts
const latest = await dcs.getCatalogEntry(cursor.owner, cursor.repo, cursor.ref)  // ref = "v8"
if (!isNewer(cursor, latest)) { setCheck({ kind: "up-to-date", latest }); return }
```
For a **release-tracking** cursor pinned at `v8`, `getCatalogEntry(…, "v8")` returns the **v8**
entry, so `isNewer` compares v8-vs-v8 → **"Up to date with v8"** even though the current prod
release is **v9**. The SHA-comparison-on-same-ref only catches a *moved tag* / HEAD-tracking
cursor, not a *new tag name* (v8→v9 — the normal release case). Proven on the v8 adapter:
`07-check-v8-false-uptodate-BUG.png` shows the panel wrongly saying "Up to date with v8" while
`catalog/search?owner=unfoldingWord&repo=en_obs&stage=prod&limit=1` returns **v9**.
Because "Import changes" only appears in the `update-available` state, this defect **blocks the
entire Milestone-2 UI delta flow**. **Fix:** resolve the *latest prod release* for the repo
(catalog search `stage=prod`, owner+repo, limit 1), then compare that to the cursor — don't
re-fetch the pinned ref.

### FINDING 4 (design, not necessarily a bug) — DCS ids are content-addressed, NOT project-scoped
`src/lib/dcs/cell-id.ts` derives `dcsFileId(repo, key)` and `dcsCellId(seed)` from **repo +
reference only** (spec §5 — this is intentional, and is what makes re-import a stable-id commit
instead of id-churn; verified: en_obs Creation fileId `b0fa6dfe-…` and its first cellId are
byte-identical across v8/v9). Consequence: importing the SAME DCS resource into TWO different
projects produces IDENTICAL file/cell/(file-)event ids, and the sync-worker `/import`
`INSERT OR IGNORE` on the `file.create` event id then **silently drops the second import** — the
new project gets 0 files. This matches the intended architecture (spec §10: ONE shared adapter
project per repo@ref, downstreams *link* to it rather than re-import), but it's a sharp edge:
the standalone-old-cursor construction for a delta demo collides with any existing import of the
same repo. Worth a guard/warning if two projects ever try to own the same DCS resource.

## The product gap you flagged (confirmed)

**The import UI pins latest-only — there is no release picker.** Import always pins the *current*
prod release (`trackMode: "release"`, latest tag). So a delta demo genuinely requires
constructing an OLDER-cursor starting state out of band. Confirmed correct read. Combined with
DEFECT 3, even a correctly-constructed old cursor can't surface the update in the UI today.
(A release picker in the catalog browser would let a user pin an older release directly and make
the whole delta flow demoable without a script.)

## Milestone 2 — delta engine proven on real data (the thesis, minus the UI wiring)

Blocked from the pure-UI path by DEFECTS 1+3, I proved the delta ENGINE directly with the REAL
modules (`computeDelta` / `contentHash` / routed parse / `DcsClient`) against live DCS
(`scripts/dcs-proof-delta.mts`):

- **`unfoldingWord/en_tn` v87 → v89** (Translation Notes; the DCS-PROOF-blessed clean target):
  `creates=13705  commits(changed)=1082  deletes=6`, and **every changed cell maps to a stable
  EXISTING cell id** (a commit on the existing cell, not id-churn). Sample changed notes:
  `1CO 1:21`, `1CO 3:intro`, `1CO 5:intro`, `1CO 7:28` — real note-text edits. This is the whole
  downstream-invalidation thesis on real data: a re-import commits exactly the changed source
  cells on their stable ids, which is precisely what flags a downstream translation stale.
- `unfoldingWord/en_obs` v8 → v9 correctly computed **all-zeros** (the v8→v9 file changes were
  to content the OBS route hash-normalizes away — a correct no-op suppression, not a miss).

The setup construction also works end-to-end: `scripts/dcs-proof-setup.mts` imported en_obs@v8
(598 cells) into a fresh adapter via the real `/import` endpoint and pinned `dcsUpstream=v8`
(the panel then renders `pinned v8`). Only DEFECT 3 stops the panel from advancing v8→v9.

## What a green Milestone-2 UI demo needs (once defects fixed)

1. Fix DEFECT 1 (fetch bind) + DEFECT 2 (ISO lang) + DEFECT 3 (compare against latest prod).
2. Use a resource NOT already imported elsewhere (FINDING 4), or one shared adapter.
3. Then: import@vOLD → link 2 language projects (ProjectCreateDialog upstream picker) →
   translate a cell → panel "Check for updates" shows vOLD→vNEW → "Import changes" → the changed
   source cell flags STALE in both downstreams + shows in the Upstream-changes review panel.
   Every piece except DEFECT-3's check is already shipped and unit-tested.

## Artifacts (all on branch `claude/dcs-browser-proof`, NOT pushed)

- `docs/swarm/dcs-proof-shots/*.png` — 5 screenshots (landing, live catalog, imported cells
  with frame images, v8 upstream panel, the false-up-to-date bug).
- `scripts/dcs-proof-setup.mts` — real-module import of a resource@oldTag into a fresh adapter
  + cursor pin (throwaway QA; not feature source).
- `scripts/dcs-proof-delta.mts` — real `computeDelta` on live v_old→v_new data.
- `scripts/dcs-proof-capture.mts` — isolated-Chromium screenshot capture.
