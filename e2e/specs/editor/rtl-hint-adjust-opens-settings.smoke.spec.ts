import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * ViewSettingsMenu — "Adjust" button in RTL hint opens the view settings menu.
 *
 * When the RTL detection hint is visible (project with Arabic target language),
 * there is an "Adjust" button that calls:
 *   setMenuOpen(true); handleDismissHint()
 *
 * Clicking "Adjust" should:
 *   1. Open the view settings menu (containing "Text Direction", "Show line numbers", etc.)
 *   2. Dismiss the hint at the same time.
 *
 * This spec: creates a project with target "ar" → imports a file → waits for
 * the RTL hint → clicks "Adjust" → verifies the view settings menu opens with
 * "Text Direction" visible → hint is hidden.
 */
test("RTL hint Adjust button opens view settings menu and hides the hint", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `RtlAdjust ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "ar" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // The RTL hint should appear.
  const hint = alice.locator('[role="status"]').filter({ hasText: /right-to-left/i })
  await expect(hint).toBeVisible({ timeout: 8_000 })

  // Click "Adjust" — opens the view settings menu.
  const adjustBtn = hint.getByRole("button", { name: /^Adjust$/i })
  await expect(adjustBtn).toBeVisible({ timeout: 3_000 })
  await adjustBtn.click()

  // The view settings menu popup should open (contains "Text Direction").
  const textDirectionLabel = alice.getByText(/Text Direction/i)
  await expect(textDirectionLabel.first()).toBeVisible({ timeout: 3_000 })

  // The hint is also hidden (Adjust dismisses it).
  await expect(hint).not.toBeVisible({ timeout: 3_000 })
})
