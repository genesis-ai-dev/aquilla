import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * ImportDialog specialized formats remain discoverable and actionable.
 *
 * TMX now enters the unified Upload Files pipeline; Macula and Translation
 * Notes retain their purpose-built panels. This guards the landing-page
 * routing contract rather than stale rollout badges.
 */
test("import dialog enables TMX, Macula, and Translation Notes routes", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `ImportSoon ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  // Open the import dialog — lands on the type-selector screen.
  const importBtn = alice.getByRole("button", {
    name: /^Import(?: a file)?$/i,
  })
  await expect(importBtn).toBeVisible({ timeout: 10_000 })
  await importBtn.click()

  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 8_000 })

  const tmBtn = dialog.getByRole("button", { name: /Translation Memory TMX/i })
  await expect(tmBtn).toBeVisible({ timeout: 5_000 })
  await expect(tmBtn).toBeEnabled()

  // Macula graduated to an enabled Beta importer (AQU-178/AQU-310).
  const maculaBtn = dialog.getByRole("button", { name: /Macula Hebrew \+ Greek/i })
  await expect(maculaBtn).toBeVisible({ timeout: 3_000 })
  await expect(maculaBtn).toBeEnabled()

  // Translation Notes graduated to an enabled Beta importer (AQU-179/AQU-310).
  const notesBtn = dialog.getByRole("button", { name: /Translation Notes TSV/i })
  await expect(notesBtn).toBeVisible({ timeout: 3_000 })
  await expect(notesBtn).toBeEnabled()

  // TMX routes to the unified upload surface, whose accepted-format summary
  // explicitly includes TMX before the user chooses a file.
  await tmBtn.click()
  await expect(dialog.getByRole("heading", { name: /Upload Files/i })).toBeVisible()
  await expect(dialog.getByText(/Translation.*XLIFF\/XLF, TMX, CSV\/TSV/i)).toBeVisible()
})
