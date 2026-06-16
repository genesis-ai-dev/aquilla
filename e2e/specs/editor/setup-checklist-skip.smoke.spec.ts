import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * SetupChecklistDrawer — "Skip for now" button closes the drawer.
 *
 * SetupChecklistDrawer.tsx renders a Sheet (drawer) with:
 *   - SheetTitle "Project setup"
 *   - Setup items
 *   - "Skip for now" button (when not all items are complete)
 *
 * Clicking "Skip for now" calls onDismiss(), which closes the Sheet.
 *
 * This spec: open the setup checklist → click "Skip for now" →
 * verify the drawer closes (heading disappears).
 */
test("setup checklist Skip for now closes the drawer", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `ChecklistSkip ${Date.now()}`
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
  const heading = alice.getByRole("heading", { name: /Project setup/i })
  await expect(heading).toBeVisible({ timeout: 5_000 })

  // Click "Skip for now".
  const skipBtn = alice.getByRole("button", { name: /Skip for now/i })
  await expect(skipBtn).toBeVisible({ timeout: 3_000 })
  await skipBtn.click()

  // Drawer closes — heading disappears.
  await expect(heading).not.toBeVisible({ timeout: 5_000 })
})
