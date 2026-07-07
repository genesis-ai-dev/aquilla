import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * PrimaryActionButton "More actions" dropdown.
 *
 * The workspace header has a split button: the left part runs the default
 * action, the right chevron opens a dropdown listing all available actions.
 *
 * With a file open and untranslated cells:
 *   - "Run AI completions" is the default action (translated < total)
 *   - The dropdown should include all primary actions available for the file:
 *     "Export", "Batch validate…", and potentially others
 *
 * This spec verifies the dropdown opens, lists multiple actions, and closes
 * without triggering any action.
 */
test("workspace actions dropdown lists available actions", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `Actions ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  const moreBtn = alice.getByRole("button", { name: /More actions/i })
  await expect(moreBtn).toBeVisible({ timeout: 10_000 })
  await moreBtn.click()

  const menu = alice.getByRole("menu")
  await expect(menu).toBeVisible({ timeout: 3_000 })

  await expect(menu.getByRole("menuitem", { name: /^Export$/i })).toBeVisible({ timeout: 3_000 })
  await expect(
    menu.getByRole("menuitem", { name: /Run AI completions/i })
  ).toBeVisible({ timeout: 3_000 })

  await alice.keyboard.press("Escape")
  await expect(menu).not.toBeVisible({ timeout: 3_000 })
})
