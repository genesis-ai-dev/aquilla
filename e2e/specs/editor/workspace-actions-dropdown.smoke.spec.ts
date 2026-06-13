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
 * (via the trigger toggle) without triggering any action. Note: the dropdown
 * is hand-rolled (plain buttons, no menu roles, no Escape handling) — see
 * the rehab report for the recommended migration to the DropdownMenu primitive.
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

  // PrimaryActionButton's dropdown is a hand-rolled div of plain <button>
  // items (no role=menu / role=menuitem).
  const dropdown = alice.locator(".absolute.right-0.top-full")
  await expect(dropdown).toBeVisible({ timeout: 3_000 })

  // At minimum "Export" is available (activeFileId is set).
  await expect(dropdown.getByRole("button", { name: /^Export$/i })).toBeVisible({ timeout: 3_000 })

  // "Run AI completions" is listed too (available because activeFileId is set).
  await expect(
    dropdown.getByRole("button", { name: /Run AI completions/i })
  ).toBeVisible({ timeout: 3_000 })

  // Close without triggering any action. The hand-rolled dropdown has no
  // Escape handler (it only closes on outside mousedown / trigger toggle),
  // so toggle it shut via the chevron.
  await moreBtn.click()
  // Dropdown closes — More actions button is still visible but dropdown is gone.
  await expect(dropdown).not.toBeVisible({ timeout: 3_000 })
})
