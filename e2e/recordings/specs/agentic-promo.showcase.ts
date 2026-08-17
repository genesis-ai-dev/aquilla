import { test, expect, request as pwRequest } from "@playwright/test"
import { injectSession, type PersistedSession } from "../../helpers/auth"
import { Workspace } from "../../helpers/page-objects/Workspace"
import { Showcase } from "../helpers/showcase"

/**
 * SHOT LIST — agentic-promo (the "wow moments" reel for the XITL promo)
 * Area: Agent / Editor / Rules / Terminology
 *
 * Real footage of the live curated project (marketing login, demo-john,
 * John 1 EN→FR, 5/6 translated). Each chapter becomes a clip window the
 * montage assembler (scripts/promo/montage.ts) trims out and intercuts with
 * kinetic type.
 *
 * Must demonstrate:
 * [ ] AG-01: A real project already 83% translated (one verse blank).
 * [ ] AG-02: Type /draft — the agent drafts the missing verse.
 * [ ] AG-03: Nothing lands until a human clicks Apply. (expert in the lead)
 * [ ] AG-04: The verse fills; the file completes to 100%. (MONEY MOMENT)
 * [ ] AG-05: Rules — shared consistency guardrails.
 * [ ] AG-06: Terminology — one agreed rendering.
 *
 * Money moment: /draft → Apply → 100%, under human control.
 * Kept deliberately lean so the take finishes < 2min and save() always runs.
 */

const AUTH_BASE =
  process.env.VITE_AUTH_BASE ?? process.env.VITE_FRONTIER_BASE ?? "http://127.0.0.1:8787"

test("Agentic hero · the agent drafts, the expert leads", async ({ page }) => {
  test.setTimeout(300_000)

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
    persona: "agentic",
    feature: "expert-in-the-lead",
    title: "Aquilla — the agent drafts, the expert leads.",
    cta: "Aquilla — expert in the lead.",
    mode: "doc",
  })

  const ws = new Workspace(page)
  let verified = false

  try {
    // ── AG-01: a real project, already most of the way there ──────────────
    await page.goto("/project/demo-john/editor")
    await page.locator('[data-showcase="sidebar.file"]').first().click()
    await ws.waitForEditor()
    await show.chapter("A real project", "John 1 · English → French · 83% translated.")
    await show.zoomTo('[data-showcase="sidebar.file"]', { scale: 1.7 })
    await show.caption("The work is already here — one verse still blank.")
    await show.zoomReset()

    // ── AG-02: turn the agent loose ───────────────────────────────────────
    await show.chapter("Meet the agent", "Not a chatbot — a translator that acts.")
    await page.getByRole("button", { name: "Agent", exact: true }).click()
    const composer = page.getByRole("textbox", { name: "Ask the agent" })
    await composer.click()
    await composer.pressSequentially("/draft", { delay: 70 })
    await show.caption("One command: /draft.")
    await page.keyboard.press("Enter")

    // ── AG-03: nothing lands until a human clicks Apply ───────────────────
    await show.chapter("You stay in the lead", "AI drafts are staged — never auto-applied.")
    const applyBtn = page.getByRole("button", { name: "Apply", exact: true }).first()
    await expect(applyBtn).toBeVisible({ timeout: 120_000 })
    await show.caption("The agent drafts the missing verse. You approve it.")
    await show.point('button:has-text("Apply")')
    await applyBtn.click()

    // ── AG-04: the file completes — MONEY MOMENT ──────────────────────────
    // Wait for the AUTHORITATIVE completion signal on screen (the editor footer
    // flips 5→6 translated) before filming the payoff — the cells/files
    // projection lands a beat after Apply, so zooming immediately shows a stale
    // 83% bar.
    await expect
      .poll(async () => (await ws.readTargetText(5)).trim().length, { timeout: 45_000 })
      .toBeGreaterThan(0)
    await expect(page.getByText(/6\s*translated|100\s*%/i).first())
      .toBeVisible({ timeout: 20_000 })
    verified = true
    // The agent dock replaced the Files list in the sidebar — switch back so
    // the file's now-full progress bar is on screen before we zoom.
    await page.getByRole("button", { name: "Files", exact: true }).click()
    const fileRow = page.locator('[data-showcase="sidebar.file"]').first()
    await expect(fileRow).toBeVisible({ timeout: 15_000 })
    await show.chapter("Done, together", "The last verse fills — 100% translated.")
    await show.zoomTo('[data-showcase="sidebar.file"]', { scale: 1.9 })
    await show.caption("The agent did the typing. You did the deciding.")
    await show.beat(1100)
    await show.zoomReset()

    // ── AG-05: rules — shared consistency guardrails ──────────────────────
    try {
      await page.goto("/project/demo-john/rules")
      const builtin = page.locator('[data-testid="builtin-row"]').first()
      await expect(builtin).toBeVisible({ timeout: 20_000 })
      await show.chapter("Rules everyone shares", "Consistency, checked on every edit.")
      await show.zoomTo('[data-testid="builtin-row"]', { scale: 1.3 })
      await show.caption("Numbers, punctuation, placeholders — verified automatically.")
      await show.zoomReset()
    } catch (e) {
      console.log(`[agentic-promo] rules skipped: ${(e as Error).message}`)
    }

    // ── AG-06: terminology — one agreed rendering ─────────────────────────
    try {
      await page.goto("/project/demo-john/terminology")
      const addTerm = page.getByRole("button", { name: /Add term/i }).first()
      await expect(addTerm).toBeVisible({ timeout: 20_000 })
      await show.chapter("One shared vocabulary", "Agree a term once — keep it everywhere.")
      await show.click('button:has-text("Add term")')
      const src = page.getByPlaceholder(/New source term/i).first()
      if (await src.isVisible({ timeout: 4_000 }).catch(() => false)) {
        await src.pressSequentially("Word", { delay: 80 })
        const rendering = page.getByPlaceholder(/rendering/i).first()
        if (await rendering.isVisible({ timeout: 2_000 }).catch(() => false)) {
          await rendering.pressSequentially("Parole", { delay: 80 })
        }
        await show.caption("Capture a term so every translator renders it the same way.")
      }
    } catch (e) {
      console.log(`[agentic-promo] terminology skipped: ${(e as Error).message}`)
    }

    await show.chapter("Expert in the lead", "AI drafts. You decide. Every word held.")
    await show.beat(1100)
  } catch (err) {
    console.log(`[agentic-promo] degraded: ${(err as Error).message}`)
  } finally {
    await show.save(verified)
  }
})
