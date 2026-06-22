import { test, expect, request as pwRequest, type Locator } from "@playwright/test"
import { injectSession, type PersistedSession } from "../../helpers/auth"
import { Workspace } from "../../helpers/page-objects/Workspace"
import { Showcase } from "../helpers/showcase"

// auth-worker base (node-side). The marketing login seeds the curated project
// server-side, so the browser only does GET reads to hydrate content.
const AUTH_BASE =
  process.env.VITE_AUTH_BASE ?? process.env.VITE_FRONTIER_BASE ?? "http://127.0.0.1:8787"

/**
 * Demo · Documentation walkthrough — the *clarity-first* profile of the
 * showcase toolkit (mode: "doc").
 *
 * Where the promo cut amazes, this cut teaches: a large programmatic cursor
 * leads the eye to each control, clicks are punctuated with a ripple, and the
 * region of interest is magnified with zoom-into-click — all over the REAL
 * curated project from the marketing login (see
 * auth-worker/src/routes/marketing-seed.ts). No mock-ups, no empty states.
 */
test("Demo · Documentation walkthrough — read a real project, step by step", async ({ page }) => {
  const ctx = await pwRequest.newContext()
  const r = await ctx.post(`${AUTH_BASE}/__marketing__/login`, { data: {} })
  expect(r.ok(), `marketing login failed: ${r.status()} ${await r.text()}`).toBeTruthy()
  const data = (await r.json()) as { access_token: string; username: string }
  await ctx.dispose()

  const session: PersistedSession = {
    jwt: data.access_token,
    username: data.username,
    createdAt: new Date().toISOString(),
  }
  await page.goto("/")
  await injectSession(page, session)

  const show = new Showcase(page, {
    persona: "demo-curated",
    feature: "documentation-walkthrough",
    title: "Aquilla, step by step — reading a real translation project.",
    cta: "Aquilla — your team's work, clear at every zoom level.",
    mode: "doc",
  })

  // Centre point of any Playwright locator, for cursor/zoom targets that aren't
  // a single stable CSS selector (sidebar rows, in-row controls).
  const centreOf = async (loc: Locator): Promise<{ x: number; y: number }> => {
    const b = await loc.boundingBox()
    if (!b) throw new Error("doc walkthrough: target not visible")
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
  }

  let verified = false
  try {
    await page.goto("/project/demo-john")
    await page.waitForLoadState("networkidle")
    await show.chapter("Open a project", "John — Plainspoken Draft · a curated demo project.")
    await show.caption("Every project opens to real content — source and target, side by side.")

    const ws = new Workspace(page)

    // 1) Lead the eye to the sidebar file, then open it with a punctuated click.
    const fileRow = page
      .locator("aside")
      .locator("div")
      .filter({ hasText: /John/i })
      .filter({ has: page.locator('button[aria-label="File actions"]') })
      .first()
    await show.point(await centreOf(fileRow))
    await show.caption("Click a file to open it.")
    await show.click(await centreOf(fileRow))
    await ws.waitForEditor()
    await show.beat(600)

    // 2) Zoom into the first verse so the source↔target pairing is unmistakable.
    await show.chapter("Source ↔ target, verse by verse", "John 1 · English → French.")
    await show.zoomTo("[data-cell-id]", { scale: 1.7 })
    await show.point("[data-cell-id]")
    await show.caption("Left: the source text. Right: your team's translation, cell by cell.")
    await show.beat(700)
    await show.zoomReset()

    // 3) Zoom to the health pill — the at-a-glance validation signal.
    const firstRow = ws.cellRow(0)
    const healthPill = firstRow.locator("button[title*='Health']").first()
    if (await healthPill.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await show.chapter("Validation at a glance", "Healthy cells are marked green.")
      await show.zoomTo(await centreOf(healthPill), { scale: 2.0 })
      await show.point(await centreOf(healthPill))
      await show.caption("Each cell carries a health signal — green means validated.")
      await show.beat(700)
      await show.zoomReset()
    }

    // Money moment: the curated content actually rendered.
    const cell = (await ws.readCell(0)).toLowerCase()
    verified = /beginning|commencement|word|parole/.test(cell)
    await show.chapter("That's the workspace", "Real content, real structure.")
    await show.caption(
      verified
        ? "Real content, real structure — that's how you read a project in Aquilla."
        : "Curated demo content, ready to explore.",
    )
    await show.beat(1200)
  } catch (err) {
    console.log(`[showcase] doc walkthrough degraded: ${(err as Error).message}`)
    await show.caption("Curated demo — full content renders in the demo environment.")
    await show.beat(1000)
  } finally {
    await show.save(verified)
  }
})
