// AQU-1068: where does an optimistic Bible insert GO after the confirm lands?
// Samples the live store every 500ms for 14s after the insert.
import { chromium } from "@playwright/test"
import { execFileSync } from "node:child_process"

const WEB = "http://127.0.0.1:5173"
const IDENTITY = "http://127.0.0.1:8788"
const PG = "postgresql://aquilla:aquilla@127.0.0.1:5432/aquilla_dev"
const BIBLE = { project: "fb88e6fd-bfe5-4a24-acf2-b30db044ab02", file: "019fec1e-f7de-700e-b6fa-496c70002320" }

const sql = (q) => execFileSync("psql", [PG, "-t", "-A", "-c", q], { encoding: "utf8" }).trim()
sql(`DELETE FROM cells WHERE file_id='${BIBLE.file}' AND metadata::jsonb -> 'aquillaOrigin' ->> 'kind' = 'user-insert'`)

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
  }, { token: access_token, username })
  const page = await ctx.newPage()
  page.on("console", (m) => { const t = m.text(); if (!t.includes("[vite]") && !t.includes("Download the React DevTools")) console.log("  [console]", t.slice(0, 220)) })
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message))
  page.on("response", (r) => { if (r.url().includes("cells") || r.url().includes("events")) console.log(`  [rsp] ${r.status()} ${r.url().slice(27, 160)}`) })
  page.on("requestfailed", (r) => console.log(`  [reqFAIL] ${r.url().slice(27, 160)} ${(r.failure() || {}).errorText}`))
  await page.goto(`${WEB}/project/${BIBLE.project}/editor/file/${BIBLE.file}`, { waitUntil: "domcontentloaded" })
  await page.waitForSelector("[data-cell-id]", { timeout: 60_000 })
  await page.waitForTimeout(5000)

  const before = await page.$$eval("[data-cell-id]", (els) => els.map((e) => e.getAttribute("data-cell-id")))
  const anchor = before[1]
  await page.locator(`[data-testid="row-structure-${anchor}-add"]`).first().click()
  await page.getByTestId("row-insert-below").waitFor()
  await page.getByTestId("row-insert-below").click()
  const handle = await page.waitForFunction(
    (known) => [...document.querySelectorAll("[data-cell-id]")]
      .map((e) => e.getAttribute("data-cell-id")).find((id) => id && !known.includes(id)) ?? false,
    before, { timeout: 20_000 },
  )
  const newId = await handle.jsonValue()
  console.log(`inserted ${newId} below anchor ${anchor} (anchor was at rendered index 1)`)

  for (let i = 0; i < 60; i++) {
    const snap = await page.evaluate(({ id, anchor }) => {
      const s = window.__cellStore
      const order = s.sourceOrder ?? []
      const row = s.sourceById?.get?.(id)
      return {
        idx: order.indexOf(id),
        anchorIdx: order.indexOf(anchor),
        total: order.length,
        eventId: row?.eventId ?? "(row missing)",
        anchorOf: row?.anchorCellId ?? null,
        rendered: Boolean(document.querySelector(`[data-cell-id="${id}"]`)),
      }
    }, { id: newId, anchor })
    console.log(`t+${(i * 2).toFixed(0)}s  idx=${snap.idx}/${snap.total} (anchor@${snap.anchorIdx}) eventId=${JSON.stringify(snap.eventId).slice(0, 30)} anchorOf=${snap.anchorOf} rendered=${snap.rendered}`)
    await page.waitForTimeout(2000)
  }
  sql(`DELETE FROM cells WHERE file_id='${BIBLE.file}' AND metadata::jsonb -> 'aquillaOrigin' ->> 'kind' = 'user-insert'`)
  await browser.close()
}
main().catch((e) => { console.error(e); process.exit(1) })
