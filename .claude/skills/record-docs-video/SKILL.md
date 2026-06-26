---
name: record-docs-video
description: Record a clarity-first documentation/how-to video of the LIVE app — a point-and-click walkthrough with a programmatic cursor, click ripples, zoom-into-click, and captions — using the e2e/recordings Showcase harness in "doc" mode. Use when asked to "make a documentation video", "record a walkthrough / how-to / tutorial video", "show how to do X in the app on video", or to capture a feature's steps as real footage. For the broader announce+docs+market launch loop use distribution-cycle; for hype trailers use record-promo-video.
---

# Record a documentation video (doc mode)

Produces real footage of the live app teaching a flow: a big cursor leads the eye, clicks ripple, the region of interest magnifies, captions narrate. Output: `<slug>.webm` + `<slug>.mp4` + storyboard. NOT stitched screenshots. Canonical example: `e2e/recordings/specs/demo-curated-doc.showcase.ts`. Full harness docs: `e2e/recordings/README.md`. Umbrella loop: the `distribution-cycle` skill.

## Quick start

1. Write `e2e/recordings/specs/<slug>.showcase.ts` (see template below).
2. `WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE=postgresql://aquilla:aquilla@127.0.0.1:5432/aquilla_dev npm run record -- -g "<test title>"`
3. Confirm `e2e/recordings/output/<slug>.storyboard.json` has `verified: true` and a `video.webm` exists.
4. `npm run record:assemble -- --slug <slug>` → MP4 + edit-list (add `--vo` for narration). The assembler runs a **fidelity check** (below) and logs `fidelity OK` or a `⚠ FIDELITY` warning — read it.

## Spec shape

```ts
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
    await show.chapter("Step name", "lower-third subtitle")
    await show.caption("what to do")                      // doubles as VO script
    await show.zoomTo(SEL, { scale: 1.6 }); await show.click(SEL); await show.zoomReset()
    await expect(page.getByText(MONEY_MOMENT)).toBeVisible()  // assert it's REAL
    verified = true
  } catch (e) { await show.caption("…demo environment."); }
  finally { await show.save(verified) }
})
```

## Showcase doc toolkit (`e2e/recordings/helpers/showcase.ts`)
`chapter(title, sub)` lower-third · `caption(text)` subtitle+VO · `beat(ms)` let it land · `point(t)` glide+ring · `click(t)` glide+ripple+real click · `zoomTo(t,{scale})` / `zoomReset()`. Target `t` = `@label` (→`[data-showcase="label"]`, see `docs/distribution/SHOWCASE-LABELS.md`), a raw CSS selector, or `{x,y}`. Prefer `@labels`; add them to components for new surfaces.

## Gotchas (all five bite — learned the hard way)
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
