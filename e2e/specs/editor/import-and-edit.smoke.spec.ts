import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

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
  await alice.waitForLoadState("networkidle")
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()
  await expect(ws.cellRow(0)).toContainText(text, { timeout: 5_000 })
})

test("alice's queued cell edit remains visible after reload before server sync", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `Editor pending ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  await alice.route(/\/events$/, async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({ status: 503, body: "held by pending-outbox test" })
      return
    }
    await route.continue()
  })

  const text = `Queued e2e ${Date.now()}`
  await ws.editCellWithoutServerWait(0, text)
  await expect(alice.getByRole("button", { name: /Queued \d+/ })).toBeVisible({ timeout: 5_000 })

  await alice.reload()
  await alice.waitForLoadState("networkidle")
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()
  await expect(ws.cellRow(0)).toContainText(text, { timeout: 5_000 })
})
