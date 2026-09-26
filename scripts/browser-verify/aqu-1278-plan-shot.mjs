// AQU-1278: screenshots of the live plan board against the seeded fixture, so
// the build can be held next to the approved mockup. Needs `pnpm dev` up on the
// default ports and `scripts/seed-plan-fixture.ts` run.
//
//   node scripts/browser-verify/aqu-1278-plan-shot.mjs [outDir]
import { chromium } from "@playwright/test"
import { mkdirSync } from "node:fs"
import { join } from "node:path"

const WEB = "http://127.0.0.1:5173"
const IDENTITY = "http://127.0.0.1:8788"
const PROJECT = "dev-plan-1278"
const OUT = process.argv[2] ?? "/tmp/aqu-1278-shots"
mkdirSync(OUT, { recursive: true })

async function main() {
  const { access_token, username } = await (await fetch(`${IDENTITY}/__dev__/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "dev" }),
  })).json()

  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1040 }, deviceScaleFactor: 2 })
  await ctx.addInitScript(({ token, username }) => {
    const s = { jwt: token, username, createdAt: new Date().toISOString() }
    const e = { active: username, sessions: { [username]: s }, dataOwner: username }
    const q = indexedDB.open("frontier", 1)
    q.onupgradeneeded = () => { const d = q.result; if (!d.objectStoreNames.contains("session")) d.createObjectStore("session") }
    q.onsuccess = () => q.result.transaction("session", "readwrite").objectStore("session").put(e, "envelope")
  }, { token: access_token, username })

  const page = await ctx.newPage()
  const errors = []
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`))
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`) })

  await page.goto(`${WEB}/projects/${PROJECT}`, { waitUntil: "domcontentloaded" })
  const board = page.locator('[data-testid="plan-board"]').first()
  await board.waitFor({ timeout: 60_000 })
  // Let the rows' progress prefetch settle so the "where" line has data.
  await page.waitForTimeout(5000)

  const shot = async (name, opts = {}) => {
    await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: opts.fullPage ?? false })
    console.log(`  ${name}.png`)
  }

  await board.scrollIntoViewIfNeeded()
  await shot("01-board-top")
  await shot("02-board-full", { fullPage: true })

  const clickRow = async (name) => {
    const row = board.getByText(name, { exact: true }).first()
    await row.scrollIntoViewIfNeeded()
    await row.click()
    await page.waitForTimeout(2500)
  }

  await clickRow("Genesis")
  await shot("03-genesis-inspector", { fullPage: true })

  // The chapter card: click chapter 12, which the fixture leaves two short.
  const tile12 = page.locator('[data-testid="plan-tile-GEN 12"]')
  if (await tile12.count()) {
    await tile12.scrollIntoViewIfNeeded()
    await tile12.click()
    await page.waitForTimeout(2500)
    await shot("04-genesis-chapter-12", { fullPage: true })
    const card = page.locator('[data-testid="plan-chapter-detail"]')
    if (await card.count()) console.log(`  chapter card: ${(await card.innerText()).replace(/\n/g, " | ")}`)
  } else {
    console.log("  (plan-tile-GEN 12 not found — chapter click skipped)")
  }

  await clickRow("Deuteronomy")
  await shot("05-deuteronomy-inspector", { fullPage: true })

  await clickRow("Leviticus")
  await shot("06-leviticus-inspector", { fullPage: true })

  await clickRow("Mark")
  await shot("07-mark-inspector", { fullPage: true })

  await clickRow("Titus")
  await shot("08-titus-inspector", { fullPage: true })

  if (errors.length) console.log("page errors:\n  " + errors.slice(0, 10).join("\n  "))
  await browser.close()
}
main().catch((e) => { console.error(e); process.exit(1) })
