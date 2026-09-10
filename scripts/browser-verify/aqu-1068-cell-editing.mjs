// AQU-1068 browser pass. Drives the LIVE dev stack through the real flow:
// default-off, opt in through the settings UI, insert, reload, remove with the
// confirmation, reload. Hard assertions, plus screenshots for the eye.
//
//   node scripts/browser-verify/aqu-1068-cell-editing.mjs
import { chromium } from "@playwright/test"
import { mkdirSync } from "node:fs"
import { execFileSync } from "node:child_process"

const WEB = "http://127.0.0.1:5173"
const IDENTITY = "http://127.0.0.1:8788"
const SYNC = "http://127.0.0.1:8789"
const PROJECT = "dev-project"
const FILE = "019f9000-0000-7000-8000-000000000001" // Genesis 1 (i18n sample).md — untimed, 15 cells
const SHOTS = "/tmp/claude-501/-Users-sampjvv-Code-codex/bc75a9c8-7dc9-45e3-8d84-95c07f53caa5/scratchpad/shots-1068"
mkdirSync(SHOTS, { recursive: true })

// The row list is VIRTUALISED — `[data-cell-id]` is a viewport window, not the
// file. Anything about how many cells exist has to come from the database;
// the DOM is for interacting and for reading ORDER among rendered rows.
const PG = "postgresql://aquilla:aquilla@127.0.0.1:5432/aquilla_dev"
const sql = (q) => execFileSync("psql", [PG, "-t", "-A", "-c", q], { encoding: "utf8" }).trim()
const sourceCellCount = () =>
  Number(sql(`SELECT COUNT(*) FROM cells WHERE file_id = '${FILE}' AND side = 'source'`))
const anchorOf = (cellId) =>
  sql(`SELECT COALESCE(anchor_cell_id,'<head>') FROM cells WHERE file_id = '${FILE}' AND side='source' AND cell_id = '${cellId}'`)
/** Imported = carries text and has no user-insert marker. Repeated runs of this
 *  script leave hand-added empty cells behind, and those take the ONE-CLICK
 *  take-back path (no dialog) — which is correct, and not what this leg tests. */
const isImported = (cellId) =>
  sql(`SELECT (COALESCE(metadata::jsonb -> 'aquillaOrigin' ->> 'kind','') <> 'user-insert' AND TRIM(COALESCE(value,'')) <> '')
       FROM cells WHERE file_id='${FILE}' AND side='source' AND cell_id='${cellId}'`) === "t"

const results = []
function check(name, ok, detail = "") {
  results.push({ name, ok, detail })
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`)
}

const login = async (username) => {
  const res = await fetch(`${IDENTITY}/__dev__/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username }),
  })
  if (!res.ok) throw new Error(`dev login failed: ${res.status}`)
  return res.json()
}

async function main() {
  const { access_token, username } = await login("dev")
  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })

  // The session lives in IndexedDB (frontier/session/envelope), not localStorage.
  await ctx.addInitScript(
    ({ token, username }) => {
      const session = { jwt: token, username, createdAt: new Date().toISOString() }
      const envelope = { active: username, sessions: { [username]: session }, dataOwner: username }
      const req = indexedDB.open("frontier", 1)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains("session")) db.createObjectStore("session")
      }
      req.onsuccess = () =>
        req.result.transaction("session", "readwrite").objectStore("session").put(envelope, "envelope")
    },
    { token: access_token, username },
  )

  const page = await ctx.newPage()
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message))

  const openFile = async () => {
    await page.goto(`${WEB}/project/${PROJECT}/editor/file/${FILE}`, { waitUntil: "domcontentloaded" })
    await page.waitForSelector("[data-cell-id]", { timeout: 45_000 })
    await page.waitForTimeout(1200)
  }

  const rowIds = () =>
    page.$$eval("[data-cell-id]", (els) => els.map((e) => e.getAttribute("data-cell-id")))

  // ── 1. Default is refusal, for an OWNER ────────────────────────────────────
  await openFile()
  // AQU-1068 item 5: the corner became the source cell's one menu. The menu
  // itself may exist for reasons that are not structural (editing source text,
  // typing timestamps), so what proves the tier is refusing is the absence of
  // its structural ENTRIES — which means opening it.
  const menus0 = await page.$$('[data-testid^="cell-menu-"]')
  let structural0 = 0
  if (menus0.length > 0) {
    await menus0[0].click()
    structural0 = await page.locator('[data-testid="cell-menu-insert-below"]').count()
    await page.keyboard.press("Escape")
  }
  check(
    "default 'No one' offers no structural controls, even to an owner",
    structural0 === 0,
    `${structural0} structural entries in ${menus0.length} menus`,
  )
  await page.screenshot({ path: `${SHOTS}/01-default-off.png` })

  // ── 1b. ...and the SERVER now accepts what the buttons refuse ─────────────
  //
  // AQU-1068, 2026-09-09. This is the whole point of the rework and nothing
  // else covers it. The tier used to be enforced at the /events perimeter,
  // where the default "none" refused everyone including owners — and that
  // silently broke audio-cue re-import, DCS upstream import and diarization,
  // all of which emit `source.cell.create` through the user's own outbox.
  //
  // The tier is now a rule about which buttons exist (check 1 above), and the
  // perimeter takes the write. Posting one directly, with the project still on
  // "No one", is the only way to see the two halves disagree on purpose.
  const syncTokenRes = await fetch(`${IDENTITY}/api/v2/sync-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${access_token}` },
    body: JSON.stringify({ projectId: PROJECT, fileId: FILE }),
  })
  const syncToken = syncTokenRes.ok ? (await syncTokenRes.json()).token : null
  const probeCellId = `019f9000-0000-7000-8000-0000000d${Date.now().toString(16).slice(-4)}`
  let directStatus = 0
  let directAccepted = 0
  if (syncToken) {
    const res = await fetch(`${SYNC}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${syncToken}` },
      body: JSON.stringify({
        events: [{
          id: crypto.randomUUID(),
          schemaVersion: 1,
          kind: "source.cell.create",
          projectId: PROJECT,
          fileId: FILE,
          cellId: probeCellId,
          parentId: null,
          author: username,
          clientTs: Date.now(),
          payload: { cellId: probeCellId, anchorCellId: null, value: "server-accepts-me" },
        }],
      }),
    })
    directStatus = res.status
    if (res.ok) directAccepted = ((await res.json()).accepted ?? []).length
  }
  check(
    "the SERVER accepts a source.cell.create while the tier says 'No one'",
    directAccepted === 1,
    `HTTP ${directStatus}, ${directAccepted} accepted`,
  )
  // Put the file back the way it was found — a pass that mutates a fixture and
  // does not clean up makes the next run's counts lie.
  sql(`DELETE FROM cells WHERE file_id='${FILE}' AND cell_id='${probeCellId}'`)
  sql(`DELETE FROM events WHERE file_id='${FILE}' AND cell_id='${probeCellId}'`)

  // ── 2. Opt in through the settings UI ──────────────────────────────────────
  // The tier lives in the General pane (`section-cell-editing`), not
  // Validation — it answers WHO restructures a file, not how work is approved.
  await page.goto(`${WEB}/project/${PROJECT}/settings/general`, { waitUntil: "domcontentloaded" })
  const trigger = page.getByTestId("settings-cell-editing-floor")
  await trigger.waitFor({ timeout: 30_000 })
  check("the setting reads 'No one' before anyone changes it", (await trigger.textContent())?.includes("No one") === true)
  await page.screenshot({ path: `${SHOTS}/02-setting-default.png` })

  await trigger.click()
  // AQU-1068 item 5 round: the tiers are the product's standard role ladder
  // now ("Maintainer (600)"), not the old bespoke phrasing ("Maintainers").
  await page.getByRole("option", { name: /^Maintainer \(600\)$/ }).click()
  await page.getByRole("button", { name: /save changes/i }).click()
  await page.waitForTimeout(2500)
  await page.screenshot({ path: `${SHOTS}/03-setting-maintainers.png` })

  // ── 3. The controls appear ─────────────────────────────────────────────────
  await openFile()
  const before = await rowIds()
  const menuIds = await page.$$eval('[data-testid^="cell-menu-"]', (els) =>
    els.map((e) => e.getAttribute("data-testid")))
  check("opting in reveals a structural control on every rendered row",
    before.every((id) => menuIds.includes(`cell-menu-${id}`)),
    `${menuIds.length} menus / ${before.length} rendered rows`)
  await page.screenshot({ path: `${SHOTS}/04-controls-visible.png` })

  // ── 4. Insert below the second row ─────────────────────────────────────────
  const cellsBefore = sourceCellCount()
  const anchorId = before[1]
  await page.locator(`[data-testid="cell-menu-${anchorId}"]`).first().click()
  await page.getByTestId("cell-menu-insert-below").click()
  await page.waitForTimeout(3000)
  const afterInsert = await rowIds()
  const insertedAt = afterInsert.findIndex((id) => !before.includes(id))
  const newCellId = afterInsert[insertedAt]
  check("insert adds exactly one cell to the file", sourceCellCount() === cellsBefore + 1,
    `${cellsBefore} -> ${sourceCellCount()}`)
  check("the new cell lands directly after the row that was clicked",
    insertedAt === 2 && afterInsert[1] === anchorId,
    `index ${insertedAt}, after ${afterInsert[1]}`)
  check("...and is anchored to it in the chain, not appended at the tail",
    anchorOf(newCellId) === anchorId, `anchor = ${anchorOf(newCellId)}`)
  await page.screenshot({ path: `${SHOTS}/05-inserted.png` })

  // ── 5. Order survives a reload ─────────────────────────────────────────────
  await openFile()
  const afterReload = await rowIds()
  check("the inserted cell is in the same position after a full reload",
    afterReload[2] === newCellId && afterReload[1] === anchorId,
    `index ${afterReload.indexOf(newCellId)}`)
  await page.screenshot({ path: `${SHOTS}/06-after-reload.png` })

  // ── 6. Removing an IMPORTED cell asks first, and says what goes ────────────
  const importedId = afterReload.find((id) => isImported(id))
  if (!importedId) throw new Error("no imported cell is rendered — cannot test the confirmation path")
  const cellsBeforeRemove = sourceCellCount()
  await page.locator(`[data-testid="cell-menu-${importedId}"]`).first().click()
  await page.getByTestId("cell-menu-remove").click()
  const dialog = page.getByRole("dialog")
  await dialog.waitFor({ timeout: 10_000 })
  const body = (await dialog.textContent()) ?? ""
  check("removing an imported cell opens a confirmation", body.includes("Remove this cell?"))
  check("the confirmation inventories what will be destroyed",
    /removes the cell/i.test(body) && /cannot be undone/i.test(body), body.slice(0, 220))
  await page.screenshot({ path: `${SHOTS}/07-confirm-dialog.png` })

  // The dialog gates its confirm behind an acknowledgement checkbox.
  await dialog.getByRole("checkbox").click()
  await dialog.getByRole("button", { name: /remove it/i }).click()
  await page.waitForTimeout(3000)
  const afterRemove = await rowIds()
  check("confirming removes the row", !afterRemove.includes(importedId))
  check("...and one cell leaves the file", sourceCellCount() === cellsBeforeRemove - 1,
    `${cellsBeforeRemove} -> ${sourceCellCount()}`)
  await page.screenshot({ path: `${SHOTS}/08-removed.png` })

  // ── 7. ...and it stays gone ────────────────────────────────────────────────
  await openFile()
  const finalIds = await rowIds()
  check("the removed cell is still gone after a reload", !finalIds.includes(importedId),
    `${finalIds.length} rows`)
  check("the rows around the removal kept their order",
    finalIds.join(",") === afterRemove.filter((id) => finalIds.includes(id)).join(","),
    finalIds.slice(0, 3).join(", "))
  check("no target row is left behind for the removed cell",
    Number(sql(`SELECT COUNT(*) FROM cells WHERE file_id='${FILE}' AND cell_id='${importedId}'`)) === 0)
  await page.screenshot({ path: `${SHOTS}/09-final.png` })

  await browser.close()

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  console.log(`screenshots: ${SHOTS}`)
  if (failed.length) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
