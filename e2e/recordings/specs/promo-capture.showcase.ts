import { test, expect, request as pwRequest } from "@playwright/test"
import { injectSession, type PersistedSession } from "../../helpers/auth"
import { Workspace } from "../../helpers/page-objects/Workspace"
import { mkdirSync, rmSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const APP_STILLS = path.resolve(__dirname, "../output/promo/app")

const AUTH_BASE =
  process.env.VITE_AUTH_BASE ?? process.env.VITE_FRONTIER_BASE ?? "http://127.0.0.1:8787"

/**
 * Promo capture — the "real heart" of the deterministic trailer.
 *
 * This is NOT a storyboard take; it grabs a sequence of clean, chrome-free
 * stills of the REAL curated app (via the marketing login) into
 * output/promo/app/. The deterministic composition (scripts/promo/compose.html)
 * then composites those stills behind motion graphics + code-synth audio
 * (`npm run promo`). Keeping capture here means it reuses the exact same booted
 * stack, session, and page objects as every other recording — the footage is
 * real, not mocked.
 */
test("Promo capture · curated app stills for the trailer", async ({ page }) => {
  // fresh stills dir
  rmSync(APP_STILLS, { recursive: true, force: true })
  mkdirSync(APP_STILLS, { recursive: true })

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
  await page.goto("/project/demo-john/editor")
  await page.waitForLoadState("networkidle")

  const ws = new Workspace(page)
  await page.locator('[data-showcase="sidebar.file"]').first().click()
  await ws.waitForEditor()
  await expect(page.locator("[data-cell-id]").first()).toBeVisible()

  let shot = 0
  const grab = async () => {
    await page.screenshot({ path: path.join(APP_STILLS, `shot${String(shot++).padStart(2, "0")}.png`) })
  }
  // Visual-only zoom on #root (mirrors the showcase helper) for cinematic stills.
  const zoom = async (scale: number, sel: string) => {
    await page.evaluate(
      ([scale, sel]) => {
        const root = document.getElementById("root")
        const el = document.querySelector(sel) as HTMLElement | null
        if (!root || !el) return
        const rb = root.getBoundingClientRect()
        const eb = el.getBoundingClientRect()
        root.style.transition = "transform .01s"
        root.style.transformOrigin = `${eb.left + eb.width / 2 - rb.left}px ${eb.top + eb.height / 2 - rb.top}px`
        root.style.transform = `scale(${scale})`
      },
      [scale, sel] as const,
    )
    await page.waitForTimeout(250)
  }
  const unzoom = async () => {
    await page.evaluate(() => {
      const root = document.getElementById("root")
      if (root) root.style.transform = "none"
    })
    await page.waitForTimeout(150)
  }

  // A scripted sequence of hero stills — wide context → intimate detail.
  await grab() // full editor, top of John 1
  await zoom(1.5, '[data-showcase="editor.source"]')
  await grab() // source/target pairing, magnified
  await unzoom()
  await zoom(2.0, '[data-showcase="cell.health"]')
  await grab() // validation detail
  await unzoom()
  await page.mouse.wheel(0, 320)
  await page.waitForTimeout(250)
  await grab() // scrolled — more verses
  await zoom(1.5, '[data-cell-id]')
  await grab()
  await unzoom()
  await page.mouse.wheel(0, -320)
  await page.waitForTimeout(250)
  await grab() // back to top, settled

  expect(shot).toBeGreaterThanOrEqual(5)
  console.log(`[promo-capture] wrote ${shot} stills → ${APP_STILLS}`)
})
