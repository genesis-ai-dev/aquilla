import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * Project setup checklist (SetupChecklistDrawer).
 *
 * A fresh project has 3 setup items (AI instructions, collaborators, AI models).
 * A chip "Setup: 0/3" appears in the workspace header. Clicking it opens a
 * Sheet with SheetTitle "Project setup" and a progress bar.
 *
 * This spec verifies the chip renders and the drawer opens.
 */
test("setup checklist chip opens drawer with Project setup title", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `Checklist ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // The "Setup: 0/N" chip appears in the workspace header.
  const chip = alice.locator('[title="Open setup checklist"]')
  await expect(chip).toBeVisible({ timeout: 10_000 })
  await chip.click()

  // SetupChecklistDrawer opens as a Sheet.
  // SheetTitle is "Project setup".
  await expect(
    alice.getByRole("heading", { name: /Project setup/i })
  ).toBeVisible({ timeout: 5_000 })

  // Progress description: "X of N complete"
  await expect(
    alice.getByText(/of \d+ complete/i)
  ).toBeVisible({ timeout: 3_000 })

  // Close with Escape.
  await alice.keyboard.press("Escape")
  await expect(
    alice.getByRole("heading", { name: /Project setup/i })
  ).not.toBeVisible({ timeout: 3_000 })
})
