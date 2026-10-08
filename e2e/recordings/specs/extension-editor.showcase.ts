import { test, expect } from "@playwright/test"
import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { ensureAuthState, injectSession } from "../../helpers/auth"
import { resetBackend } from "../../helpers/seed"
import { jwtFor, mintSyncToken, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"
import { ToolsPage } from "../../helpers/page-objects/ToolsPage"
import { FOCUS_EDITOR_MANIFEST, FOCUS_EDITOR_SOURCE } from "../../../src/lib/tools/starters/focus-editor-source"

/**
 * Smart Extensions — custom editor walkthrough, 1280×720.
 * The Focus Editor extension (installed beforehand, read-only standing grant)
 * replaces the standard editor for a file: translate and validate verses in
 * it (first writes ask for permission), switch back to the standard editor to
 * see the same text, then the attributed activity log.
 * Writes `<outputDir>/timeline.json` for trimming the set-up.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(__dirname, "../../fixtures/tools/key-terms.usfm")
const AUTH_BASE = process.env.VITE_FRONTIER_BASE ?? "http://127.0.0.1:8787"
const SYNC_BASE = process.env.E2E_SYNC_BASE ?? `http://${process.env.VITE_SYNC_WORKER_HOST ?? "127.0.0.1:8788"}`
const FRAME = { width: 1280, height: 720 }

test.use({ viewport: FRAME, video: { mode: "on", size: FRAME } })

test("Smart Extensions — a custom editor", async ({ page }, testInfo) => {
  test.setTimeout(300_000)
  const t0 = Date.now()
  await resetBackend()
  const session = await ensureAuthState("alice")
  await page.context().addCookies([{ name: "aq_hint", value: "1", url: process.env.E2E_BASE_URL ?? "http://127.0.0.1:6173" }])
  await page.goto("/")
  await injectSession(page, session)

  const jwt = await jwtFor("alice")
  const seeded = await seedProjectWithFile(jwt, { name: "Matthew (Spanish)", fixturePath: FIXTURE })
  // One verse already translated by someone, so the standard editor isn't empty.
  const token = await mintSyncToken(jwt, seeded.projectId, seeded.fileId)
  const read = await fetch(`${SYNC_BASE}/api/v1/projects/${seeded.projectId}/files/${seeded.fileId}/cells`, { headers: { Authorization: `Bearer ${token}` } })
  const rows = ((await read.json()) as { cells: { cellId: string; side: string; canonicalRef: string | null; eventId: string }[] }).cells
  const v23 = rows.find((r) => r.side === "source" && r.canonicalRef === "MAT 2:3")
  if (v23) {
    await fetch(`${SYNC_BASE}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ events: [{ id: randomUUID(), schemaVersion: 1, projectId: seeded.projectId, fileId: seeded.fileId, cellId: v23.cellId, parentId: v23.eventId, kind: "target.cell.commit", author: "alice", payload: { value: "Herodes se turbó.", targetLang: "sw" }, clientTs: Date.now() }] }),
    })
  }
  const installed = await fetch(`${AUTH_BASE}/api/v2/projects/${seeded.projectId}/tools`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ source: FOCUS_EDITOR_SOURCE, manifest: FOCUS_EDITOR_MANIFEST, origin: "starter", grant: ["read:cells"] }),
  })
  expect(installed.status).toBe(201)

  const tools = new ToolsPage(page)
  await openSeededProject(page, seeded)
  const timeline: Record<string, number> = { editorOpen: Date.now() - t0 }
  await page.waitForTimeout(1500)

  await tools.switchEditor("Focus Editor")
  const frame = tools.toolFrame("Focus Editor")
  const box = frame.getByLabel("Translation")
  await frame.getByRole("button", { name: "Go to MAT 1:1" }).click()
  await page.waitForTimeout(800)
  await box.pressSequentially("Libro de la genealogía de Jesucristo, hijo de David.", { delay: 25 })
  await box.press("Control+Enter")
  await expect(tools.permissionPrompt()).toBeVisible()
  await page.waitForTimeout(1000)
  await tools.answerPrompt("Always allow")
  await expect(frame.locator(".ref")).toContainText("MAT 1:2")
  await box.pressSequentially("Abraham engendró a Isaac.", { delay: 25 })
  await frame.getByRole("button", { name: "Validate" }).click()
  await expect(tools.permissionPrompt()).toBeVisible()
  await page.waitForTimeout(1000)
  await tools.answerPrompt("Always allow")
  await expect(frame.getByText("Validated", { exact: true }).first()).toBeVisible()
  await page.waitForTimeout(700)
  await box.press("Alt+ArrowDown")
  await box.pressSequentially("José llamó al niño Jesús.", { delay: 25 })
  await box.press("Control+Shift+Enter")
  await expect(frame.getByText("Validated", { exact: true }).first()).toBeVisible()
  await page.waitForTimeout(1500)

  await tools.switchEditor("Standard editor")
  await expect(page.getByText("José llamó al niño Jesús.").first()).toBeVisible()
  await page.waitForTimeout(3000)

  await tools.open(seeded.projectId)
  const activity = await tools.openActivity("Focus Editor")
  await expect(activity.getByTestId("tool-activity-row").first()).toBeVisible()
  await activity.scrollIntoViewIfNeeded()
  await page.waitForTimeout(3500)
  timeline.end = Date.now() - t0
  writeFileSync(testInfo.outputPath("timeline.json"), JSON.stringify(timeline, null, 2))
})
