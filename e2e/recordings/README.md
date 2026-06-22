# Showcase recordings

Real footage of the **live app**, driven by Playwright, for announcements, docs, and marketing. This reuses the e2e harness (seeded backend, dev auth, page objects) so recordings exercise the same flows our tests do — the value moment in a video is the same one a test asserts. No mockups, no fabricated screens.

## How it fits the distribution cycle

```
PERSONAS.md ──▶ showcase spec ──▶ npm run record ──▶ output/<slug>.webm + <slug>.storyboard.json
                  (drives live app,                          │
                   burns captions/chapters)                  ▼
                                          npm run record:assemble ──▶ <slug>.mp4 + <slug>.editlist.json (+ vo.mp3)
                                                                        │
                                                                        ▼
                                              HyperFrames/Remotion title cards ──▶ human gate ──▶ Postiz schedule
```

See `docs/distribution/DISTRIBUTION-CYCLE.md` for the full loop and `docs/distribution/PERSONAS.md` for who each take is for.

## Run it

```bash
npm run record                 # record all *.showcase.ts against the live stack
npm run record -- -g "P1"      # just the P1 take
npm run record:assemble        # transcode newest take + emit edit-list/cuts
npm run record:assemble -- --slug p1-field-translator__local-first-editing --vo
```

`record` boots the same 8-step backend as `npm run test:e2e` (via `scripts/e2e-up.ts` with `E2E_CONFIG` pointed at `playwright.config.recordings.ts`), then runs the showcase specs with **video always on**, a fixed 1280×800 frame, and deliberate pacing (`RECORD_SLOWMO`, default 350ms). Output lands in `e2e/recordings/output/`.

## Write a new take

1. Add/confirm the persona + money moment + mapped journey in `docs/distribution/PERSONAS.md`.
2. Create `specs/<persona-slug>.showcase.ts`. Use the **multi-user fixtures** (`alice`/`bob`) and existing **page objects** — drive the journey the persona's row describes, nothing more.
3. Wrap it with the `Showcase` helper: `chapter()` for lower-thirds, `caption()` for the subtitle/VO script, `beat()` to let a moment land, `save()` at the end.
4. **Assert the value moment is real** (an `expect`). A take is only shippable if the thing you're claiming actually happened on screen — same discipline as `verify-dev-change`.
5. If the underlying journey is currently `test.fixme` in the e2e suite, mark the showcase `test.fixme` too (don't record a broken flow) and note the blocking issue.

## Two profiles: docs vs promo

Set `mode` on the `Showcase` options (recorded in the storyboard so the assembler can pick pacing/framing):

- **`mode: "doc"` — clarity-first.** Teaches. Use the documentation toolkit to lead the viewer's eye:
  - `point(target)` — glide the big programmatic cursor to a target and pulse a ring (no click).
  - `click(target)` — glide, pulse, then perform the **real** DOM click.
  - `zoomTo(target, { scale })` — magnify the app around a target (transforms `#root` only, so captions/brand stay crisp); `zoomReset()` eases back. Always zoom from an unzoomed state.
  - `target` is a CSS selector (resolved to its centre) **or** a `{ x, y }` point — compute a point from any Playwright locator for rows/controls without a stable selector.
  - See `specs/demo-curated-doc.showcase.ts` for the canonical doc take over the curated project.
- **`mode: "promo"` (default) — amaze-first.** Fast cuts, big claims; the trailer pipeline. `specs/demo-curated.showcase.ts` is the populated-project promo take.

Both drive the **real** app via the marketing login (`auth-worker/src/routes/marketing-seed.ts`), which seeds curated content server-side so the browser only reads.

## ⚠️ Don't `git push` while a recording is running

The `pre-push` husky hook runs `npm run test:e2e:smoke`, which boots its **own** e2e stack on ports `8787`/`8788` — the same ports the recording stack uses. Running both at once kills one of the auth-workers (the recording then fails with `ECONNREFUSED 127.0.0.1:8787`). **Let the recording finish, confirm `e2e-up` has exited, then push.**

## Anonymization

Always record against seeded/synthetic data (`dev-project`, `sample.md`, invented persona names). Never record real customer projects, names, or corpora.

## Output (git-ignored)

`e2e/recordings/output/` holds large binaries (`.webm`, `.mp4`, `.zip`, traces) — keep them out of git; publish via the distribution pipeline, not the repo.
