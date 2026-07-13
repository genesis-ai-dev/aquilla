---
name: record-docs-video
description: Record a clarity-first documentation/how-to video of the LIVE app — a point-and-click walkthrough with a programmatic cursor, click ripples, zoom-into-click, and captions — using the e2e/recordings Showcase harness in "doc" mode. Use when asked to "make a documentation video", "record a walkthrough / how-to / tutorial video", "show how to do X in the app on video", or to capture a feature's steps as real footage. For the broader announce+docs+market launch loop use distribution-cycle; for hype trailers use record-promo-video.
---

# Record a documentation video (doc mode)

Produces real footage of the live app teaching a flow: a big cursor leads the eye, clicks ripple, the region of interest magnifies, captions narrate. Output: `<slug>.webm` + `<slug>.mp4` + storyboard. NOT stitched screenshots. Canonical example: `e2e/recordings/specs/demo-curated-doc.showcase.ts`. Full harness docs: `e2e/recordings/README.md`. Umbrella loop: the `distribution-cycle` skill.

---

## Step 0 — Plan WHAT to show (content coverage)

**This is the most important step.** The #1 failure mode is jumping straight to code and ending up with a video that looks polished but skips half the features. Before writing a single line of spec code:

1. **Enumerate the features/flows this video must cover.** Source them from:
   - `docs/FEATURE-STORIES.csv` — filter by the Area this video covers (the `Feature` + `UserStory` + `ExpectedBehavior` columns are your script).
   - `docs/FEATURE-VIDEOS-PLAN.md` — each planned video lists which features it must demonstrate.
   - The user's request — they may name specific flows.
   - The persona's money moment (`docs/distribution/PERSONAS.md`) — the climax of the video.

2. **Write a shot list BEFORE the spec.** A plain checklist in a comment block at the top of the spec file:
   ```ts
   /**
    * SHOT LIST — editor-translate-cell
    * Area: Editor
    *
    * Must demonstrate:
    * [ ] EC-01: Open a file from the sidebar
    * [ ] EC-03: Edit a target cell (type, blur to save)
    * [ ] EC-05: Cell health indicator updates after edit
    * [ ] FRT-27: Source text is read-only
    * [ ] VH-12: Validation warnings appear inline
    * [ ] VH-01: Health pill shows rollup status
    *
    * Money moment: Type a translation → health updates → it persists on reload
    * Estimated duration: ~40s
    */
   ```

3. **Each feature in the shot list becomes a chapter or beat in the spec.** Map them 1:1:
   - 1 feature = at minimum 1 `show.caption()` that names what's happening + 1 visible interaction proving it works.
   - Complex features get a `show.chapter()` + multiple beats.
   - The money moment gets a `zoomTo()` + a pause (`beat(2000)`) to let it land.

4. **After recording, verify coverage.** Check off every item in the shot list against the storyboard JSON. If an item is missing, re-record — don't ship a video that skips listed features.

### Coverage verification (post-record)

After `npm run record`, inspect the storyboard:
```bash
# List all chapters + captions from the storyboard
jq '.events[] | select(.type == "chapter" or .type == "caption") | .text' \
  e2e/recordings/output/<slug>.storyboard.json
```

Cross-reference against your shot list. Every `[ ]` should map to at least one storyboard event. If it doesn't, the video is incomplete.

---

## Step 1 — Quick start (recording)

1. Write `e2e/recordings/specs/<slug>.showcase.ts` (see template below). **Include the shot list comment block from Step 0.**
2. `WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE=postgresql://aquilla:***@127.0.0.1:5432/aquilla_dev npm run record -- -g "<test title>"`
3. Confirm `e2e/recordings/output/<slug>.storyboard.json` has `verified: true` and a `video.webm` exists.
4. **Verify coverage** — run the storyboard check from Step 0.
5. `npm run record:assemble -- --slug <slug>` → MP4 + edit-list (add `--vo` for narration). The assembler runs a **fidelity check** (below) and logs `fidelity OK` or a `⚠ FIDELITY` warning — read it.

## Spec shape

```ts
/**
 * SHOT LIST — <slug>
 * Area: <area name>
 *
 * Must demonstrate:
 * [ ] FEAT-ID: Description
 * [ ] FEAT-ID: Description
 * ...
 *
 * Money moment: <what the viewer should feel proved>
 * Estimated duration: ~Ns
 */
test("Demo · <what the viewer learns>", async ({ page }) => {
  test.setTimeout(180_000)
  await page.context().addCookies([{ name: "aq_hint", value: "1", url: "http://127.0.0.1:5173" }])
  await page.goto("/__marketing/login")
  await page.waitForURL(/\/project\/demo-john/, { timeout: 45_000 })
  const show = new Showcase(page, { persona, feature, title, cta, mode: "doc" })
  let verified = false
  try {
    await page.goto("/")                                  // or a deep route
    await page.locator(SEL).first().waitFor({ state: "visible" })

    // --- FEAT-ID: Description ---
    await show.chapter("Step name", "lower-third subtitle")
    await show.caption("what to do")                      // doubles as VO script
    await show.zoomTo(SEL, { scale: 1.6 }); await show.click(SEL); await show.zoomReset()

    // --- FEAT-ID: Next feature ---
    await show.chapter("Next step", "subtitle")
    await show.caption("explanation")
    // ... interact + assert ...

    // --- MONEY MOMENT ---
    await show.chapter("The payoff", "subtitle")
    await show.zoomTo(MONEY_SEL, { scale: 1.8 })
    await show.beat(2000)                                 // let it breathe
    await expect(page.getByText(MONEY_MOMENT)).toBeVisible()
    await show.zoomReset()

    verified = true
  } catch (e) { await show.caption("…demo environment."); }
  finally { await show.save(verified) }
})
```

### Pacing guidelines (why videos feel rushed or incomplete)

| Beat type | Duration | When to use |
|-----------|----------|-------------|
| Feature intro (chapter) | 1.5–2s | New section / new concept |
| Caption explaining what's happening | 2–3s | Every interaction |
| Zoom + interact | 1.5s zoom-in, action, 1s hold, 1s zoom-out | Key interactions |
| Money moment | 3–5s hold (use `beat(3000)`+) | The payoff — let it LAND |
| Transition between features | 1s | FadeOut or navigate to next route |

**Common mistake:** cramming 8 features into 30s with no breathing room. Each feature needs ~5–8s minimum (caption + interaction + result). A 6-feature video should be ~40–50s, not 20s.

**Another common mistake:** showing the UI element but not proving it WORKS. Don't just point at the health pill — click a cell, type something wrong, and show the health pill turning red. The interaction IS the proof.

## Showcase doc toolkit (`e2e/recordings/helpers/showcase.ts`)
`chapter(title, sub)` lower-third · `caption(text)` subtitle+VO · `beat(ms)` let it land · `point(t)` glide+ring · `click(t)` glide+ripple+real click · `zoomTo(t,{scale})` / `zoomReset()`. Target `t` = `@label` (→`[data-showcase="label"]`, see `docs/distribution/SHOWCASE-LABELS.md`), a raw CSS selector, or `{x,y}`. Prefer `@labels`; add them to components for new surfaces.

## Reusing footage for promo videos

Doc-mode recordings are the **proof footage** that promo trailers need. When you record a doc video:
- The `.webm` master and assembled `.mp4` are usable as source clips for `record-promo-video`.
- The storyboard JSON contains chapter timestamps — the promo pipeline can use these to extract the most dramatic moments (the money moment, the "aha" beat).
- Design your money moment to also work as a promo clip: make it visually self-contained (no context needed from earlier chapters), emotionally clear, and ~3–5s long.

See `record-promo-video` for how doc footage feeds into the promo pipeline.

## Gotchas (all six bite — learned the hard way)
1. `record` (via `scripts/e2e-up.ts`) does NOT set the Hyperdrive PG var that `pnpm dev` sets → auth-worker times out at "boot 3/8". Export `WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` pointing at the running `aquilla-dev-pg`.
2. `"/"` redirects to `/homepage` unless the `aq_hint=1` cookie is set (App.tsx `RootRedirect`), independent of session.
3. Authenticate by driving `/__marketing/login` + `waitForURL(/project/demo-john)` — it persists the session via the real store so OrgContext hydrates. Manual `injectSession` does not hydrate the org dashboard reliably.
4. NEVER `waitForLoadState("networkidle")` on org/project pages — the sync worker holds a live connection so it never settles and burns the whole timeout. Use `locator.waitFor` / `expect().toBeVisible()`.
5. `zoomReset()` before interacting with anything outside the magnified region — a lingering `#root` transform fails Playwright actionability ("visible, enabled and stable").
6. **MP4 edge-crop:** the source `.webm` is the master. ffmpeg used to infer an SD colourspace (`bt470bg`) and no explicit pixel aspect, so some players OVERSCAN-CROP the MP4's edges while the `.webm` shows them in full. The assembler now tags BT.709 + `setsar=1` to render 1:1. If a player still crops the MP4, prefer the `.webm`.

## Fidelity check (regression)

The assembled MP4 must faithfully reproduce the source `.webm` — no clipped edges, no rescale. `scripts/assemble-showcase.ts` verifies this automatically after transcode (`verifyFidelity`): identical pixel dimensions + a frame SSIM ≥ 0.98 at mid-take. A `⚠ FIDELITY` warning means **ship the `.webm`** until the MP4 is corrected. To eyeball it manually (the `.webm` is authoritative):

```sh
W=$(ls -t e2e/recordings/output/*chromium*/video.webm | head -1); M=e2e/recordings/output/<slug>.mp4
for f in "$W" "$M"; do ffmpeg -hide_banner -i "$f" 2>&1 | grep "Video:"; done   # dims/SAR/DAR must match
ffmpeg -y -ss 5 -i "$W" -frames:v 1 -vf crop=260:70:1020:0 /tmp/w.png   # top-right corner (brand bug)
ffmpeg -y -ss 5 -i "$M" -frames:v 1 -vf crop=260:70:1020:0 /tmp/m.png   # the AQUILLA bug margin must match
```

## Rules
- Real footage only; assert the money moment (`verified`). Don't ship a degraded take.
- Anonymize: seeded data, invented names, never real customer corpora.
- Don't `git push` while recording (pre-push smoke fights for the ports). Output is git-ignored.
- **Coverage over polish.** A video that shows all 6 features at decent pacing beats a gorgeous video that only shows 3. Get the content right first, then refine timing.
