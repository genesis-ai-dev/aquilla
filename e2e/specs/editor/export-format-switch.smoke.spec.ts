import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * ExportDialog — switching export format.
 *
 * Format conversions live behind the "Export to another format" collapse
 * (the primary action is the native "Download <file>" button). Inside it,
 * ExportDialog renders a radiogroup (aria-label="Export format") with
 * Base UI radio items (role=radio, aria-label="<Format label> (<ext>)").
 * The native input[type=radio] is hidden/aria-hidden and covered by the
 * dialog overlay — drive the role=radio elements instead.
 *
 * This spec: opens export dialog → expands the formats section → verifies the
 * file's native format (Markdown for a .md import) is pre-selected → selects
 * CSV → verifies CSV radio is now checked → Export downloads .csv.
 */
test("export format switch to CSV triggers a CSV download", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `ExportFmt ${Date.now()}` })
  const ws = await openSeededProject(alice, seeded)

  // Open Export dialog from header overflow (AQU-331), then expand the
  // "Export to another format" section (collapsed by default for .md files).
  await ws.openExportDialog()
  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await ws.openExportFormatsSection()

  // The file's native format (Markdown for a .md import) is pre-selected.
  const mdRadio = dialog.getByRole("radio", { name: /^Markdown/ })
  await expect(mdRadio).toBeChecked({ timeout: 3_000 })

  // Switch to CSV.
  const csvRadio = dialog.getByRole("radio", { name: /^Bilingual CSV/ })
  await expect(csvRadio).toBeVisible({ timeout: 3_000 })
  await csvRadio.check()
  await expect(csvRadio).toBeChecked({ timeout: 3_000 })

  // Export → download should be a .csv file.
  const [download] = await Promise.all([
    alice.waitForEvent("download", { timeout: 10_000 }),
    dialog.getByRole("button", { name: /^Export$/i }).click(),
  ])
  expect(download.suggestedFilename()).toMatch(/\.csv$/i)

  await alice.keyboard.press("Escape")
})
