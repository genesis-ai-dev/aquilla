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

## Lens B — Contracts / permissions (agent a57938803350892d1, PENDING)
<!-- await -->

## Lens C — Races / regressions / EditorTable (agent af508408b0a48cba9, PENDING)
<!-- await -->
