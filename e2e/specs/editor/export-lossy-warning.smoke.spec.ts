import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

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
 * The default selected format is TSV (lossy), so the warning shows by default.
 * Switching to "Audio by character" hides it (lossy: false).
 *
 * This spec: open export dialog → verify warning is present (TSV is default) →
 * switch to "Audio by character" → verify warning is gone → switch back to
 * "Plain text" → verify warning reappears.
 */
test("export dialog shows lossy warning for lossy formats and hides it for non-lossy", async ({
  alice,
}) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `ExportLossy ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Open Export dialog.
  const exportBtn = alice.getByRole("button", { name: /^Export$/i })
    .or(alice.getByRole("button", { name: /Export file/i }))
    .first()
  await expect(exportBtn).toBeVisible({ timeout: 10_000 })
  await exportBtn.click()

  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })

  // TSV (default) is lossy — warning should be visible.
  const warning = dialog.locator('[aria-label="Lossy format warning"]')
  await expect(warning).toBeVisible({ timeout: 3_000 })

  // Switch to "Audio by character" (lossy: false) — warning should disappear.
  const audioByChar = dialog.locator('input[type="radio"][aria-label*="Audio by character"]')
  await expect(audioByChar).toBeVisible({ timeout: 3_000 })
  await audioByChar.check()
  await expect(warning).not.toBeVisible({ timeout: 2_000 })

  // Switch to "Plain text" (lossy: true) — warning reappears.
  const plainText = dialog.locator('input[type="radio"][aria-label*="Plain text"]')
  await expect(plainText).toBeVisible({ timeout: 2_000 })
  await plainText.check()
  await expect(warning).toBeVisible({ timeout: 2_000 })
})
