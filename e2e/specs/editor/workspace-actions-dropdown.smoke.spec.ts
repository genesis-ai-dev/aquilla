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
 * on Escape without triggering any action.
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

  // Click the chevron "More actions" button to open the dropdown.
  const moreBtn = alice.getByRole("button", { name: /More actions/i })
  await expect(moreBtn).toBeVisible({ timeout: 10_000 })
  await moreBtn.click()

  // Dropdown is open — at minimum "Export" is always available.
  await expect(alice.getByRole("menuitem", { name: /Export/i })
    .or(alice.getByText(/Export/i).nth(1))
  ).toBeVisible({ timeout: 3_000 })

  // "Run AI completions" appears (it's available because activeFileId is set).
  await expect(
    alice.getByText(/Run AI completions/i).first()
  ).toBeVisible({ timeout: 3_000 })

  // Close with Escape.
  await alice.keyboard.press("Escape")
  // Dropdown closes — More actions button is still visible but dropdown is gone.
  await expect(
    alice.locator(".absolute.right-0.top-full")
  ).not.toBeVisible({ timeout: 3_000 })
})
