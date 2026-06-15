import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * CharacterModal — color picker opens and allows picking a color.
 *
 * CharacterModal.tsx renders a ColorPicker button (aria-label="Character color")
 * that opens a palette of color swatches. Each swatch has
 * aria-label="Pick color #rrggbb". Clicking a color closes the palette and
 * updates the character color.
 *
 * This spec: open CharacterModal (via "+ New voice") → click "Character color"
 * button → verify color palette opens (multiple "Pick color" buttons) →
 * click the first color → palette closes.
 */
test("voice character color picker opens palette and picks a color", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `ColorPick ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Switch to Audio mode.
  const audioBtn = alice.getByRole("button", { name: /^Audio$/i })
  await expect(audioBtn).toBeVisible({ timeout: 10_000 })
  await audioBtn.click()
  await expect(audioBtn).toHaveAttribute("aria-pressed", "true", { timeout: 3_000 })

  // Click "+ New voice" to open the VoiceCreator.
  const newVoiceBtn = alice.getByRole("button", { name: /New voice/i })
  await expect(newVoiceBtn).toBeVisible({ timeout: 10_000 })
  await newVoiceBtn.click()

  // VoiceCreator opens — verify "Voice name" input is visible.
  await expect(alice.locator('[aria-label="Voice name"]')).toBeVisible({ timeout: 5_000 })

  // Click the "Voice color" button to open the palette.
  const colorBtn = alice.locator('[aria-label="Voice color"]')
  await expect(colorBtn).toBeVisible({ timeout: 3_000 })
  await colorBtn.click()

  // Palette opens — multiple "Pick color" buttons appear.
  const colorSwatches = alice.locator('[aria-label^="Pick color"]')
  await expect(colorSwatches.first()).toBeVisible({ timeout: 3_000 })

  // Click the first swatch. The palette popover animates in, so Playwright's
  // stability check can spin until the test budget dies — wait for the
  // entrance transition to settle, then force past the residual animation.
  await alice.waitForTimeout(350)
  await colorSwatches.first().click({ force: true })

  // Palette closes (first swatch no longer visible).
  await expect(colorSwatches.first()).not.toBeVisible({ timeout: 2_000 })
})
