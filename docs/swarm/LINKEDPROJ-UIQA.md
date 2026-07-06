# Linked Projects — live-UI QA punchlist

Date: 2026-07-06 · Branch `swarm/linkedproj-integration` @ `538532149` (build info verified in-app sidebar).
QA agent: live-UI singleton. Stack: dev-stack from this worktree, shared PG `aquilla-dev-pg`
(`aquilla_dev`), ports **6173/9788/9789** (see "Stack incidents" — default ports were stolen mid-run).
Dev user `dev` via `/__dev/login`, org "Dev Org" (id 36).

Projects created during QA (left in dev PG for repro):

| Project | id | link |
|---|---|---|
| QA Upstream A | `41122a8f-d6af-448e-a98e-b697efdbd14a` | none (4-cue VTT imported, file `019f38c7-16cd-70fe-81ca-23860fa7db16`) |
| QA Downstream B | `33de7396-ec2a-4367-a65b-579ff67cf63a` | live / consumes=source ← A |
| QA Clone C | `16b013d8-a3bd-4074-acb8-6b3347119bb6` | clone ← A |
| QA Chain D | `b5b9664b-2de0-4dd1-ad12-33ed9d328a84` | live / consumes=target / gate=validated ← B |

Setup: applied `db/postgres/migrations/0050_live_source_links.sql` to `aquilla-dev-pg` (clean run,
7×ALTER + 1×CREATE INDEX; verified `source_link_*` on `projects` and `upstream_*`/`tombstoned_at`
on `cells` resolve).

Source edits in A were made via `POST :9789/events` with `source.cell.commit` (sync-token from
`POST /api/v2/sync-token`) because **the editor has no source-edit affordance** — only
`OutboxInspectorPopover`/settings components reference `source.cell.commit` client-side.

---

## Check 1 — Core loop (FRO-476 + FRO-478 creation): **PARTIAL**

Clicked: Dev Org → + New Project → name/langs → Advanced: project shape → **Linked target** →
Upstream project picker (lists all accessible projects) → defaults Live + "Its source" → Create & Link.

- Creation UI: **PASS** — shape radiogroup (Self-contained / Source-only / Linked target), upstream
  combobox, Live/Clone, source/translations all render and submit.
  `POST /api/v2/projects/:B/link-source` fired with `{"sourceProjectId":A,"mode":"live","consumes":"source"}`
  → 200 echoing the stored link (+ `gate:"validated"` even for consumes=source — harmless default, noted).
- **BUG-1 (BLOCKER)** — *No mirror seed at creation.* B opened with "No files imported yet";
  PG confirmed 0 files / 0 cells for B while the link row was persisted. No client `POST /link/sync`
  ever fired (network audited). The lazy-pull trigger lives in `useStaleSourceCells`, which only
  runs with an open file → chicken-and-egg for a freshly created empty linked project. The dialog's
  own SWARM-TODO promise ("new project opens with the upstream's files/cells ALREADY present") is
  NOT met. Workaround used: manual `POST :9789/api/v1/projects/:B/link/sync` →
  `{"ranSync":true,"cellsMirrored":4,"filesMirrored":1,"fromSeq":0,"toSeq":5}` — the mirror engine
  itself works.
- After seed, B auto-opened the mirrored `qa-source-a.vtt` with all 4 source cells + VTT timings. **PASS**
- Translated cells 1–2 in B (TipTap type + blur); PG shows both `target` rows with `source_event_id`
  pins set. **PASS**
- Edited A cell 1 via API (`…(REVISED v2)`, event `019f38d1-d4ce-7a14-adca-3f159cd09ea1`), reopened B:
  - **BUG-2 (MINOR)** — first open shows the **violet** "Upstream ancestry changed" badge, not amber:
    the stale-source fetch races the fire-and-forget `triggerLinkSync` and nothing revalidates when
    the sync completes. Next reload settles to the correct **amber** badge.
  - Settled state: exactly 1 amber `stale-source-indicator` on the translated+edited row; untouched
    rows (incl. translated-but-unedited cell 2) show nothing. **PASS**
- Server gate: `GET /api/v1/projects/:B/files/:f/stale-source` →
  `staleCellIds:["6198bdba-…"]`, `upstreamStaleCellIds:[]`, `tombstonedCellIds:[]`. Exact match. **PASS**

## Check 2 — Upstream changes review panel (FRO-478): **PASS**

Clicked: `/project/:B/settings` → "Upstream changes" section (also linked in the settings nav rail).

- Shows "Upstream changes · 1 flagged", grouped under "Sync batch — 7/6/2026, 1:05:12 PM · 1 cell",
  row = `qa-source-a.vtt · <cellId>` + **old→new word diff** (verified in DOM: `(REVISED` / `v2)`
  tokens wrapped in emerald insert spans; deletions render red/line-through per `DiffText`).
  Note: a11y snapshot flattens the diff — check DOM, not the accessibility tree.
- "Accept as-is" (repin): PG before/after shows target `value` and `event_id` UNCHANGED;
  `source_event_id` moved `4a17861e…` → `0a707528…` (= the source row's current mirror event id).
- After reload: 0 badges in the editor; `stale-source` returns `staleCellIds:[]`. **Server-verified.**
- Not exercised: the row's "Open" navigation button; bulk-select checkboxes/bulk repin.

## Check 3 — Clone mode (FRO-476): **PARTIAL**

Same dialog path with **Clone** selected (radio verified `clone` checked pre-submit).

- Link metadata persisted: `source_link_mode='clone'`. **PASS**
- **BUG-1 hits clones harder** — C born with 0 files / 0 cells, and for a clone there is no later
  sync to self-heal: `POST /link/sync` on C correctly no-ops (`ranSync:false`, 0 mirrored). The
  "one-time snapshot applied at birth" (migration 0050's own comment) does not exist. **FAIL**
- Never-subscribes semantics: link/sync refusing to mirror for clone is correct. **PASS**
- "C never shows stale flags after editing A": vacuously true (C has no content to flag) — could not
  be meaningfully tested until BUG-1 is fixed.

## Check 4 — Push accelerator (FRO-479): **PARTIAL (badge live, text not)**

Setup: B's file open in the browser, **no reloads**; A's cell 2 edited via `POST /events`
(`…(PUSH-TEST edit)` @ 13:13:05).

- Within ~13s, B (untouched tab) fired `POST /api/v1/projects/:B/link/sync` +
  `GET …/stale-source` (network log; 3× link/sync bursts observed) and the **amber badge appeared
  live on the correct row without reload**. **PASS**
- **BUG-3 (MAJOR)** — the mirrored source **text** did NOT live-update. The triggered
  `GET …/cells?since=13` delta returned `{"changedCellIds":[],"cells":[]}` — it raced the mirror
  commit and nothing refetches cells after link/sync completes. PG had the new value
  (`upstream_seq 7`) all along; the row text only updated on manual reload. The ws-reconciler
  SWARM-TODO explicitly expects "stale badge + cell text update … no reload" — half met.
- Console: clean (only the pre-existing font 403, see Stack incidents).

## Check 5 — Chains (FRO-477): **PASS** (steps 1–7; final flip step not run)

- Created D via the same dialog: upstream = QA Downstream B, Live, **"Its translations"**.
  No gate picker exists in the dialog; server defaulted `gate='validated'` (PG verified). Noted.
- Seed: manual link/sync again (BUG-1) → mirrored **exactly 1 cell**: B's *validated* cell 1
  Spanish translation; B's translated-but-unvalidated cell 2 correctly EXCLUDED by the gate. **PASS**
- Structural merge (§2): D's source row carries `start_ms=1000,end_ms=4000` from A's cue structure
  with B's Spanish text. **PASS** (cast label not exercised — source VTT had no cast assignments.)
- Translated the cell in D (pin recorded), then edited A's cell 1 a 3rd time (`REVISED v3`),
  **without touching B** (dormant middle hop).
- Reload D: **violet** `upstream-stale-source-indicator` on the edited cell's row, amber count 0. **PASS**
- Server gate: D's `stale-source` → `staleCellIds:[]`,
  `upstreamStaleCellIds:["6198bdba-…"]`, `ancestorBehind:true`. Exact match. **PASS**
- NOT RUN (time): step 8 — re-translate + re-validate the cell in B and confirm D's flag flips
  violet → amber, then clears on D's re-commit.

---

## Bug punchlist (priority order)

1. **BLOCKER — no seed at creation (live AND clone).** Linked projects are born empty; live mode
   only heals after a *manual* `/link/sync` (nothing client-side can fire it with zero files), and
   clone mode never heals. Fix candidates: fire the mirror/snapshot server-side inside
   `link-source` handling, or have ProjectWorkspace trigger `/link/sync` on mount for
   `source_link_mode='live'` projects with no files (clone still needs a birth snapshot).
2. **MAJOR — FRO-479 text doesn't live-update.** After `link.upstream-changed`, the cells delta
   fetch races the mirror commit (empty `since` delta) and nothing revalidates after link/sync
   resolves. Badge is live; row text needs a reload. Sequence the revalidate after the link/sync
   POST resolves (it returns `cellsMirrored` — enough signal).
3. **MINOR — wrong badge tone on first open after an upstream edit.** Violet shows for one load
   (pre-sync ancestry state), settles to amber only on the next reload — same missing
   revalidate-after-sync as #2, surfacing in `useStaleSourceCells`.
4. **COSMETIC — upstream picker shows raw UUID.** After selecting a project the combobox trigger
   (and the Source-link settings section) render the project id, not its name.
5. **NOTE — no gate picker** in the linked-target creation UI (server defaults `validated`);
   `gate` is also stored for consumes=source links where it's meaningless.
6. **NOTE — no source-edit affordance** in the editor; upstream corrections currently require
   re-import or raw event POSTs (matters because the whole feature is about propagating source fixes).

## Stack incidents (not feature bugs)

- Mid-run, a concurrent session (e2e/preview from `codex-web-app-worktrees/video-marketing-harness`)
  force-killed the dev stack and took :5173 (`vite preview --port 5173 --strictPort`). Restarted this
  stack on isolated ports 6173/9788/9789 (`DEV_STACK_IDENTITY_PORT/DEV_STACK_SYNC_PORT` +
  `--vite-port`); all findings above are from the isolated stack. No auth/seed issues otherwise —
  seeded projects loaded with files, no sync-token 403s.
- Pre-existing, unrelated: vite fs.allow 403 on `@fontsource-variable/geist` woff2 (worktree
  symlinked node_modules) — the single console error on every page; "1 failed" outbox badge on the
  seeded dev-project.
