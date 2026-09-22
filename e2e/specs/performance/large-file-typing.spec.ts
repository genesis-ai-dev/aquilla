import fs from "node:fs/promises"
import { performance } from "node:perf_hooks"
import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, readProjectedCells, seedProjectWithFile } from "../../helpers/seed-project"

// Diagnostic, not a machine-speed gate. Playwright input is protocol-paced;
// these timings are NOT physical keyboard queue delay. Keep full Timeline/
// video recording off so the measurement does not add that workload itself.
test.use({ trace: "off", video: "off" })

test("typing and Tab preserve edits with 31,215 loaded source cells", async ({ alice }, info) => {
  test.setTimeout(300_000) // Includes real bulk import and cold full-file loading.
  const actionCount = Number(process.env.E2E_TYPING_ACTIONS ?? 4)
  if (!Number.isInteger(actionCount) || actionCount < 1 || actionCount > 64) {
    throw new Error("E2E_TYPING_ACTIONS must be an integer from 1 to 64")
  }
  const count = 31_215
  const fixturePath = info.outputPath("large-file.usfm")
  await fs.mkdir(info.outputDir, { recursive: true })
  // Synthetic text, Bible-sized structure: 66 books, 1,189 chapters. Use the
  // real USFM parser/normalizer so random paragraph groups cannot accidentally
  // become 31,215 fake chapter references in the projection/navigation.
  const books = "GEN EXO LEV NUM DEU JOS JDG RUT 1SA 2SA 1KI 2KI 1CH 2CH EZR NEH EST JOB PSA PRO ECC SNG ISA JER LAM EZK DAN HOS JOL AMO OBA JON MIC NAM HAB ZEP HAG ZEC MAL MAT MRK LUK JHN ACT ROM 1CO 2CO GAL EPH PHP COL 1TH 2TH 1TI 2TI TIT PHM HEB JAS 1PE 2PE 1JN 2JN 3JN JUD REV".split(" ")
  const lines: string[] = []
  let chapterIndex = 0
  for (const [bookIndex, book] of books.entries()) {
    lines.push(`\\id ${book}`)
    for (let chapter = 1; chapter <= (bookIndex === 0 ? 19 : 18); chapter++, chapterIndex++) {
      lines.push(`\\c ${chapter}`)
      const verses = Math.floor(count / 1189) + Number(chapterIndex < count % 1189)
      for (let verse = 1; verse <= verses; verse++) {
        lines.push(`\\v ${verse} Source passage with enough words to exercise the editor health and progress calculations.`)
      }
    }
  }
  await fs.writeFile(fixturePath, lines.join("\n"))
  const jwt = await jwtFor("alice")
  const seeded = await seedProjectWithFile(jwt, { fixturePath, name: "Large typing diagnostic" })
  expect(seeded.cellIds).toHaveLength(count)

  const loadedIds = new Set<string>()
  alice.on("response", async (response) => {
    const url = new URL(response.url())
    if (!url.pathname.endsWith(`/files/${seeded.fileId}/cells`) || url.searchParams.get("paired") !== "1") return
    if (!response.ok()) return // Required count assertion below catches missing/failed pages.
    const body = await response.json() as { cells: { cellId: string }[] }
    for (const cell of body.cells) loadedIds.add(cell.cellId)
  })
  const loadStart = performance.now()
  const ws = await openSeededProject(alice, seeded)
  await expect.poll(() => loadedIds.size, { timeout: 90_000 }).toBe(count)
  await expect(alice.getByTestId("cell-rows-load-status")).toBeHidden({ timeout: 30_000 })
  const loadMs = performance.now() - loadStart

  await ws.activateTargetCell(0)
  // Bounded records only; no whole-file snapshots or continuous profiler.
  await alice.evaluate(() => {
    const state = {
      frames: [] as number[], longTasks: [] as number[], pending: 0,
      longTasksSupported: PerformanceObserver.supportedEntryTypes.includes("longtask"),
    }
    Object.assign(window, { __typingDiagnostic: state })
    document.addEventListener("input", () => {
      const start = performance.now()
      state.pending++
      requestAnimationFrame(() => {
        state.frames.push(performance.now() - start)
        state.pending--
      })
    })
    if (state.longTasksSupported) {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) state.longTasks.push(entry.duration)
      }).observe({ type: "longtask" })
    }
  })
  const actions: { text: string; typingMs: number; tabMs: number }[] = []
  // DOM row indexes shift as virtualization removes rows above the viewport.
  // Assert logical cell IDs so a sustained run also detects misplaced edits.
  const editorFor = (index: number) => alice.locator(`[data-cell-id="${seeded.cellIds[index]}"] [data-cell-type="target"]`)
    .locator('textarea, .ProseMirror[contenteditable="true"], [contenteditable="true"]').first()
  for (let i = 0; i < actionCount; i++) {
    await expect(editorFor(i)).toBeFocused()
    const text = `Translation number ${i + 1} stays in the correct cell`
    const start = performance.now()
    await alice.keyboard.type(text)
    const typed = performance.now()
    await alice.keyboard.press("Tab")
    await expect(editorFor(i + 1)).toBeFocused()
    actions.push({ text, typingMs: typed - start, tabMs: performance.now() - typed })
  }
  // Cross the outbox → worker → Postgres boundary, rather than treating a
  // correct optimistic render as proof of a successful save.
  await expect.poll(async () => {
    const rows = await readProjectedCells(jwt, seeded, "target")
    return actions.map((_, i) => rows.find((row) => row.cellId === seeded.cellIds[i])?.value)
  }, { timeout: 30_000 }).toEqual(actions.map((action) => action.text))
  // Read back the browser cache as well as Postgres: large snapshots use a
  // worker, and must retain all source rows plus every acknowledged edit.
  await expect.poll(async () => alice.evaluate(async ({ projectId, fileId, ids }) => {
    // Read the persisted public storage shape, so this works in both Vite
    // development and production-preview runs without importing app internals.
    const cached = await new Promise<{ rows: { cellId: string; side: string; targetLang?: string; value: string }[] } | undefined>((resolve, reject) => {
      const open = indexedDB.open("aquilla-cells-cache")
      open.onerror = () => reject(open.error)
      open.onsuccess = () => {
        const db = open.result
        const tx = db.transaction("cells", "readonly")
        const request = tx.objectStore("cells").getAll()
        request.onsuccess = () => resolve(request.result.find(entry => entry.key.endsWith(`:${projectId}:${fileId}`)))
        request.onerror = () => reject(request.error)
        tx.oncomplete = () => db.close()
        tx.onabort = () => { db.close(); reject(tx.error) }
      }
    })
    return {
      sources: cached?.rows.filter((row: { side: string }) => row.side === "source").length,
      values: ids.map(id => cached?.rows.find((row: { cellId: string; side: string; targetLang?: string }) =>
        row.cellId === id && row.side === "target" && !row.targetLang)?.value),
    }
  }, { projectId: seeded.projectId, fileId: seeded.fileId, ids: seeded.cellIds.slice(0, actionCount) }),
  { timeout: 30_000 }).toEqual({ sources: count, values: actions.map(action => action.text) })
  await alice.waitForFunction(() =>
    (window as unknown as { __typingDiagnostic: { pending: number } }).__typingDiagnostic.pending === 0,
  )
  const browser = await alice.evaluate(() =>
    (window as unknown as { __typingDiagnostic: { frames: number[]; longTasks: number[]; longTasksSupported: boolean } }).__typingDiagnostic,
  )
  expect(browser.frames.length).toBeGreaterThan(0)
  await info.attach("typing-measurements", {
    body: JSON.stringify({ count, actionCount, loadMs, actions, browser }, null, 2),
    contentType: "application/json",
  })
  console.log(JSON.stringify({ count, actionCount, loadMs, actions, maxInputToFrameMs: Math.max(...browser.frames),
    longTasksSupported: browser.longTasksSupported,
    longTaskCount: browser.longTasksSupported ? browser.longTasks.length : null,
    maxLongTaskMs: browser.longTasksSupported ? Math.max(0, ...browser.longTasks) : null }))
})
