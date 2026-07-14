import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * ImportDialog — "Coming soon" import types are rendered but disabled.
 *
 * ImportDialog.tsx shows a first-level "import type" selector screen
 * (ImportLanding). Macula and Translation Notes graduated to enabled Beta
 * importers (AQU-178/AQU-179/AQU-310); the only remaining coming-soon item
 * is Translation Memory, rendered as a disabled div with:
 *   title="Coming soon — Translation Memory import is tracked in AQU-179"
 *   class "cursor-not-allowed ... opacity-50"
 *
 * This spec: opens the import dialog, verifies the Translation Memory item
 * is visible-but-disabled with app tooltip metadata, and verifies the
 * graduated Macula / Translation Notes options are now enabled buttons.
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

  // Translation Memory is the remaining coming-soon item: a disabled option
  // using app tooltip metadata and disabled styling.
  const tmDiv = dialog.getByRole("button", { name: /Translation Memory TMX/i })
  await expect(tmDiv).toBeVisible({ timeout: 5_000 })
  await expect(tmDiv).toHaveAttribute("aria-disabled", "true")
  await expect(tmDiv).toHaveClass(/cursor-not-allowed|opacity/)

  // Macula graduated to an enabled Beta importer (AQU-178/AQU-310).
  const maculaBtn = dialog.getByRole("button", { name: /Macula Hebrew \+ Greek/i })
  await expect(maculaBtn).toBeVisible({ timeout: 3_000 })
  await expect(maculaBtn).toBeEnabled()

  // Translation Notes graduated to an enabled Beta importer (AQU-179/AQU-310).
  const notesBtn = dialog.getByRole("button", { name: /Translation Notes TSV/i })
  await expect(notesBtn).toBeVisible({ timeout: 3_000 })
  await expect(notesBtn).toBeEnabled()

  // Dismiss.
  await alice.keyboard.press("Escape")
})
