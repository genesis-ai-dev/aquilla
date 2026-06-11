import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * Next unfinished — lives in the workspace header ⋯ overflow menu (FRO-331).
 */
test("Next unfinished menu item navigates without error", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `NextUnfinished ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.waitForEditor()

  await ws.openHeaderOverflowMenu()
  const item = alice.getByRole("menuitem", { name: /Next unfinished/i })
  await expect(item).toBeVisible({ timeout: 3_000 })
  await expect(item).toBeEnabled({ timeout: 3_000 })

  await item.click()
  await ws.waitForEditor()

  await ws.jumpNextUnfinished()
  await ws.waitForEditor()
})
