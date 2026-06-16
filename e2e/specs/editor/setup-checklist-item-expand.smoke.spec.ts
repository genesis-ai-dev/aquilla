import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * SetupChecklistDrawer — ChecklistItem expand/collapse.
 *
 * Each checklist item in SetupChecklistDrawer renders via ChecklistItem.tsx,
 * which has an `aria-expanded` button that toggles the detail panel.
 *
 * This spec: open the setup checklist → verify a checklist item exists →
 * click it to expand (aria-expanded="true") → click again to collapse.
 */
test("setup checklist item expands and collapses on click", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `ChecklistExpand ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Open the setup checklist chip.
  const chip = alice.getByRole("button", { name: /Setup:/i })
  await expect(chip).toBeVisible({ timeout: 10_000 })
  await chip.click()

  // Drawer opens with "Project setup" heading.
  await expect(alice.getByRole("heading", { name: /Project setup/i })).toBeVisible({
    timeout: 5_000,
  })

  // Find the first checklist item button (aria-expanded) INSIDE the drawer.
  // Scope to the sheet dialog: the sidebar's "More project options" popover
  // trigger also carries aria-expanded and sits behind the sheet overlay,
  // so an unscoped .first() grabs it and the click is intercepted forever.
  // The first item is "Import files" — complete after importFile() above, so
  // it starts collapsed (ChecklistItem opens incomplete items by default).
  const drawer = alice.getByRole("dialog", { name: /Project setup/i })
  const itemBtn = drawer.locator('button[aria-expanded]').first()
  await expect(itemBtn).toBeVisible({ timeout: 5_000 })
  await expect(itemBtn).toHaveAttribute("aria-expanded", "false")

  // Click to expand.
  await itemBtn.click()
  await expect(itemBtn).toHaveAttribute("aria-expanded", "true", { timeout: 2_000 })

  // Click again to collapse.
  await itemBtn.click()
  await expect(itemBtn).toHaveAttribute("aria-expanded", "false", { timeout: 2_000 })

  // Close drawer.
  await alice.keyboard.press("Escape")
})
