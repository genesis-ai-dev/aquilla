# Production-build edit-burst profile (AQU-1147 gate, AQU-1146 baseline)

Recorded 2026-09-04 on `dev` @ `ddaa15b48`, local dev stack, macOS (Apple Silicon),
headless Chromium via Playwright + CDP `Profiler`/`Performance`.

**Status: partial.** The production profile was captured in full. The dev-build
side-by-side was NOT captured — see *Gaps* below. AQU-1147 was de-gated by the
orchestrator mid-run (the dev team will re-measure on `dev.aquilla.app`), so this
stops at the production numbers.

## Fixture

| | |
| --- | --- |
| File | `World English Bible (eng-engwebp)`, id `01a06aaf-cffb-7299-a025-6539c13e0f41` |
| Cells | **30,959 source cells** (project total 31,462) |
| How obtained | in-app **Import → eBible Corpus → `eng-engwebp`** into the seeded `dev-project` |
| Project | `dev-project` on the local dev stack |

Note: the ticket's suggested `eng-eng-web` (WEB with Deuterocanon) **cannot** be used —
the eBible corpus file exists but is empty, and the importer correctly refuses it
("…is not available for download… may be restricted due to copyright"). `eng-engwebp`
is the equivalent full 39 OT + 27 NT English Bible that does download.

## Build under test

Unminified production build (function names preserved, React in production mode —
verified: `function ProjectWorkspace` present in the chunk, no `react-dom.development`):

```bash
VITE_AUTH_BASE=http://127.0.0.1:8788 \
VITE_SYNC_WORKER_HOST=127.0.0.1:8789 \
VITE_CHAT_BASE=http://127.0.0.1:8788/chat \
npx vite build --minify false --outDir dist-prof
npx vite preview --outDir dist-prof --port 4173 --strictPort --host 127.0.0.1
```

`--minify false` was chosen over sourcemap resolution so the `.cpuprofile` carries real
function names directly. `dist-prof/` is gitignored.

**`/__dev/login` does not work in a production build** — `src/components/DevLoginRoute.tsx`
is gated on `import.meta.env.DEV`. The profiler instead logs in on the dev server (5173),
reads the session envelope out of IndexedDB (`frontier` → `session` → `envelope`), and
replays it into the 4173 origin with `addInitScript` before first paint. No product code
was changed.

## Bursts

Two 90 s bursts were run on the production build.

1. **Draft all** (`File options → Draft all (review required)`, confirm requires ticking
   the "I understand…" checkbox first). This is **network-bound**: it caps at 500 cells,
   packages 10 per model call, and only **5 cells** were drafted in 90 s. The main thread
   was 95% idle, so it does not stress the render path.
2. **Scripted typing burst** — click target cell → type → blur onto the source column to
   commit, cycling the first 6 rows, ~1 commit/s. **56 commits in 90 s** (verified: 57
   `target.cell.commit` events for this file in Postgres). This is the commit-dense burst
   and is the headline result.

## Results — production build

| Function (inclusive) | Typing burst, 56 commits/90 s | Draft all, 5 drafts/90 s |
| --- | --- | --- |
| `ProjectWorkspace` | **1564 ms · 1.72% wall · 6.39% busy** | 209 ms · 0.23% wall · 4.88% busy |
| `EditorTable` | 268 ms · 0.30% wall · 1.10% busy | 16 ms · 0.02% wall · 0.36% busy |
| `EditorRow` | 614 ms · 0.68% wall · 2.51% busy | 98 ms · 0.11% wall · 2.28% busy |
| `MemoizedRow` | 32 ms · 0.04% wall · 0.13% busy | 0 ms |
| `TranslatedEditor` | 240 ms · 0.26% wall · 0.98% busy | 0 ms |
| `writeCellsCache` | 0 ms | 0 ms |
| `replaceRows` | 0 ms | 0 ms |

| | Typing burst | Draft all |
| --- | --- | --- |
| Wall / busy | 90.9 s / 24.5 s (**26.9% busy**) | 91.0 s / 4.3 s (4.7% busy) |
| JS heap min / median / max | 62.6 / 143.4 / **237.6 MB** | 46.6 / 62.1 / 114.9 MB |
| Heap before → after | 60.3 → 115.1 MB | 65.7 → 63.2 MB |
| Long tasks (count / total) | 28 / 1908 ms | 14 / 1098 ms |
| File open time | 17.2 s | 7.1 s |

Top self-time, typing burst (production): `(program)` 6.05% wall, `(garbage collector)`
1.65%, `(anonymous)` 1.67%, `applyOutboxOverlay` 0.52%, `commitHostUpdate` 0.41%,
`useState` 0.40%, `diffChangedAuditCellIds` 0.38%, `getBoundingClientRect` 0.31%.
Whole-React-tree inclusive (`performWorkOnRoot`) is 16.3% wall / 60.7% busy — i.e. React
rendering dominates the *busy* time, but `ProjectWorkspace` is only ~1/10th of that.

## Reading

- The dev-mode figures on AQU-1147 (`ProjectWorkspace` ~25% inclusive, a fifth of the run
  in React dev-mode `createElement`, heap swinging 250–800 MB) **do not survive the
  production build**. In production, under a burst that is 5–10× more commit-dense than
  Draft all, the shell is **1.7% of wall time and 6.4% of busy time**, and peak heap is
  238 MB rather than 800 MB.
- Under the burst users actually run (Draft all), the shell is **0.2% of wall time** and
  the main thread is 95% idle — Draft all is bounded by model latency, not by rendering.
- `EditorTable` (0.30% wall / 1.1% busy) and `EditorRow` (0.68% / 2.5%) are likewise far
  below their dev-mode figures of 12.5% and 6.8%. `MemoizedRow` is ~0 — `React.memo` is
  already holding for most rows.

## Recommendation

- **AQU-1147: scale down.** Its own first acceptance criterion says "if the production
  profile shows the shell render under a few percent, scale this ticket down." It is under
  a few percent of wall time on both bursts. Recommend reducing to the cheap, low-risk
  part — move the two or three most expensive version-driven derivations out of the shell
  — and dropping the full ~20-memo extraction plus the render-count-probe test scaffolding,
  unless a dev-build-experience argument is made separately (the dev build *is* much worse,
  and that is what the team works in all day).
- **AQU-1146: scale down.** Production baseline is recorded above. The stated goal ("below
  12.5% and 6.8%") is already met by an order of magnitude in production before any change.
  The per-cell row-prop boundary is still defensible on its own merits (it is a correctness/
  clarity improvement and helps the dev build) but should not be justified by these numbers.

## Incidental findings

- **Server-side reads for this file are the real bottleneck.** From `.dev-stack-logs/sync.log`:
  `GET …/files/<bible>/cells` took 7.5 s, 42 s and 57 s; `GET …/files` took 23–93 s;
  `GET /cells/audit-stats` up to 32 s. This is direct evidence for **AQU-1160**.
- The client gives up on the cell fetch after 15 s (`[useActiveCellStore] fetch failed:
  TimeoutError: signal timed out`), so once the server crosses that line the 31k-cell file
  **cannot be opened at all**. That is what blocked the dev-build profile.
- A `SecurityError: Failed to execute 'open' on 'IDBFactory'` is thrown once per page load
  on the preview origin. Commits still persisted, so it appears to come from a sandboxed
  sub-context, but it is worth a look.

## Gaps / approximations

- **No dev-build side-by-side.** Three attempts failed: the dev build could not open the
  31k-cell file before the client's 15 s cell-fetch timeout (see above). The dev figures in
  the tickets (from PR #532) stand as the dev-side reference.
- The Draft-all burst drafted only 5 cells, so its render numbers are not a like-for-like
  substitute for the ticket's dev Draft-all run; the typing burst is the comparable one.
- Build is `--minify false`; a minified release build inlines differently, so absolute
  percentages could shift by a small amount.
- Single run per configuration, one machine, other agents' work running concurrently.

## Reproduction

```bash
# 0. dev stack (leave running)
colima status && pnpm dev

# 1. import the Bible once, through the UI:
#    Import → eBible Corpus → search "World English Bible" → pick eng-engwebp → Import
#    verify: docker exec aquilla-dev-pg psql -U aquilla -d aquilla_dev \
#      -c "select count(*) from cells where file_id='<id>' and side='source';"

# 2. production build + preview
VITE_AUTH_BASE=http://127.0.0.1:8788 VITE_SYNC_WORKER_HOST=127.0.0.1:8789 \
  VITE_CHAT_BASE=http://127.0.0.1:8788/chat npx vite build --minify false --outDir dist-prof
npx vite preview --outDir dist-prof --port 4173 --strictPort --host 127.0.0.1

# 3. profile (scripts live in the scratchpad, see below)
node profile.mjs prod-typing http://127.0.0.1:4173 typing 90
node profile.mjs prod        http://127.0.0.1:4173 draftall 90
node analyze.mjs prod-typing.cpuprofile
```

Raw artefacts (not committed) —
`/private/tmp/claude-501/-Users-ryderwishart-frontierrnd-aquilla/a5ef4c80-2c5b-424e-ab40-4d0cbb5ff60f/scratchpad/profile/`:
`prod-typing.cpuprofile`, `prod.cpuprofile`, `*-meta.json` (heap/long-task/commit counts),
`profile.mjs` (driver), `analyze.mjs` (inclusive-time analyzer), screenshots.
