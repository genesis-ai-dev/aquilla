import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * Text ↔ Audio lens toggle (EditorModeToggle).
 *
 * The header bar shows a segmented control with "Text" and "Audio" buttons.
 * Each button carries aria-pressed reflecting the active lens. Toggling is
 * client-side only (no route change) so cells remain mounted.
 */
test("text/audio mode toggle switches lens and preserves editor mount", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `AudioMode ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // The toggle is a segmented control — two buttons with aria-pressed.
  const textBtn = alice.getByRole("button", { name: /^Text$/i })
  const audioBtn = alice.getByRole("button", { name: /^Audio$/i })

  await expect(textBtn).toBeVisible({ timeout: 5_000 })
  await expect(audioBtn).toBeVisible({ timeout: 5_000 })

  // 1. Initially in Text mode: Text pressed, Audio not pressed.
  await expect(textBtn).toHaveAttribute("aria-pressed", "true")
  await expect(audioBtn).toHaveAttribute("aria-pressed", "false")

  // 2. Switch to Audio lens.
  await audioBtn.click()
  await expect(audioBtn).toHaveAttribute("aria-pressed", "true", { timeout: 3_000 })
  await expect(textBtn).toHaveAttribute("aria-pressed", "false")

  // The editor cells should still be mounted (lens toggle doesn't unmount the list).
  await expect(alice.locator("[data-cell-id]").first()).toBeVisible({ timeout: 5_000 })

  // 3. Switch back to Text lens.
  await textBtn.click()
  await expect(textBtn).toHaveAttribute("aria-pressed", "true", { timeout: 3_000 })
  await expect(audioBtn).toHaveAttribute("aria-pressed", "false")
})
