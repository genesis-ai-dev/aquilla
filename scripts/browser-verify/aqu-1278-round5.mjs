// AQU-1278 round 5, on the live stack: "Go to first …" lands on a cell for
// every shape of unit, audio included — the four clicks Sam asked about.
//
//   node scripts/browser-verify/aqu-1278-round5.mjs
import { chromium } from "@playwright/test"

const WEB = "http://127.0.0.1:5173"
const IDENTITY = "http://127.0.0.1:8788"
const checks = []
const check = (ok, what, detail = "") => {
  checks.push(ok)
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${what}${detail ? `  — ${detail}` : ""}`)
}

async function main() {
  const { access_token, username } = await (await fetch(`${IDENTITY}/__dev__/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "dev" }),
  })).json()
  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1040 } })
  await ctx.addInitScript(({ token, username }) => {
    const s = { jwt: token, username, createdAt: new Date().toISOString() }
    const e = { active: username, sessions: { [username]: s }, dataOwner: username }
    const q = indexedDB.open("frontier", 1)
    q.onupgradeneeded = () => { const d = q.result; if (!d.objectStoreNames.contains("session")) d.createObjectStore("session") }
    q.onsuccess = () => q.result.transaction("session", "readwrite").objectStore("session").put(e, "envelope")
  }, { token: access_token, username })
  const page = await ctx.newPage()

  const openBoard = async (projectId) => {
    await page.goto(`${WEB}/projects/${projectId}`, { waitUntil: "domcontentloaded" })
    const board = page.locator('[data-testid="plan-board"]').first()
    await board.waitFor({ timeout: 60_000 })
    await page.waitForTimeout(4000)
    return board
  }
  /** Click a link, catch the editor URL it navigates to, come back. */
  const landing = async (clickable) => {
    await Promise.all([
      page.waitForURL(/\/editor\//, { timeout: 30_000 }),
      clickable.click(),
    ])
    const url = new URL(page.url())
    return { path: url.pathname, cellId: url.searchParams.get("cellId"), flash: url.searchParams.get("flash") }
  }
  const inspectorLink = async (board, rowTestId) => {
    await board.getByTestId(`plan-row-${rowTestId}`).click()
    await page.waitForTimeout(2000)
    const link = page.getByTestId("plan-go-to-first-open")
    return { text: await link.innerText(), landing: await landing(link) }
  }

  // ── Exodus: text finished, four takes missing, due soon ───────────────────
  console.log("\ndev-plan-1278 — Exodus is short on audio only")
  let board = await openBoard("dev-plan-1278")
  const exo = await inspectorLink(board, "plan-1278-audio-EXO")
  check(/Go to first unrecorded/.test(exo.text), "the inspector offers the audio link", exo.text)
  check(exo.landing.cellId != null && exo.landing.flash === "1",
    "…and it lands on a cell, flashed", JSON.stringify(exo.landing))
  check(/EXO/.test(exo.landing.cellId ?? ""), "…in Exodus", exo.landing.cellId ?? "")

  // ── Genesis: text link unchanged ──────────────────────────────────────────
  board = await openBoard("dev-plan-1278")
  const gen = await inspectorLink(board, "plan-1278-text-GEN")
  check(/Go to first unvalidated/.test(gen.text) && /GEN/.test(gen.landing.cellId ?? ""),
    "Genesis still lands on its first unvalidated cell", `${gen.text} → ${gen.landing.cellId}`)

  // ── Subtitles: Episode 4's five missing cues, through the links ───────────
  console.log("\ndev-plan-1278-vtt — Episode 4's link follows the cue sheet")
  board = await openBoard("dev-plan-1278-vtt")
  const e4 = await landing(board.getByTestId("plan-shortfall-plan-1278-s1e4-"))
  check(e4.cellId != null && /^s1e4-\d+$/.test(e4.cellId),
    "the row link lands on a SUBTITLE cell linked to an unrecorded cue", JSON.stringify(e4))
  board = await openBoard("dev-plan-1278-vtt")
  const e1 = await landing(board.getByTestId("plan-shortfall-plan-1278-s1e1-"))
  check(e1.cellId === "s1e1-1", "Episode 1's text link lands on its first unvalidated cue", JSON.stringify(e1))

  // ── Documents: a Word file, no chapters at all ────────────────────────────
  console.log("\ndev-plan-1278-docs — a Word file's link lands on a cell now")
  board = await openBoard("dev-plan-1278-docs")
  const route = await inspectorLink(board, "plan-1278-route-")
  check(route.landing.cellId === "route-1",
    "northern-route.docx lands on its first unvalidated cell (it used to open the file)",
    JSON.stringify(route.landing))

  await browser.close()
  const failed = checks.filter((c) => !c).length
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`)
  if (failed) process.exitCode = 1
}
main().catch((e) => { console.error(e); process.exit(1) })
