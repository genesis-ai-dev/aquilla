// AQU-1068: where does the time go on a 31k-row insert/remove?
// Logs long tasks (main-thread blocks >50ms) tagged against action marks, and
// takes a CPU profile across the whole scenario, reporting top self-time.
import { chromium } from "@playwright/test"
import { execFileSync } from "node:child_process"

const WEB = "http://127.0.0.1:5173"
const IDENTITY = "http://127.0.0.1:8788"
const PG = "postgresql://aquilla:aquilla@127.0.0.1:5432/aquilla_dev"
const BIBLE = { project: "fb88e6fd-bfe5-4a24-acf2-b30db044ab02", file: "01a0645a-4599-727b-af5e-b72eadde555f" }

const sql = (q) => execFileSync("psql", [PG, "-t", "-A", "-c", q], { encoding: "utf8" }).trim()
sql(`INSERT INTO project_settings (project_id, settings) VALUES ('${BIBLE.project}', '{"cellEditingFloor":"maintainer"}')
     ON CONFLICT (project_id) DO UPDATE SET settings = (project_settings.settings::jsonb || '{"cellEditingFloor":"maintainer"}'::jsonb)::text`)
const resetInsertedCells = () =>
  sql(`DELETE FROM cells WHERE file_id='${BIBLE.file}'
       AND metadata::jsonb -> 'aquillaOrigin' ->> 'kind' = 'user-insert'`)
resetInsertedCells()

const alive = sql(`SELECT COUNT(*) FROM files WHERE id='${BIBLE.file}' AND deleted_at IS NULL`)
if (alive !== "1") throw new Error(`fixture file ${BIBLE.file} is missing or deleted — repoint it`)

async function main() {
  const { access_token, username } = await (await fetch(`${IDENTITY}/__dev__/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "dev" }),
  })).json()

  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
  await ctx.addInitScript(({ token, username }) => {
    const s = { jwt: token, username, createdAt: new Date().toISOString() }
    const e = { active: username, sessions: { [username]: s }, dataOwner: username }
    const q = indexedDB.open("frontier", 1)
    q.onupgradeneeded = () => { const d = q.result; if (!d.objectStoreNames.contains("session")) d.createObjectStore("session") }
    q.onsuccess = () => q.result.transaction("session", "readwrite").objectStore("session").put(e, "envelope")
    // Long-task log + action marks, both on performance.now()'s clock.
    window.__perfLog = []
    window.__mark = (label) => window.__perfLog.push({ t: performance.now(), label, kind: "mark" })
    new PerformanceObserver((list) => {
      for (const e of list.getEntries())
        window.__perfLog.push({ t: e.startTime, dur: e.duration, label: "longtask", kind: "task" })
    }).observe({ entryTypes: ["longtask"] })
  }, { token: access_token, username })

  const page = await ctx.newPage()
  page.on("load", () => console.log("[page load event — reload?]"))
  const cdp = await ctx.newCDPSession(page)
  await cdp.send("Profiler.enable")
  await cdp.send("Profiler.setSamplingInterval", { interval: 500 })

  await page.goto(`${WEB}/project/${BIBLE.project}/editor/file/${BIBLE.file}`, { waitUntil: "domcontentloaded" })
  await page.waitForSelector("[data-cell-id]", { timeout: 60_000 })
  // Wait for the FULL stream (the dev worker pages 500 rows at a time), so
  // the measured jank is against the loaded 31k file, not a 501-row prefix.
  await page.waitForFunction(() => (window.__cellStore?.sourceOrder?.length ?? 0) > 30000, undefined, { timeout: 180_000 })
  await page.waitForTimeout(3000)

  await cdp.send("Profiler.start")
  const before = await page.$$eval("[data-cell-id]", (els) => els.map((e) => e.getAttribute("data-cell-id")))
  const anchor = before[1]

  // INSERT
  await page.locator(`[data-testid="cell-menu-${anchor}"]`).first().click()
  await page.getByTestId("cell-menu-insert-below").waitFor()
  await page.evaluate(() => window.__mark("insert-click"))
  await page.getByTestId("cell-menu-insert-below").click()
  const handle = await page.waitForFunction(
    (known) => [...document.querySelectorAll("[data-cell-id]")]
      .map((e) => e.getAttribute("data-cell-id")).find((id) => id && !known.includes(id)) ?? false,
    before, { timeout: 20_000 },
  )
  const newId = await handle.jsonValue()
  await page.evaluate(() => window.__mark("insert-row-visible"))
  await page.waitForTimeout(9000) // confirm + 2s debounce + flush all land in here

  // REMOVE the inserted (empty, user-added → single click, no dialog)
  const diag = await page.evaluate((id) => ({
    rowThere: Boolean(document.querySelector(`[data-cell-id="${id}"]`)),
    // AQU-1068 item 5: remove is a MENU ENTRY now, so its presence cannot be
    // read off the row without opening one. What the row still shows is the
    // menu's trigger, which is the count that matters here.
    menuThere: Boolean(document.querySelector(`[data-testid="cell-menu-${id}"]`)),
    menuCount: document.querySelectorAll('[data-testid^="cell-menu-"]').length,
    rows: document.querySelectorAll("[data-cell-id]").length,
  }), newId)
  console.log("pre-remove diag:", JSON.stringify(diag))
  if (!diag.menuThere) await page.screenshot({ path: "/tmp/claude-501/-Users-sampjvv-Code-codex/bc75a9c8-7dc9-45e3-8d84-95c07f53caa5/scratchpad/bible-pre-remove.png" })
  await page.evaluate(() => window.__mark("remove-click"))
  await page.locator(`[data-testid="cell-menu-${newId}"]`).first().click()
  await page.getByTestId("cell-menu-remove").click()
  try {
    await page.waitForFunction((id) => ![...document.querySelectorAll("[data-cell-id]")].some((e) => e.getAttribute("data-cell-id") === id), newId, { timeout: 60_000 })
    await page.evaluate(() => window.__mark("remove-row-gone"))
  } catch {
    await page.evaluate(() => window.__mark("remove-NEVER-completed"))
    const toasts = await page.$$eval('[data-sonner-toast],[role="status"],[role="alert"]', (els) => els.map((e) => e.textContent))
    console.log("REMOVE TIMED OUT. toasts:", JSON.stringify(toasts))
    await page.screenshot({ path: "/tmp/claude-501/-Users-sampjvv-Code-codex/bc75a9c8-7dc9-45e3-8d84-95c07f53caa5/scratchpad/bible-remove-stuck.png" })
  }
  await page.waitForTimeout(9000)

  // DIALOG on an imported verse (cancel — no mutation)
  await page.evaluate(() => window.__mark("dialog-click"))
  await page.locator(`[data-testid="cell-menu-${before[2]}"]`).first().click()
  await page.getByTestId("cell-menu-remove").click()
  await page.getByRole("dialog").waitFor({ timeout: 15_000 })
  await page.evaluate(() => window.__mark("dialog-open"))
  await page.keyboard.press("Escape")
  await page.waitForTimeout(2000)

  const { profile } = await cdp.send("Profiler.stop")
  const log = await page.evaluate(() => window.__perfLog)

  // ── report ────────────────────────────────────────────────────────────────
  const marks = Object.fromEntries(log.filter((e) => e.kind === "mark").map((e) => [e.label, e.t]))
  console.log("== marks (ms on the page clock) ==")
  for (const [k, v] of Object.entries(marks)) console.log(`  ${k}: ${Math.round(v)}`)
  console.log("== long tasks (>50ms main-thread blocks) ==")
  for (const e of log.filter((e) => e.kind === "task")) {
    const rel = Object.entries(marks).filter(([, t]) => t <= e.t).sort((a, b) => b[1] - a[1])[0]
    console.log(`  at ${Math.round(e.t)}  dur ${Math.round(e.dur)}ms   (${rel ? `${Math.round(e.t - rel[1])}ms after ${rel[0]}` : "before actions"})`)
  }

  // top self-time from the CPU profile
  const nodes = new Map(profile.nodes.map((n) => [n.id, n]))
  const self = new Map()
  const total = profile.samples.length
  for (const s of profile.samples) {
    const n = nodes.get(s)
    if (!n) continue
    const fn = n.callFrame.functionName || "(anon)"
    const url = (n.callFrame.url || "").split("/").slice(-1)[0].split("?")[0]
    const key = `${fn}  [${url}:${n.callFrame.lineNumber}]`
    self.set(key, (self.get(key) ?? 0) + 1)
  }
  console.log(`== top self-time (of ${total} samples across the scenario) ==`)
  for (const [k, v] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25))
    console.log(`  ${String(v).padStart(6)}  ${((v / total) * 100).toFixed(1).padStart(5)}%  ${k}`)

  resetInsertedCells()
  await browser.close()
}
main().catch((e) => { console.error(e); process.exit(1) })
