# Demo-Readiness Handoff — codex-web-app swarm

_Autonomous swarm run, 2026-05-30 → 05-31. This is the user-facing summary; the full
ledger is `ORCHESTRATION.md`._

## TL;DR
All the swarm's work sits on branch **`swarm/integration`** (worktree `.worktrees/swarm-integration`),
verified green: **`tsc` clean · 1144 unit tests · `npm run build` passes · 4 live UI-QA passes**.
It is **NOT yet on `main`** — blocked only by your concurrent sync-worker work (see "Needs you" #3).
A live copy runs at **http://127.0.0.1:5273** (login: `/__dev/login`).

## What the swarm delivered (all verified)
- **Import**: CAT formats added (XLIFF 1.2/2.0, TMX, CSV/TSV bilingual) with robustness for Excel-BOM, multilingual TMX, XLIFF-2.0 segments; eBible picker filtered to downloadable translations (no more 404s). Round-trip fidelity verified (`ROUNDTRIP-FIDELITY.md`); 2 real bugs caught+fixed (TMX source/target selection, TSV `"`/tab/newline corruption).
- **Export**: multi-format (txt/md/tsv/csv/XLIFF/TMX) + whole-project zip + ExportDialog (was USFM-only).
- **Living Memory**: the read-only surface **and** the active learning loop — validated corrections + project rules now feed the next AI draft ("the system learns" is real now).
- **Search**: fixed a one-line mis-wire that silently no-op'd ALL search; added parallel-passages multi-project mode.
- **Back-translation**: wired (display path; persistence needs the event layer — traced).
- **Complete-all**: enabled (was a disabled "coming soon"), with confirm + cost hint.
- **Rule suggestion** from your validated corrections.
- **Perf**: main JS bundle **772 kB → 46 kB** (route-level code-splitting) — much faster first paint.
- **A11y / UX polish** across every new surface + the homepage + onboarding (focus, landmarks, responsive, dark-mode, states).
- **Voice/audio demo-blockers fixed**: audio-failure now shows a clear message + working "open audio settings" CTA; honest button labels; "Key needed" vs "Key invalid".

## Needs YOU (the only things blocking a fully-green ship)
1. **Homepage overclaims** (decisions, not bugs) — `CLAIMS-AUDIT.md`: **video** translation and **image/oral-story** modalities have no implementation; **"private mode"** is unclear. Build them, or dial back the copy. Plus 3 copy items the homepage worker flagged (`SWARM-TODO(homepage-copy)`: open-source badge truth, stats sourcing, "JESUS Film" trademark). I did NOT touch marketing copy.
2. **sync-worker test refresh** (~5 min) — `SYNC-WORKER-FAILURES.md`: 6 failing tests are all **stale tests, not bugs** (the "auth bypass" was a false alarm — a deliberate feature). Quick fixes documented; it's your package so I left it to you.
3. **Promotion to `main`** — your Paratext work is committed (main `e99b45b`), but your sync-worker tree is still dirty (event-layer WIP). The swarm auto-promotes the instant that tree is clean. To promote manually once clean:
   ```
   cd /Users/ryderwishart/prototypes/codex-web-app
   git merge swarm/integration
   # resolve import.ts / ImportDialog.tsx / parsers/types.ts → KEEP BOTH (your Paratext cases + swarm CAT cases); source-export.ts fix is identical
   ```

## Honest known limitations (traced, not blockers)
- Voice: "Voice together" discoverability (A5), "Voice" nav lens-vs-settings is a **product decision** (A7), Esc-to-close-dropdown (A8) — all traced in code + `UI-QA-PUNCHLIST.md`.
- Export: plain-text/markdown are one-way (target only) by design; TMX drops untranslated cells (inherent to TMX). Documented in `ROUNDTRIP-FIDELITY.md`.
- Back-translation/comments/autofix/bulk-audio persistence need new sync-worker event kinds (your forbidden territory) — traced in `TRACES.md`.
- e2e smoke + a hands-on golden path on `main` not yet run (needs the dev-stack ports free / post-promotion).
- The **org-context admin surfaces** you recently committed (Overview dashboard, archive/untrack, audio-progress, Settings/Members-in-shell) were NOT QA'd by the swarm — they're outside the homepage-claims scope and your active domain. Recommend a quick walkthrough (they're live on your :5173) before the demo.

## Demo-prep tips (from the Pass-4 golden-path run — verdict: READY-WITH-CAVEATS)
- **Populate first**: the seeded `dev-project` files are empty stubs. Before demoing, import a real corpus — the eBible tab → **`eng-engBBE`** imports cleanly (~31k cells).
- **Living Memory** only shows entries once cells have **2 validators** (the trust threshold). A single-user demo shows the empty state — validate as 2 users (e2e alice/bob) or lower the threshold if you want it populated live.
- One demo-blocker (Voice Studio button → blank page) is being fixed (W17) — verify it lands once merged.

## Key docs
`ORCHESTRATION.md` (full ledger + merge log) · `TRACES.md` (open TODOs) · `UI-QA-PUNCHLIST.md` (4 QA passes) · `ROUNDTRIP-FIDELITY.md` · `CLAIMS-AUDIT.md` · `SYNC-WORKER-FAILURES.md`.
