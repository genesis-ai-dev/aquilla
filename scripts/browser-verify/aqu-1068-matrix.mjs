// AQU-1068 fix round — the file-shape matrix that QA actually broke.
//
// Round 1's browser pass drove ONE untimed 15-cell .md, which is the happiest
// path in the matrix, and every defect Sam found lived in a shape it never
// touched. This drives all four.
//
//   node scripts/browser-verify/aqu-1068-matrix.mjs
import { chromium } from "@playwright/test"
import { execFileSync } from "node:child_process"
import { mkdirSync } from "node:fs"

const WEB = "http://127.0.0.1:5173"
const IDENTITY = "http://127.0.0.1:8788"
const PG = "postgresql://aquilla:aquilla@127.0.0.1:5432/aquilla_dev"
const SHOTS = "/tmp/claude-501/-Users-sampjvv-Code-codex/bc75a9c8-7dc9-45e3-8d84-95c07f53caa5/scratchpad/shots-matrix"
mkdirSync(SHOTS, { recursive: true })

// The four shapes. Counts come from Postgres, never the DOM — the row list is
// virtualised, so `[data-cell-id]` is a viewport window.
const UNTIMED = { project: "dev-project", file: "019f9000-0000-7000-8000-000000000001", label: "untimed .md" }
const TIMED = { project: "221ee4f6-3542-442d-b01a-8668a34d5824", file: "019fd234-ac8a-7111-87f1-c7d3302ba06e", label: "timed VTT" }
const MEDIA = { project: "221ee4f6-3542-442d-b01a-8668a34d5824", file: "01a0173f-28d1-72c7-80ca-d77186ffc44e", label: "MP3 import" }
const BIBLE = { project: "fb88e6fd-bfe5-4a24-acf2-b30db044ab02", file: "019fec1e-f7de-700e-b6fa-496c70002320", label: "31k Bible" }

const sql = (q) => execFileSync("psql", [PG, "-t", "-A", "-c", q], { encoding: "utf8" }).trim()
const setFloor = (project, tier) =>
  sql(`INSERT INTO project_settings (project_id, settings) VALUES ('${project}', '{"cellEditingFloor":"${tier}"}')
       ON CONFLICT (project_id) DO UPDATE SET settings = (project_settings.settings::jsonb || '{"cellEditingFloor":"${tier}"}'::jsonb)::text`)
const clearFloor = (project) =>
  sql(`UPDATE project_settings SET settings = (settings::jsonb - 'cellEditingFloor')::text WHERE project_id = '${project}'`)
const sourceCount = (file) => Number(sql(`SELECT COUNT(*) FROM cells WHERE file_id='${file}' AND side='source'`))
const firstSourceCell = (file) =>
  sql(`SELECT cell_id FROM cells WHERE file_id='${file}' AND side='source' ORDER BY sequence_index NULLS LAST LIMIT 1`)
/** A take of the CELL's own, which is what `audioIdSeededWith` recognises — the
 *  imported clip a whole file shares is seeded with the FILE id instead. */
const seedTake = (project, file, cell) => {
  const audioId = `take-${cell}-verify`
  sql(`INSERT INTO cell_audio (project_id, file_id, cell_id, audio_id, slot, url, selected, deleted, event_id, created_ts)
       VALUES ('${project}','${file}','${cell}','${audioId}','recording','https://example.invalid/${audioId}.webm',1,0,'evt-verify',1)
       ON CONFLICT (project_id, file_id, cell_id, audio_id) DO UPDATE SET deleted = 0, selected = 1`)
  return audioId
}
const dropTake = (file, audioId) =>
  sql(`DELETE FROM cell_audio WHERE file_id='${file}' AND audio_id='${audioId}'`)

/**
 * Put a fixture back the way the run found it.
 *
 * Each pass inserts cells, and on a TIMED file every insert consumes a silence
 * — after a few runs the little 4-cue VTT has no gaps left at all, every
 * direction is legitimately refused, and the pass can no longer tell "correctly
 * refused" from "broken". Dropping the rows this script created makes it
 * repeatable.
 *
 * Projection-only, deliberately: the create events stay in the log, so a
 * rebuild would bring these cells back. That is fine for a local fixture and
 * would be wrong for anything else.
 */
const resetInsertedCells = (file) =>
  sql(`DELETE FROM cells WHERE file_id='${file}'
         AND cell_id IN (SELECT cell_id FROM cells WHERE file_id='${file}' AND side='source'
                         AND metadata::jsonb -> 'aquillaOrigin' ->> 'kind' = 'user-insert')`)
const timingOf = (file, cell) =>
  sql(`SELECT COALESCE(start_ms::text,'null')||'/'||COALESCE(end_ms::text,'null') FROM cells WHERE file_id='${file}' AND side='source' AND cell_id='${cell}'`)

const results = []
const check = (name, ok, detail = "") => {
  results.push({ name, ok })
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`)
}

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
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message))

  const open = async (shape) => {
    await page.goto(`${WEB}/project/${shape.project}/editor/file/${shape.file}`, { waitUntil: "domcontentloaded" })
    await page.waitForSelector("[data-cell-id]", { timeout: 60_000 })
    await page.waitForTimeout(1500)
  }
  const rowIds = () => page.$$eval("[data-cell-id]", (els) => els.map((e) => e.getAttribute("data-cell-id")))
  const corners = async () =>
    (await page.$$eval('[data-testid^="row-structure-"]', (els) =>
      els.map((e) => e.getAttribute("data-testid")).filter((t) => t && !t.endsWith("-add") && !t.endsWith("-remove")))).length

  // ── 1. TIMED VTT in the TEXT lens — the shape Sam broke first ─────────────
  resetInsertedCells(TIMED.file)
  setFloor(TIMED.project, "maintainer")
  await open(TIMED)
  const timedRows = await rowIds()
  const timedCorners = await corners()
  check("timed VTT: the text lens offers structural controls at all",
    timedCorners > 0, `${timedCorners} corners on ${timedRows.length} rows`)

  // Round 3: every row has a `+`; gap-constraint shows up as DISABLED
  // directions inside the menu, not as a missing button.
  const addable = await page.$$eval('[data-testid$="-add"]', (els) => els.length)
  check("timed VTT: every row gets a control, none are missing",
    addable === timedRows.length, `${addable} add buttons / ${timedRows.length} rows`)

  // Somewhere in the file at least one direction must be refused, and it must
  // say so rather than vanish — that is the whole of round 3.
  // The LAST cue has no silence after it (no footage linked, so no known tail),
  // which is the cleanest row to prove "refused, and says so".
  const lastRow = timedRows[timedRows.length - 1]
  await page.locator(`[data-testid="row-structure-${lastRow}-add"]`).first().click()
  const belowItem = page.getByTestId("row-insert-below")
  await belowItem.waitFor({ timeout: 5000 })
  check("timed VTT: the direction with no room is DISABLED, not missing",
    (await belowItem.getAttribute("data-disabled")) !== null)
  check("timed VTT: ...and carries a reason the user can read",
    (await page.getByTestId("row-insert-below-reason").count()) > 0,
    ((await page.getByTestId("row-insert-below-reason").textContent().catch(() => "")) ?? "").slice(0, 60))
  check("timed VTT: ...while the direction that HAS room stays live",
    (await page.getByTestId("row-insert-above").getAttribute("data-disabled")) === null)
  await page.keyboard.press("Escape")
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${SHOTS}/01-timed-text-lens.png` })

  // ── 1b. The SAME file's MEDIA view — pencils over the same silences ───────
  // Round 4: the timeline's gap derivation was still gated on footage, so this
  // footage-less VTT offered inserts in the text table and nothing at all in
  // media view. The two surfaces must agree about the same file. Runs BEFORE
  // the insert leg below, while the fixture's silences are still pristine.
  await page.getByRole("tab", { name: "Media" }).click()
  await page.waitForSelector('[data-testid="tl-lane"]', { timeout: 30_000 })
  await page.waitForTimeout(1000)
  const pencils = await page.$$eval('[data-testid^="tl-add-line-"]', (els) => els.length)
  check("timed VTT media view: gap pencils appear with no footage linked", pencils > 0, `${pencils} slot nodes`)
  await page.screenshot({ path: `${SHOTS}/01b-timed-media-pencils.png` })
  // Back to the text lens — the preference persists per PROJECT, and the MP3
  // leg below shares this one.
  await page.getByRole("tab", { name: "Text" }).click()
  await page.waitForSelector("[data-cell-id]", { timeout: 30_000 })
  await page.waitForTimeout(500)

  if (addable > 0) {
    const before = sourceCount(TIMED.file)
    const beforeIds = await rowIds()
    // The `+` always opens the menu now; pick a direction that is live.
    await page.locator('[data-testid$="-add"]:not([disabled])').first().click()
    const below = page.getByTestId("row-insert-below")
    await below.waitFor({ timeout: 5000 })
    const target = (await below.getAttribute("data-disabled")) === null
      ? below
      : page.getByTestId("row-insert-above")
    await target.click()
    await page.waitForTimeout(3000)
    const afterIds = await rowIds()
    const newId = afterIds.find((id) => !beforeIds.includes(id))
    check("timed VTT: the insert lands", sourceCount(TIMED.file) === before + 1,
      `${before} -> ${sourceCount(TIMED.file)}`)
    check("timed VTT: the new cell is BORN TIMED — what makes a mode switch safe",
      newId != null && !timingOf(TIMED.file, newId).includes("null"),
      newId ? timingOf(TIMED.file, newId) : "no new row rendered")
    await page.screenshot({ path: `${SHOTS}/02-timed-inserted.png` })
  } else {
    check("timed VTT: at least one gap was offered", false, "no add buttons at all")
  }

  // ── 2. MP3 import — no controls, either lens ──────────────────────────────
  setFloor(MEDIA.project, "maintainer")
  await open(MEDIA)
  const mediaRows = await rowIds()
  // Prove the file actually OPENED first: a dead file id renders "No file
  // selected", which has no controls either and would read as a pass.
  check("MP3 import: the file opened", mediaRows.length > 0, `${mediaRows.length} rows`)
  // Round 3 inverts this leg. Rendering nothing was the bug: Sam switched the
  // setting on, nothing happened, and there was no way to tell an inapplicable
  // file from a broken feature.
  check("MP3 import: the controls are PRESENT", (await corners()) === mediaRows.length,
    `${await corners()} corners on ${mediaRows.length} rows`)
  const mp3Add = page.locator(`[data-testid="row-structure-${mediaRows[0]}-add"]`).first()
  const mp3Remove = page.locator(`[data-testid="row-remove-${mediaRows[0]}"]`).first()
  check("MP3 import: add is disabled, not absent", await mp3Add.isDisabled())
  check("MP3 import: remove is disabled too", await mp3Remove.isDisabled())
  // `force` because the button carries `pointer-events-none` so the pointer can
  // reach the wrapper that actually opens the tooltip — Playwright's
  // actionability check would otherwise refuse the hover. NOT caught: a hover
  // that fails must fail the check, not silently produce "no tooltip".
  // Past AppTooltip's 600ms open delay, with room to spare.
  await mp3Add.hover({ force: true })
  await page.waitForTimeout(1400)
  const tip = (await page.locator('[role="tooltip"]').first().textContent().catch(() => "")) ?? ""
  // Round 4: the tooltip on the `+` must answer the INSERT ("can't be added"),
  // not describe the row — the row-describing string was the round-4 complaint.
  check("MP3 import: hovering the + explains the refused ADD", /can.t be added to imported audio/i.test(tip), tip.slice(0, 80))
  await page.screenshot({ path: `${SHOTS}/03-mp3-disabled.png` })

  // ── 3. Untimed .md — still anywhere, both directions ──────────────────────
  setFloor(UNTIMED.project, "maintainer")
  await open(UNTIMED)
  const mdRows = await rowIds()
  check("untimed .md: every rendered row offers a control", (await corners()) === mdRows.length,
    `${await corners()} / ${mdRows.length}`)
  const mdAdd = await page.$$eval('[data-testid$="-add"]:not([disabled])', (els) => els.length)
  check("untimed .md: every row can take a cell — no gaps to respect", mdAdd === mdRows.length,
    `${mdAdd} enabled add buttons`)

  // ── 3b. The removal dialog must SEE a recording in the text lens ──────────
  //
  // The confirmation counted takes from a lens-gated attachments map, so in the
  // text lens it said "there is nothing else attached to it" over a cell
  // holding takes — and confirming destroyed them. The round-1 shape one more
  // time, inside the dialog whose honesty the whole confirm-and-remove trade
  // rests on. The matrix never exercised removal at all, which is how it
  // survived.
  const takeCell = firstSourceCell(UNTIMED.file)
  const seededAudio = seedTake(UNTIMED.project, UNTIMED.file, takeCell)
  try {
    await open(UNTIMED)
    await page.locator(`[data-testid="row-remove-${takeCell}"]`).first().click()
    const dialog = page.getByRole("dialog")
    await dialog.waitFor({ timeout: 10_000 })
    const body = (await dialog.textContent()) ?? ""
    check("removal dialog names the recording, in the TEXT lens",
      /1 recording/i.test(body), body.slice(0, 160))
    check("...and does not claim the cell is empty",
      !/nothing else attached/i.test(body))
    await page.screenshot({ path: `${SHOTS}/05-removal-inventory.png` })
    await page.keyboard.press("Escape")
    await page.waitForTimeout(500)
  } finally {
    dropTake(UNTIMED.file, seededAudio)
  }

  // ── 4. 31k Bible — the insert must be perceptibly instant ─────────────────
  resetInsertedCells(BIBLE.file)
  setFloor(BIBLE.project, "maintainer")
  await open(BIBLE)
  const bibleCountBefore = sourceCount(BIBLE.file)
  const bibleBefore = await rowIds()
  const anchorId = bibleBefore[1]
  // Open the menu FIRST, then time only what this round changed: the gap
  // between asking for the cell and seeing it. Timing the whole gesture would
  // measure Playwright's click resolution and the dropdown's own animation.
  await page.locator(`[data-testid="row-structure-${anchorId}-add"]`).first().click()
  await page.getByTestId("row-insert-below").waitFor()
  const t0 = Date.now()
  await page.getByTestId("row-insert-below").click()
  // Wait for the row to EXIST, not for the network.
  await page.waitForFunction(
    (known) => document.querySelectorAll("[data-cell-id]").length > 0 &&
      [...document.querySelectorAll("[data-cell-id]")].some((e) => !known.includes(e.getAttribute("data-cell-id"))),
    bibleBefore, { timeout: 20_000 },
  )
  const elapsed = Date.now() - t0
  check("31k Bible: the row appears without waiting on the round trip", elapsed < 1000, `${elapsed}ms`)
  await page.waitForTimeout(4000)
  const bibleAfter = await rowIds()
  const bibleNew = bibleAfter.find((id) => !bibleBefore.includes(id))
  check("31k Bible: it lands directly after the row that was clicked",
    bibleAfter[bibleAfter.indexOf(anchorId) + 1] === bibleNew,
    `anchor at ${bibleAfter.indexOf(anchorId)}`)
  // Against the count taken BEFORE the insert, not a hardcoded base — other
  // scripts insert into and clean this fixture too, so its absolute count
  // drifts and a literal here rots into a false failure.
  check("31k Bible: and stays there once the server confirms",
    sourceCount(BIBLE.file) === bibleCountBefore + 1,
    `${bibleCountBefore} -> ${sourceCount(BIBLE.file)} source cells`)
  await page.screenshot({ path: `${SHOTS}/04-bible-inserted.png` })

  await browser.close()
  for (const p of [TIMED.project, MEDIA.project, UNTIMED.project, BIBLE.project]) clearFloor(p)

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  console.log(`screenshots: ${SHOTS}`)
  if (failed.length) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
