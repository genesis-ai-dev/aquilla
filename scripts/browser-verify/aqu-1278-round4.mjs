// AQU-1278 round 4, on the live stack: the cue sheet's audio, the link's new
// home in the inspector, and the link on a dated board row.
//
// Needs `pnpm dev` up on the default ports and all three fixtures seeded
// (`scripts/seed-plan-fixture.ts`, `scripts/seed-plan-fixture-files.ts`). The
// last project it opens is the REAL `video-&-audio-test`, which nothing here
// seeds — it is the whole point of the round: a dubbing project made by the
// importer rather than by us.
//
//   node scripts/browser-verify/aqu-1278-round4.mjs [outDir]
import { chromium } from "@playwright/test"
import { mkdirSync } from "node:fs"
import { join } from "node:path"

const WEB = "http://127.0.0.1:5173"
const IDENTITY = "http://127.0.0.1:8788"
const OUT = process.argv[2] ?? "/tmp/aqu-1278-round4"
mkdirSync(OUT, { recursive: true })

const checks = []
const check = (ok, what, detail = "") => {
  checks.push({ ok, what, detail })
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${what}${detail ? `  — ${detail}` : ""}`)
}

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

  const shot = async (name) => {
    await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true })
    console.log(`     ${name}.png`)
  }

  const openBoard = async (projectId) => {
    await page.goto(`${WEB}/projects/${projectId}`, { waitUntil: "domcontentloaded" })
    const board = page.locator('[data-testid="plan-board"]').first()
    await board.waitFor({ timeout: 60_000 })
    // The rows prefetch their sections; the "where" line needs that settled.
    await page.waitForTimeout(5000)
    return board
  }

  // An element's text as ONE line, its line breaks turned into " | ".
  //
  // RUNS OF SEPARATORS COLLAPSE TO ONE. A bar's readout carries an sr-only
  // " | " between its two percentages (it is what a screen reader says in
  // place of the drawn rule), and `innerText` gives that its own line — so a
  // readout arrives here as "100%", "|", "98%" and naive joining produced
  // "100% | | | 98%". Every assertion below reads the VISIBLE text, where
  // there is exactly one divider, so the run collapses to match. Without
  // this the audio-readout check silently stopped asserting anything the day
  // the separator landed — which is why this is one helper and not three.
  const oneLine = (text) => text.replace(/\n/g, " | ").replace(/(?:\s*\|\s*)+/g, " | ")
  const rowText = async (board, name) =>
    oneLine(await board.getByTestId(`plan-row-${name}`).innerText())

  const openRow = async (board, testid) => {
    const row = board.getByTestId(`plan-row-${testid}`)
    await row.scrollIntoViewIfNeeded()
    await row.click()
    await page.waitForTimeout(2500)
  }

  // ── 1. The seeded subtitle project ────────────────────────────────────────
  console.log("\ndev-plan-1278-vtt — audio from the cue sheet")
  let board = await openBoard("dev-plan-1278-vtt")

  const e1 = await rowText(board, "plan-1278-s1e1-")
  check(/AUD/.test(e1) && /100%\s*\|\s*0%/.test(e1), "Episode 1 reads 100% recorded", e1)

  // The empty cue sheet. Its text is finished and signed off, so without the
  // sheet counting as an expectation this row reads "Nothing left" in Nearly
  // complete — and then moves backwards the moment somebody records a take.
  const e2 = await rowText(board, "plan-1278-s2e2-")
  check(!/Nothing left/.test(e2), "an empty cue sheet keeps a finished-text episode out of Nearly complete", e2)
  check(
    await board.getByTestId("plan-group-in_progress")
      .getByTestId("plan-row-plan-1278-s2e2-").count() > 0,
    "…and files it under In progress instead",
  )

  const e2s1 = await rowText(board, "plan-1278-s1e2-")
  check(!/to record/.test(e2s1), "an episode with no cue sheet is judged on text alone", e2s1)
  await shot("01-vtt-board")

  await openRow(board, "plan-1278-s1e1-")
  check(
    (await page.locator('[data-testid="plan-sections"]').count()) === 0,
    "a subtitle file's inspector has no chapter block at all",
  )
  const unitShortfall = page.locator('[data-testid="plan-unit-shortfall"]')
  check(await unitShortfall.count() > 0, "…but it does carry the shortfall line")
  check(
    await page.locator('[data-testid="plan-go-to-first-open"]').count() > 0,
    "…and the link into the editor, which it never used to have",
    await unitShortfall.innerText().catch(() => ""),
  )
  await shot("02-vtt-inspector")

  // ── 2. The seeded document project ───────────────────────────────────────
  console.log("\ndev-plan-1278-docs — a Word file with nothing to plan by")
  board = await openBoard("dev-plan-1278-docs")
  await openRow(board, "plan-1278-route-")
  check(
    (await page.locator('[data-testid="plan-sections"]').count()) === 0,
    "no chapter block, and no sentence explaining the absence",
  )
  check(
    await page.locator('[data-testid="plan-go-to-first-open"]').count() > 0,
    "the link is there instead",
  )
  await shot("03-docs-inspector")

  // ── 3. The Bible fixture: the dated row, and the link's new home ─────────
  console.log("\ndev-plan-1278 — the dated row keeps its link")
  board = await openBoard("dev-plan-1278")
  const jonah = board.locator('[data-testid^="plan-row-"]', { hasText: "Jonah" }).first()
  await jonah.scrollIntoViewIfNeeded()
  const jonahText = oneLine(await jonah.innerText())
  const jonahLink = jonah.locator('[data-testid^="plan-shortfall-"]')
  check(await jonahLink.count() > 0, "Jonah is overdue AND links to its remaining cells", jonahText)

  await openRow(board, "plan-1278-text-GEN")
  const summary = page.locator('[data-testid="plan-grid-summary"]')
  check(
    !/Go to first/.test(await summary.innerText().catch(() => "")),
    "the grid summary no longer carries the link",
    await summary.innerText().catch(() => ""),
  )
  const genShortfall = page.locator('[data-testid="plan-unit-shortfall"]')
  check(
    await genShortfall.locator('[data-testid="plan-go-to-first-open"]').count() > 0,
    "the link sits under Progress on a book too",
    oneLine(await genShortfall.innerText().catch(() => "")),
  )
  await shot("04-genesis-inspector")

  // ── 4. The REAL dubbing project, which nothing here seeded ───────────────
  console.log("\nvideo-&-audio-test — the project that read 0% recorded")
  board = await openBoard("4e6e0861-1a33-4aae-9766-0c0667b2aa0b")
  const ep1 = board.locator('[data-testid^="plan-row-"]', { hasText: "Season 1 · Episode 1" }).first()
  const ep1Text = oneLine(await ep1.innerText())
  check(/AUD/.test(ep1Text), "the episode now draws an audio bar at all", ep1Text)
  await shot("05-real-dubbing-board")

  if (errors.length) console.log("\npage errors:\n  " + errors.slice(0, 10).join("\n  "))
  await browser.close()

  const failed = checks.filter((c) => !c.ok)
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
  if (failed.length) process.exitCode = 1
}
main().catch((e) => { console.error(e); process.exit(1) })
