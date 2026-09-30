import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { readFile } from "node:fs/promises"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

test("imported video keeps its authenticated picture and range seeking after reload", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `Imported picture ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)
  const ws = new Workspace(alice)
  const fixture = path.resolve(__dirname, "../../fixtures/tone-picture.mp4")
  await ws.importMediaFile(fixture)
  await ws.declineWhisperDownload()
  await ws.openFileBySubstring("tone-picture.mp4")
  await ws.waitForEditor()
  await alice.getByRole("tab", { name: "Media", exact: true }).click()
  await ws.waitForLinkedVideo()
  await alice.reload()
  await ws.waitForEditor()
  await ws.waitForLinkedVideo()
  const video = ws.linkedVideo()
  expect(await video.evaluate((element: HTMLVideoElement) => element.videoWidth)).toBe(160)
  const src = await video.evaluate((element: HTMLVideoElement) => element.currentSrc)
  const response = await alice.request.get(src, { headers: { Range: "bytes=0-127" } })
  expect(response.status()).toBe(206)
  expect(response.headers()["content-range"]).toMatch(/^bytes 0-127\//)
  expect(await response.body()).toEqual((await readFile(fixture)).subarray(0, 128))
  const unsigned = new URL(src)
  unsigned.search = ""
  expect((await alice.request.get(unsigned.toString(), {
    headers: { Range: "bytes=0-127" },
  })).status()).toBe(401)
  await ws.playMedia()
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime))
    .toBeGreaterThan(0.15)
  await ws.pauseMedia()
  await ws.seekLinkedVideo(0.75)
  await ws.playMedia()
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime))
    .toBeGreaterThan(0.9)
  await ws.pauseMedia()
  await alice.screenshot({ path: "/private/tmp/aquilla-imported-video-reload.png" })
})

test("alice imports markdown, edits a cell, and the edit persists across reload", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `Editor ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  const text = `Hello e2e ${Date.now()}`
  await ws.editCell(0, text)

  // Reload and assert the text survived
  await alice.reload()
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()
  await expect(ws.cellRow(0)).toContainText(text, { timeout: 5_000 })

  // AQU-1336 / AQU-1334: hard navigation does not run React cleanup. Leave
  // immediately after input, while the idle commit is still pending.
  const editorUrl = alice.url()
  const correction = `Immediate correction ${Date.now()}`
  const editor = await ws.activateTargetCell(0)
  await editor.fill(correction)
  await alice.goto("about:blank")
  await alice.goto(editorUrl)
  await ws.waitForEditor()
  await expect(ws.cellRow(0)).toContainText(correction, { timeout: 10_000 })
  // A second reload verifies the recovered outbox survives another teardown.
  await alice.reload()
  await ws.waitForEditor()
  await expect(ws.cellRow(0)).toContainText(correction, { timeout: 10_000 })
})

// AQU-1328: a cold reopen must never offer an existing translation as a blank.
// Shrink the real worker's page size, then explicitly hold page two in flight.
test("a cold file open reveals complete rows and keeps the remaining rows loading", async ({ alice }) => {
  const { jwtFor, openSeededProject, seedProjectWithFile } = await import("../../helpers/seed-project")
  const seeded = await seedProjectWithFile(await jwtFor("alice"))
  const ws = await openSeededProject(alice, seeded)
  const original = "Existing translation — keep this"
  await ws.editCell(0, original)

  // Leaving the editor flushes its pending cache write before we clear only
  // the disposable cells cache. Session and queued edits are left intact.
  await new Dashboard(alice).goto()
  await alice.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open("aquilla-cells-cache")
      open.onsuccess = () => resolve(open.result)
      open.onerror = () => reject(open.error)
    })
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("cells", "readwrite")
      tx.objectStore("cells").clear()
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    db.close()
  })

  let releaseFirst!: () => void
  let releaseTail!: () => void
  const first = new Promise<void>((resolve) => { releaseFirst = resolve })
  const tail = new Promise<void>((resolve) => { releaseTail = resolve })
  let firstCaptured = false
  let tailCaptured = false
  await alice.route(/\/cells\?(?=.*paired=1)(?!.*cellIds=).*/, async (route) => {
    const url = new URL(route.request().url())
    url.searchParams.set("limit", "1")
    const response = await route.fetch({ url: url.toString() })
    if (!url.searchParams.has("cursor")) {
      firstCaptured = true
      await first
    } else {
      tailCaptured = true
      await tail
    }
    await route.fulfill({ response })
  })
  try {
    await alice.goto(`/project/${seeded.projectId}/editor/file/${seeded.fileId}`)
    await expect.poll(() => firstCaptured, { timeout: 30_000 }).toBe(true)
    await expect(alice.getByTestId("cell-area-loading")).toBeVisible()
    await expect(ws.cellRow(0)).toHaveCount(0)
    releaseFirst()
    await expect.poll(() => tailCaptured, { timeout: 30_000 }).toBe(true)
    await expect(ws.cellRow(0)).toContainText(original)
    await expect(ws.cellRow(1)).toHaveCount(0)
    await expect(alice.getByTestId("cell-rows-load-status")).toBeVisible()
    const editor = await ws.activateTargetCell(0)
    await expect(editor).toContainText(original)
    releaseTail()
    await expect(alice.getByTestId("cell-rows-load-status")).toHaveCount(0)
    await expect(ws.cellRow(1)).toBeVisible()
    await expect(ws.cellRow(0)).toContainText(original)
  } finally {
    releaseFirst()
    releaseTail()
    await alice.unrouteAll({ behavior: "wait" })
  }
})
