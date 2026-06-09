import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * ViewSettingsMenu — text direction toggle.
 *
 * The menu (opened via the "View settings" button) has two menu items:
 *   - "Source" — toggles source text direction LTR ↔ RTL
 *   - "Target" — toggles target text direction LTR ↔ RTL
 * Each shows a DirPill badge with the current direction text ("LTR" or "RTL").
 *
 * This spec: opens the menu → verifies "Source" menuitem shows "LTR" →
 * clicks it → verifies it now shows "RTL" → clicks again → returns to "LTR".
 */
test("view settings text direction Source toggle switches LTR to RTL", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `TextDir ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Open the view settings menu.
  const viewSettingsBtn = alice.getByRole("button", { name: /View settings/i })
    .or(alice.locator('button[title="View settings"]'))
  await expect(viewSettingsBtn.first()).toBeVisible({ timeout: 10_000 })
  await viewSettingsBtn.first().click()

  // "Source" menu item is visible showing "LTR".
  const sourceItem = alice.getByRole("menuitem", { name: /Source/i })
  await expect(sourceItem).toBeVisible({ timeout: 3_000 })
  await expect(sourceItem.getByText("LTR")).toBeVisible({ timeout: 2_000 })

  // Click Source to toggle to RTL.
  await sourceItem.click()

  // Reopen menu (clicking a menu item closes it).
  await viewSettingsBtn.first().click()

  // Source now shows "RTL".
  const sourceItem2 = alice.getByRole("menuitem", { name: /Source/i })
  await expect(sourceItem2).toBeVisible({ timeout: 3_000 })
  await expect(sourceItem2.getByText("RTL")).toBeVisible({ timeout: 2_000 })

  // Toggle back to LTR.
  await sourceItem2.click()
  await viewSettingsBtn.first().click()
  const sourceItem3 = alice.getByRole("menuitem", { name: /Source/i })
  await expect(sourceItem3.getByText("LTR")).toBeVisible({ timeout: 2_000 })

  // Close menu.
  await alice.keyboard.press("Escape")
})
