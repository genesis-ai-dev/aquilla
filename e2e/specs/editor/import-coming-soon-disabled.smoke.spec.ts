import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * ImportDialog — "Coming soon" import types are rendered but disabled.
 *
 * ImportDialog.tsx shows a first-level "import type" selector screen.
 * Some options (Macula, Translation Memory, Translation Notes) are
 * rendered as disabled divs with:
 *   title="Coming soon — Macula import is tracked in FRO-178"
 *   title="Coming soon — Translation Memory import is tracked in FRO-179"
 *   class "cursor-not-allowed ... opacity-50"
 *
 * This spec: opens the import dialog and verifies the Coming soon
 * items are visible and have the "Coming soon" tooltip text.
 */
test("import dialog shows Coming soon items as disabled", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `ImportSoon ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  // Open the import dialog — lands on the type-selector screen.
  const importBtn = alice.getByRole("button", { name: /^Import$/i })
  await expect(importBtn).toBeVisible({ timeout: 10_000 })
  await importBtn.click()

  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 8_000 })

  // Macula coming-soon div should be visible with its tooltip.
  const maculaDiv = dialog.locator('[title*="Macula import"]')
  await expect(maculaDiv).toBeVisible({ timeout: 5_000 })
  await expect(maculaDiv).toHaveClass(/cursor-not-allowed|opacity/)

  // Translation Memory coming-soon div.
  const tmDiv = dialog.locator('[title*="Translation Memory import"]')
  await expect(tmDiv).toBeVisible({ timeout: 3_000 })
  await expect(tmDiv).toHaveClass(/cursor-not-allowed|opacity/)

  // Dismiss.
  await alice.keyboard.press("Escape")
})
