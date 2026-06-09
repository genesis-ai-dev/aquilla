import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * EditorModeToggle — Text | Audio lens switcher.
 *
 * ProjectWorkspace renders a segmented toggle with two buttons:
 *   <button aria-pressed="true/false">Text</button>
 *   <button aria-pressed="true/false">Audio</button>
 *
 * Switching lenses is pure local state — no backend call is made.
 *
 * This spec:
 *   1. Imports sample.md so the workspace is open with cells.
 *   2. Verifies "Text" button has aria-pressed=true (default lens).
 *   3. Clicks "Audio" — verifies Audio is now pressed, Text is not.
 *   4. Clicks "Text" again — verifies Text is pressed again.
 */
test("EditorModeToggle switches between Text and Audio lenses", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `LensToggle ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.waitForEditor()

  // Default lens is Text.
  const textBtn = alice.getByRole("button", { name: /^Text$/i })
  const audioBtn = alice.getByRole("button", { name: /^Audio$/i })

  await expect(textBtn).toBeVisible({ timeout: 5_000 })
  await expect(textBtn).toHaveAttribute("aria-pressed", "true")
  await expect(audioBtn).toHaveAttribute("aria-pressed", "false")

  // Switch to Audio lens.
  await audioBtn.click()
  await expect(audioBtn).toHaveAttribute("aria-pressed", "true", { timeout: 3_000 })
  await expect(textBtn).toHaveAttribute("aria-pressed", "false")

  // Switch back to Text lens.
  await textBtn.click()
  await expect(textBtn).toHaveAttribute("aria-pressed", "true", { timeout: 3_000 })
  await expect(audioBtn).toHaveAttribute("aria-pressed", "false")
})
