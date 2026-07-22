import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * ExportDialog — "Lossy format warning" appears for lossy formats and is
 * absent for non-lossy formats.
 *
 * ExportDialog.tsx renders a warning note (role="note",
 * aria-label="Lossy format warning") that reads:
 *   "This format is lossy — inline markup, paragraph structure, and some
 *    metadata will not round-trip back to the original format."
 *
 * FORMAT_OPTIONS:
 *   - "Plain text" (.txt) → lossy: true
 *   - "Audio by character" (.zip) → lossy: false
 *
 * The warning lives inside the "Export to another format" section. For a .md
 * import the native Markdown format is pre-selected and lossy, so the warning
 * shows once the section is expanded. Switching to "Audio by character" hides
 * it (lossy: false).
 *
 * This spec: open export dialog → expand formats section → verify warning is
 * present (Markdown default is lossy) → switch to "Audio by character" →
 * verify warning is gone → switch to "Plain text" → verify warning reappears.
 */
test("export dialog shows lossy warning for lossy formats and hides it for non-lossy", async ({
  alice,
}) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `ExportLossy ${Date.now()}` })
  const ws = await openSeededProject(alice, seeded)

  // Open Export dialog from the header overflow menu (AQU-331).
  await ws.openExportDialog()

  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await ws.openExportFormatsSection()

  // Markdown (native default for .md) is lossy — warning should be visible.
  const warning = dialog.locator('[aria-label="Lossy format warning"]')
  await expect(warning).toBeVisible({ timeout: 3_000 })

  // Switch to "Audio by character" (lossy: false) — warning should disappear.
  // Base UI radio: role=radio with aria-label "Audio by character (.zip)";
  // the native input[type=radio] is hidden and not actionable.
  const audioByChar = dialog.getByRole("radio", { name: /^Audio by character/ })
  await expect(audioByChar).toBeVisible({ timeout: 3_000 })
  await audioByChar.check()
  await expect(warning).not.toBeVisible({ timeout: 2_000 })

  // Switch to "Plain text" (lossy: true) — warning reappears.
  // (^Plain text avoids the Advanced-only "Plain-text dump" option.)
  const plainText = dialog.getByRole("radio", { name: /^Plain text \(\.txt\)/ })
  await expect(plainText).toBeVisible({ timeout: 2_000 })
  await plainText.check()
  await expect(warning).toBeVisible({ timeout: 2_000 })
})
