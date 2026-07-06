import { test, expect, request as pwRequest } from "@playwright/test"
import { injectSession, type PersistedSession } from "../../helpers/auth"
import { Workspace } from "../../helpers/page-objects/Workspace"
import { Showcase } from "../helpers/showcase"

// auth-worker base (node-side). The marketing login lives here and seeds the
// curated project server-side, so the browser only ever does GET reads to
// hydrate content — which is exactly the path that works reliably.
const AUTH_BASE =
  process.env.VITE_AUTH_BASE ?? process.env.VITE_FRONTIER_BASE ?? "http://127.0.0.1:8787"

/**
 * Demo · Curated content — see auth-worker/src/routes/marketing-seed.ts.
 *
 * The marketing login stands up a *populated* project (John 1, paired
 * English→French verses, validated cells) so footage shows the real product
 * full of real content — no empty states, no hand-entry.
 *
 * We mint the demo session via a node→worker request (reliable) and inject it,
 * so the browser only reads. Resilient + always finalizes a real .webm.
 */
test("Demo · Curated John translation — a populated project, instantly", async ({ page }) => {
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
    feature: "curated-content",
    title: "A real translation project — populated, polished, instant.",
    cta: "Aquilla — explore a fully-loaded project the moment you land.",
  })

  let verified = false
  try {
    await page.goto("/project/demo-john")
    await page.waitForLoadState("networkidle")
    await show.chapter("John — Plainspeak Draft", "A curated project, already full of work.")
    await show.caption("No empty states — real source, real translation.")

    const ws = new Workspace(page)
    await ws.openFileBySubstring("John")
    await ws.waitForEditor()
    await show.chapter("Source ↔ target, verse by verse", "John 1 · English → French.")
    await show.caption("Validated cells show a healthy translation at a glance.")
    await show.beat(1500)

    const cell = (await ws.readCell(0)).toLowerCase()
    verified = /beginning|commencement|word|parole/.test(cell)
    await show.caption(
      verified
        ? "Real content, instantly — this is your team's work, alive on screen."
        : "Curated demo content, ready to explore.",
    )
    await show.beat(1500)
  } catch (err) {
    console.log(`[showcase] demo take degraded: ${(err as Error).message}`)
    await show.caption("Curated demo — full content renders in the demo environment.")
    await show.beat(1000)
  } finally {
    await show.save(verified)
  }
})
