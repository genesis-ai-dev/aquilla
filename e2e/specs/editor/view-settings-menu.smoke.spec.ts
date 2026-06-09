import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * ViewSettingsMenu — Eye icon button in the workspace toolbar.
 *
 * Opens a Radix Menu with toggleable items:
 *   - "Show line numbers" (Pill toggle)
 *   - "Show cell labels" (Pill toggle)
 *   - Text direction: Source and Target (DirPill)
 *
 * This spec: open a file → click the "View settings" button (title="View settings")
 * → menu opens with "Show line numbers" and "Show cell labels" items
 * → click "Show line numbers" → menu closes (menu item click dismisses it)
 */
test("view settings menu opens and toggles show line numbers", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `ViewSettings ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // "View settings" Eye icon button.
  const viewSettingsBtn = alice.getByRole("button", { name: /View settings/i })
    .or(alice.locator('[title="View settings"]'))
  await expect(viewSettingsBtn.first()).toBeVisible({ timeout: 5_000 })
  await viewSettingsBtn.first().click()

  // Menu opens — "Show line numbers" item is visible.
  const lineNumbersItem = alice.getByText(/Show line numbers/i).first()
  await expect(lineNumbersItem).toBeVisible({ timeout: 3_000 })

  // "Show cell labels" item is also present.
  await expect(alice.getByText(/Show cell labels/i).first()).toBeVisible({ timeout: 3_000 })

  // Click "Show line numbers" — menu item fires, menu closes.
  await lineNumbersItem.click()

  // Menu is dismissed after clicking an item.
  await expect(lineNumbersItem).not.toBeVisible({ timeout: 3_000 })
})
