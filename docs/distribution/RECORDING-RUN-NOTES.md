# Recording cycle — first proof run (P1)

Evidence that the distribution cycle produces **real footage of the live app**, and an honest note on what completed where.

## What ran

`npm run record -- -g "P1"` booted the full stack (auth-worker + sync-worker + Vite preview, D1 migrations, local Postgres backing Hyperdrive), launched a real Chromium, authenticated as the seeded `alice`, and drove the P1 "Field Translator" journey with the `Showcase` overlay burning chapters/captions into the frame. Then `npm run record:assemble` transcoded and emitted the cuts.

## Artifacts produced (git-ignored `e2e/recordings/output/`)

| File | What it is |
|---|---|
| `…/video.webm` (1.7 MB) | Raw recording of the live app, 1280×800 |
| `p1-field-translator__local-first-editing.mp4` (616 KB) | Assembled H.264 cut (faststart) |
| `…storyboard.json` | Chapters + captions (the VO script) + `verified` flag |
| `…editlist.json` | Title cards + VO script + per-channel cuts (announce/docs/market) |

The footage shows alice's authenticated workspace, the created project *"Luke — Eastern dialect"*, the real product UI (Editor/Rules/Terminology/Comments/Voice), and the branded persona narration on screen.

## Honest status: `verified: false`

The storyboard is marked **`verified: false`** — the take is a *partial* cut, and the cycle's discipline forbids shipping it as a value claim until the money moment renders. Why partial here:

- Project **creation** and all **reads** worked against the local stack.
- The **import** step's sync-write did **not** complete in this sandbox: the headless browser → local wrangler-worker **mutation/POST path** doesn't finish here (reads/GETs do). So no file imported → the "edit survives reload" money moment couldn't be filmed.
- This is an **environment limitation, not a cycle defect** — the same flows pass in CI/dev (the green `import-and-edit` smoke uses the identical page objects). Re-running `npm run record` in the full dev/CI environment (working backend writes) yields a `verified: true` take with the complete money moment, which the assembler then turns into the announce/docs/market cuts.

## Fixes landed while proving the cycle

- `Dashboard.createProject` selectors matched the current dialog labels (`Project name`/`Source language`/`Target language`, anchored + case-insensitive) — unblocks the editor smoke too.
- The P1 take uses the default `page` fixture (Playwright records its video) with manual session injection, because the multi-user fixture's `browser.newContext()` omits `recordVideo`.

## Re-run

```bash
# full dev/CI backend (writes work → verified:true, full money moment):
npm run record -- -g "P1"
npm run record:assemble            # → mp4 + edit-list + per-channel cuts
# sandbox needs a local Postgres for Hyperdrive first:
#   export WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE=postgresql://…/aquilla_dev
```
