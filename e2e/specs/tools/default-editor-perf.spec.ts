// Smart Extensions — the default editor extension on a LONG book, measured
// against the built-in editor on the same project. A full gospel (Matthew,
// BSB from the checked-in helloao snapshot: 1,071 verses + section headings),
// every verse already translated, so both editors render both sides.
//
// Reported (test annotations + attachment `default-editor-perf.json`), never
// asserted against a time budget — machine speed must not decide correctness
// (AGENTS.md rule 15). What IS asserted: both editors finish rendering the
// whole book, scroll it end to end, and commit an edit typed into the middle
// of it.

import { randomUUID } from "node:crypto"
import { mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test, expect } from "../../helpers/multi-user"
import type { Frame, Page } from "@playwright/test"
import { DEFAULT_EDITOR, ToolsPage } from "../../helpers/page-objects/ToolsPage"
import { Workspace } from "../../helpers/page-objects/Workspace"
import { readProjectLanes } from "../../helpers/frontier-api"
import { jwtFor, mintSyncToken, seedProjectWithFile, type SeededProject } from "../../helpers/seed-project"

const SYNC_BASE = process.env.E2E_SYNC_BASE ?? `http://${process.env.VITE_SYNC_WORKER_HOST ?? "127.0.0.1:8788"}`

interface Row { cellId: string; side: "source" | "target"; value: string; canonicalRef: string | null; eventId: string }

type Inline = string | { text?: string; lineBreak?: boolean; noteId?: number }
function flatten(content: Inline[]): string {
  return content.map((c) => (typeof c === "string" ? c : c.text ?? (c.lineBreak ? " " : ""))).join("").replace(/\s+/g, " ").trim()
}

/** USFM for one BSB book from the helloao snapshot (headings as \s). */
async function gospelUsfm(bookId: string): Promise<string> {
  const { gunzipSync } = await import("node:zlib")
  const { readFile } = await import("node:fs/promises")
  const raw = gunzipSync(await readFile(path.resolve(process.cwd(), "e2e/fixtures/helloao/BSB.complete.json.gz"))).toString("utf8")
  const complete = JSON.parse(raw) as { books: { id: string; name: string; chapters: { chapter: { number: number; content: ({ type: string; number?: number; content?: Inline[] })[] } }[] }[] }
  const book = complete.books.find((b) => b.id === bookId)
  if (!book) throw new Error(`no ${bookId} in the BSB snapshot`)
  const out = [`\\id ${bookId}`, `\\h ${book.name}`, `\\mt ${book.name}`]
  for (const { chapter } of book.chapters) {
    out.push(`\\c ${chapter.number}`, "\\p")
    for (const node of chapter.content) {
      if (node.type === "heading" && node.content) out.push(`\\s ${flatten(node.content)}`)
      else if (node.type === "verse" && node.content) out.push(`\\v ${node.number} ${flatten(node.content)}`)
    }
  }
  return out.join("\n") + "\n"
}

async function readRows(jwt: string, seeded: SeededProject): Promise<Row[]> {
  const token = await mintSyncToken(jwt, seeded.projectId, seeded.fileId)
  const r = await fetch(`${SYNC_BASE}/api/v1/projects/${seeded.projectId}/files/${seeded.fileId}/cells?limit=2000`, { headers: { Authorization: `Bearer ${token}` } })
  expect(r.ok).toBe(true)
  const rows: Row[] = []
  let body = (await r.json()) as { cells: Row[]; nextCursor: string | null }
  rows.push(...body.cells)
  while (body.nextCursor) {
    const next = await fetch(`${SYNC_BASE}/api/v1/projects/${seeded.projectId}/files/${seeded.fileId}/cells?limit=2000&cursor=${encodeURIComponent(body.nextCursor)}`, { headers: { Authorization: `Bearer ${token}` } })
    body = (await next.json()) as { cells: Row[]; nextCursor: string | null }
    rows.push(...body.cells)
  }
  return rows
}

/** Translate every verse server-side (a placeholder "translation"), so both
 *  editors render a full target column. */
async function translateAll(jwt: string, seeded: SeededProject, lane: string): Promise<number> {
  const sources = (await readRows(jwt, seeded)).filter((r) => r.side === "source" && r.canonicalRef && /:\d+$/.test(r.canonicalRef))
  const token = await mintSyncToken(jwt, seeded.projectId, seeded.fileId)
  for (let i = 0; i < sources.length; i += 400) {
    const events = sources.slice(i, i + 400).map((s) => ({
      id: randomUUID(), schemaVersion: 1, projectId: seeded.projectId, fileId: seeded.fileId, cellId: s.cellId,
      parentId: s.eventId, kind: "target.cell.commit", author: "alice",
      payload: { value: `[${s.canonicalRef}] ${s.value.split(" ").reverse().join(" ")}`, sourceEventId: s.eventId, targetLang: lane },
      clientTs: Date.now(),
    }))
    const res = await fetch(`${SYNC_BASE}/events`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ events }) })
    expect(res.status, await res.clone().text()).toBe(200)
    const body = (await res.json()) as { rejected?: unknown[]; stale?: unknown[] }
    expect(body.rejected ?? [], "rejected translations").toEqual([])
  }
  return sources.length
}

/** rAF-driven scroll from top to bottom of `scroller` (a CSS selector in
 *  `ctx`), returning frame-gap stats. Runs inside the page/frame itself. */
async function measureScroll(ctx: Page | Frame, scroller: string): Promise<{ frames: number; meanMs: number; p95Ms: number; maxMs: number; totalMs: number }> {
  return ctx.evaluate(async (sel) => {
    const el = document.querySelector(sel) as HTMLElement
    const gaps: number[] = []
    const step = Math.max(400, Math.round(el.clientHeight * 0.8))
    el.scrollTop = 0
    const start = performance.now()
    let last = start
    await new Promise<void>((resolve) => {
      const tick = (now: number) => {
        gaps.push(now - last)
        last = now
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) return resolve()
        el.scrollTop += step
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    const sorted = [...gaps].sort((a, b) => a - b)
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length
    return {
      frames: gaps.length,
      meanMs: Math.round(mean * 10) / 10,
      p95Ms: Math.round(sorted[Math.floor(sorted.length * 0.95)] * 10) / 10,
      maxMs: Math.round(sorted[sorted.length - 1] * 10) / 10,
      totalMs: Math.round(performance.now() - start),
    }
  }, scroller)
}

/** Keystroke → paint latency for `n` characters typed into the focused
 *  editable in `ctx` (input event → next animation frame). */
async function measureTyping(page: Page, ctx: Page | Frame, text: string): Promise<{ meanMs: number; p95Ms: number }> {
  await ctx.evaluate(() => {
    const w = window as unknown as { __lat: number[] }
    w.__lat = []
    document.addEventListener("input", (e) => {
      const t0 = e.timeStamp
      requestAnimationFrame(() => setTimeout(() => w.__lat.push(performance.now() - t0), 0))
    }, { capture: true })
  })
  await page.keyboard.type(text, { delay: 30 })
  await expect.poll(() => ctx.evaluate(() => (window as unknown as { __lat: number[] }).__lat.length)).toBeGreaterThanOrEqual(text.length)
  const lat = await ctx.evaluate(() => (window as unknown as { __lat: number[] }).__lat)
  const sorted = [...lat].sort((a, b) => a - b)
  return {
    meanMs: Math.round((lat.reduce((a, b) => a + b, 0) / lat.length) * 10) / 10,
    p95Ms: Math.round(sorted[Math.floor(sorted.length * 0.95)] * 10) / 10,
  }
}

test("default editor extension vs built-in editor on a full gospel", async ({ alice }, testInfo) => {
  test.setTimeout(300_000)
  const jwt = await jwtFor("alice")
  const dir = await mkdtemp(path.join(os.tmpdir(), "aquilla-perf-"))
  const fixture = path.join(dir, "MAT.usfm")
  await writeFile(fixture, await gospelUsfm("MAT"))
  const seeded = await seedProjectWithFile(jwt, { name: `Perf Matthew ${Date.now()}`, fixturePath: fixture })
  const lane = (await readProjectLanes(jwt, seeded.projectId)).find((l) => l.role === "target")?.legacyTag ?? ""
  const verses = await translateAll(jwt, seeded, lane)
  expect(verses).toBeGreaterThan(1000)
  const lastRef = "MAT 28:20"
  const midRef = "MAT 14:22"

  const tools = new ToolsPage(alice)
  await tools.optIntoDefaultEditorExtension()
  const results: Record<string, unknown> = { book: "Matthew (BSB)", verses, cells: seeded.cellIds.length }

  // ── Extension editor (the default) ─────────────────────────────────────
  {
    // Warm-up open (first install + cold caches), then measure a reload —
    // the same warm-cache conditions the built-in editor is measured under.
    await tools.openFileInDefaultEditor(seeded.projectId, seeded.fileId, "MAT 1:1")
    const t0 = Date.now()
    await alice.reload()
    const frame = tools.toolFrame(DEFAULT_EDITOR)
    await expect(tools.translationBox(frame, "MAT 1:1")).toBeVisible({ timeout: 60_000 })
    const firstRender = Date.now() - t0
    await expect(tools.translationBox(frame, lastRef)).toBeAttached({ timeout: 60_000 })
    await expect(frame.locator("#progress")).not.toContainText("loading", { timeout: 60_000 })
    const fullyLoaded = Date.now() - t0
    const f = alice.frames().find((x) => x.url() === "about:srcdoc" && x !== alice.mainFrame())
    expect(f, "extension frame").toBeTruthy()
    const scroll = await measureScroll(f!, "#list")
    const box = tools.translationBox(frame, midRef)
    await box.scrollIntoViewIfNeeded()
    await box.click()
    await alice.keyboard.press("End")
    const typing = await measureTyping(alice, f!, " editado")
    await box.press("Enter")
    results.extension = { firstRenderMs: firstRender, fullyLoadedMs: fullyLoaded, rowsRendered: await frame.locator(".row").count(), scroll, typing }
  }

  // ── Built-in editor (one switch away) ──────────────────────────────────
  {
    await tools.switchEditor("Standard editor")
    const t0 = Date.now()
    await alice.reload()
    // The built-in editor reopens where you were (chapter-paged), so wait for
    // any translated row of the book rather than a specific first cell.
    const firstRow = alice.locator("[data-cell-id]").filter({ hasText: /\[MAT \d+:\d+\]/ }).first()
    await expect(firstRow).toBeVisible({ timeout: 60_000 })
    const firstRender = Date.now() - t0
    // The tail of the book has streamed in when the load-status strip is gone.
    await expect(alice.getByTestId("cell-rows-load-status")).toHaveCount(0, { timeout: 60_000 })
    const fullyLoaded = Date.now() - t0
    // The built-in table's scroll container: nearest scrollable ancestor of a row.
    const rowsRendered = await alice.locator("[data-cell-id]").count()
    await alice.evaluate(() => {
      let el: HTMLElement | null = document.querySelector("[data-cell-id]")
      while (el && !(el.scrollHeight > el.clientHeight + 10 && /(auto|scroll)/.test(getComputedStyle(el).overflowY))) el = el.parentElement
      el?.setAttribute("data-perf-scroller", "1")
    })
    const scroll = await measureScroll(alice, "[data-perf-scroller]")
    // Activate a verse's target the way a translator does (the built-in mounts
    // its rich-text editor on activation), then type.
    const ws = new Workspace(alice)
    await ws.activateTargetCell(5)
    await alice.keyboard.press("End")
    const typing = await measureTyping(alice, alice, " editado")
    await alice.keyboard.press("Enter")
    results.builtin = { firstRenderMs: firstRender, fullyLoadedMs: fullyLoaded, rowsRendered, scroll, typing }
  }

  testInfo.annotations.push({ type: "perf", description: JSON.stringify(results) })
  await testInfo.attach("default-editor-perf.json", { body: JSON.stringify(results, null, 2), contentType: "application/json" })
  console.log(`[perf] ${JSON.stringify(results)}`)
  const out = process.env.PERF_OUT
  if (out) await writeFile(out, JSON.stringify(results, null, 2))
})
