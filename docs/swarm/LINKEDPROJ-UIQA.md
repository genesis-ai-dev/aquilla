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

---

## Round 2 (post-fix)

Date: 2026-07-06 · Branch `swarm/linkedproj-integration` @ `2ac232505` (build verified in-app sidebar).
Same stack recipe as round 1: dev-stack from this worktree on isolated ports **6173/9788/9789**,
shared PG `aquilla-dev-pg`, dev user via `/__dev/login`. Migration 0050 re-verified before boot
(`source_project_id`/`source_link_*` on `projects`, `upstream_*`/`tombstoned_at` + partial index on
`cells` all present). Round-1 projects intact (A/B/D 1 file each, Clone C still 0 files — born pre-fix).

Round-2 projects (left in dev PG):

| Project | id | link |
|---|---|---|
| QA2 Upstream A | `1936ea18-ae43-42af-bc13-a3abf37f978a` | none (same 4-cue VTT, file `019f3904-7719-736b-85ea-50838abf3e84`) |
| QA2 Downstream B | `c72bc51b-d5dc-407e-9498-deb1f52825ae` | live / consumes=source ← A2 (file `d4d89d64…`) |
| QA2 Clone C | `1e16c19b-7c30-4ff6-b2ad-201da08260c8` | clone ← A2 (file `19c0518c…`) |
| QA2 SelfHeal E | `aa810f7b-fc89-40c4-9d5b-b8a90b6890ee` | live ← A2, link injected via SQL with 0 files (fabricated pre-fix state) |

### Seed path observed: CLIENT FALLBACK (server-side seed not wired in the local dev stack)

`POST /link-source` (live mode) returned 200 with **`"seeded": false`** and the client immediately
fired its fallback `POST :9789/api/v1/projects/:B/link/sync` →
`{"ranSync":true,"cellsMirrored":4,"filesMirrored":1,"fromSeq":0,"toSeq":5}`. Root cause of
`seeded:false` locally: `scripts/dev-stack.ts` passes `SYNC_WORKER_URL=http://127.0.0.1:9789` as
**process env**, but its own comment (line ~529) says only `--var` lands values in `c.env` — so the
auth-worker actually sees wrangler.toml's top-level `[vars]` value **`https://api.aquilla.app/sync`**
(the PROD sync host). `triggerLinkSeedSync` guards pass (SYNC_SECRET_KEY set in .dev.vars), the fetch
goes to prod, fails auth/route, returns false, no local log line. So on the local stack the
**server-side seed path is structurally unexercisable** and the client fallback is what round 2
verified. NEW ISSUE (dev-stack wiring, not a feature bug): pass SYNC_WORKER_URL via `--var`, both to
test the primary path locally and to stop the local dev auth-worker calling prod on every live link.

### Check 1 — Seed at creation, live: **PASS** (client-fallback path)

- Created A2 + imported 4-cue VTT (PG: 1 file / 4 cells). Created B2 via ProjectCreateDialog →
  Linked target → upstream A2 → Live + "Its source" → Create & Link.
- Landed in B2 with **no manual sync**: mirrored `qa2-source-a.vtt` auto-opened, all 4 source cells
  visible, footer "4 cells". PG: B2 file row has a **new file id** (`d4d89d64…`), all 4 mirror cells
  carry `upstream_event_id` provenance (event-sourced mirror, not projection writes).
- Zero-file self-heal: round-1 B was already healed manually and Clone C never self-heals (by
  design), so fabricated the pre-fix state — created plain project E, SQL-injected a live link with
  0 files, opened `/project/E`. **Self-heal fired without reload**: automatic
  `POST /link/sync` → `cellsMirrored:4, filesMirrored:1`, file auto-opened with all 4 cells; a
  second automatic link/sync no-oped idempotently (`ranSync:false`).

### Check 2 — Seed at creation, clone: **PASS**

- Created C2 via the same dialog with Clone selected. `POST /link-source` → 200
  `{"mode":"clone", "seeded":true}` — the snapshot ran **synchronously server-side in auth-worker**
  (no sync-worker involvement, so the dev-stack wiring gap doesn't affect clones). No client
  link/sync fired (correct — clones never subscribe).
- C2 born WITH content: PG 1 file / 4 cells, UI shows all 4 texts. Clone cells have
  `upstream_event_id` NULL (snapshot projection — fine, clones never re-sync).
- **Global files.id PK bug fix verified**: C2's file row got a fresh id (`19c0518c…`); A2's row
  (`019f3904…`) untouched in PG and A2's UI still lists its file with all 4 cells.
- After A2's cell 1 was edited twice (r2, r3): C2 shows **0 amber / 0 violet** badges and still
  renders the original text. Clone independence holds, non-vacuously this time.

### Check 3 — Push text race (FRO-479) + first-open tone: **PASS**

- Setup: translated B2 cell 1 (TipTap type + blur); PG target row pinned
  (`source_event_id = e5ee2d5f…`, B2's mirror event).
- Push race: with B2's file open and untouched in tab 1, edited A2 cell 1 via raw
  `POST :9789/events` `source.cell.commit` (`…(REVISED r2)`, accepted id `161cc521…`, parent chained
  on the import event). Within the observation window (first poll ≲15s after the event), the
  untouched tab showed **1 amber `stale-source-indicator` on the correct row AND the mirrored source
  text already updated to "(REVISED r2)"** — no reload. Round-1 BUG-3 (badge-without-text) is fixed.
  Network trail in that tab confirms the fixed sequence: `link/sync` POST → `stale-source` →
  `cells?since=6` delta + a targeted `cells?cellIds=30934676…` refetch (the post-sync revalidate).
- First-open tone (round-1 BUG-2): edited A2 again (`(REVISED r3)`, id `331e6839…`) with B2 closed,
  then fresh-opened B2's file and sampled badge tones every ~350ms for 12s. Badge rendered **amber
  from first paint (t≈1.7s); violet never appeared**; text settled to r3 at t≈2.1s. No transient
  violet, no reload needed.
- Server gate exact-match: B2 `stale-source` → `staleCellIds:["30934676-…"]`,
  `upstreamStaleCellIds:[]`, `tombstonedCellIds:[]`, `ancestorBehind:false`.
- PG cross-check: B2 mirror source at `upstream_seq 6→7` across the two edits, B2 target value and
  pin untouched by sync.

### Residual notes (not regressions)

- **Round-1 item 4 (cosmetic) still reproduces**: after picking an upstream project the combobox
  trigger renders the raw project id (`1936ea18-…`), not "QA2 Upstream A". The fixer's code-review
  claim ("base-ui Select renders the matched item's name") does not hold live — needs a real fix.
- `gate:"validated"` still stored for consumes=source links (round-1 note 5, unchanged).
- Console: only the pre-existing worktree-symlink font 403 (round-1 stack incident), zero new errors.
- Round-1 Clone C (`16b013d8…`) remains empty in dev PG — pre-fix clones have no birth snapshot and
  no self-heal; if anyone kept a real clone from before 2ac232505 it needs a manual re-create.

**Verdict: all three round-1 defects verified fixed on the live stack.** Caveat: the server-side
live seed (`seeded:true` for live mode) could not be exercised locally due to the dev-stack
SYNC_WORKER_URL wiring above — production behavior of that path is untested; the client fallback
covers it correctly.
