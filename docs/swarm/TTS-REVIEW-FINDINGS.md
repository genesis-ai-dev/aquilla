# OmniVoice TTS — adversarial review findings (2026-06-13)

Pre-promotion review of `swarm/integration` (diff vs `610c4be9e`). Three read-only lenses.
Fixes applied by orchestrator before promotion. Status: `OPEN` / `FIXED`.

## Lens A — Metering / SQL / Modal (agent a48b0e68, DONE)

- [OPEN] **B1 MAJOR** `sync-worker/src/tts.ts:157` — malformed `X-Audio-Duration-Seconds` (`"NaN"`/`"inf"`/junk) → `Number()` = NaN written to `audio_seconds`; `SUM()` becomes NaN; `NaN >= limit` is false → user permanently unblockable that day; upsert propagates NaN. **Fix:** `const durationSeconds = Math.max(0, Number(durationHeader) || 0)`.
- [OPEN] **B2 MAJOR** `sync-worker/src/tts.ts:156-157` — absent duration header → records 0s → unlimited synth at zero metered cost (a spend-control bypass once enforce is on). Header IS produced by our `omnivoice.py:196`, so this is defensive vs Modal version drift. **Fix:** treat a successful synth with absent/invalid duration as a Modal-contract violation → log a prominent warning (enforce mode: consider 502). At minimum log.
- [OPEN] **B3 MINOR** `sync-worker/src/tts.ts:64-81` — no `text` length bound → authenticated GPU DoS. **Fix:** `if (text.length > 10_000) return 400` before Modal call.
- [OPEN] **B4 MINOR** `sync-worker/src/tts.ts:119` — `referenceAudioId` unsanitized in R2 key (pre-existing pattern in voice-convert too; R2 flat namespace makes it low-risk). **Fix:** validate `/^[\w.-]+$/`.
- [DEFER] B5 — `language` accepted but not passed to `generate()` (auto-detect mode). Don't advertise "language selection". SWARM-TODO ok.
- [DEFER] B6 — install-from-HEAD + `device_map="cuda:0"` assumptions (deploy-time risks). SWARM-TODO ok.
- [OK] org_id=0 fallback for no-org projects (mis-pools but no leak; `/usage/org/0`→403). SQL fully parameterized; PK matches ON CONFLICT; index covers rollup. Modal auth fails-closed on empty token, never echoes secret.

## Lens B — Contracts / permissions (agent a57938803350892d1, DONE)

- [FIXED] **B-BLOCKER-1** = C-BLOCKER-1 (audioId/url missing .wav). Confirmed: server stores R2 at `objectName` key + returns `{audioId, durationSeconds, objectName, url}`; client interface omitted objectName/url.
- [FIXED] **B-BLOCKER-2** `src/lib/sync/usage.ts:38` — `OrgUsage.total` vs server `orgTotal` (auth-worker `OrgUsageResponse.orgTotal`). Latent bomb (UsageRollup doesn't render total yet). Renamed client → `orgTotal` + test mock.
- [FIXED] **B-MAJOR-1** — `SynthesizeCellTtsResult` under-specified; added `objectName`+`url`.
- [OK] B-MINOR-1 `date_utc::text` cast — valid on Neon/PG. No action.
- [OK] B-MINOR-2 SWARM-TODO comment — superseded by C-MINOR-1 fix (comment deleted).
- [OK] **CONFIRMED CORRECT:** TTS route mounted before catch-all; usage routes at /api/v1/usage; /identity prefix strip; FRONTIER_BASE→auth-worker, syncWorkerHttpOrigin→sync-worker; TTS sync-token auth; usage JWT auth; maintainer gate ≥600; recordTtsUsage graceful-degrade; orgId from projects.org_id; ref R2 key identical to voice-convert; migration 0041 present.

## Resolution (orchestrator, commit ae70fa510 on swarm/integration)
All BLOCKERs + MAJORs + actionable MINORs FIXED in one pass. Re-verified: root tsc 0 · root vitest 2843 pass (7 pre-existing Login only) · sync-worker tsc 0 + 604/604 · build PASS. Deferred (acceptable, SWARM-TODO in code): omnivoice.py release-pin, device_map, language kwarg.

## Lens C — Races / regressions / EditorTable (agent af508408b0a48cba9, DONE)

- [OPEN] **C-BLOCKER-1** `src/components/EditorTable.tsx:2280-2289` + `src/lib/sync/tts.ts:26-31` — client attaches `url: frontier-audio://${result.audioId}` but `audioId` has NO extension; server returns `objectName` (`...wav`) + `url` (`frontier-audio://...wav`) which the `SynthesizeCellTtsResult` interface OMITS. `parseFrontierAudioUrl` (upload.ts:42) needs a dotted ext → returns null → `pointer-invalid` → "Audio format unrecognized". Every TTS clip unplayable. **Fix:** add `objectName` + `url` to `SynthesizeCellTtsResult`; in handleOmniTts use `audioId: result.objectName, url: result.url`.
- [OPEN] **C-MAJOR-1** `src/components/EditorTable.tsx:2280-2289` — `result.durationSeconds` not forwarded as `durationMs` to `emitCellAudioAttach` → `cell_audio.duration_ms = NULL`, breaks duration-dependent UI. **Fix:** `durationMs: Math.round(result.durationSeconds * 1000)`.
- [OPEN] **C-MINOR-1** `src/components/EditorTable.tsx:2255-2259` — the `SWARM-TODO(tts-cell-attach)` comment is FACTUALLY WRONG: server projection (event-projection.ts:755-811) already `SET selected=0` on siblings + new clip `selected=1`. Auto-select already happens. **Fix:** DELETE the comment (do NOT add emitCellAudioSelect — would be redundant).
- [OK] C-MINOR-2 unmount guard absent in handleOmniTts — matches existing handleTranscribe pattern, React 18 tolerant, not a regression. Skip.
- [OK] **EditorTable regression: CLEAR** — only additive (imports + RailButton + handler + state); no existing logic/deps/JSX altered; user's transcribe work untouched.
- [OK] UsageRollup/UsageSection: CLEAR — cancelled-flag cleanup, 403→hide, orgId in deps.
