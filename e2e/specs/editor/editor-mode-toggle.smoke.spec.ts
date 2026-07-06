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
 * ProjectWorkspace renders a Tabs control with two tab triggers:
 *   <button role="tab" aria-selected="true/false">Text</button>
 *   <button role="tab" aria-selected="true/false">Audio</button>
 *
 * Switching lenses is pure local state — no backend call is made.
 *
 * This spec:
 *   1. Imports sample.md so the workspace is open with cells.
 *   2. Verifies "Text" tab has aria-selected=true (default lens).
 *   3. Clicks "Audio" — verifies Audio is now selected, Text is not.
 *   4. Clicks "Text" again — verifies Text is selected again.
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
  const textTab = alice.getByRole("tab", { name: /^Text$/i })
  const audioTab = alice.getByRole("tab", { name: /^Audio$/i })

  await expect(textTab).toBeVisible({ timeout: 5_000 })
  await expect(textTab).toHaveAttribute("aria-selected", "true")
  await expect(audioTab).toHaveAttribute("aria-selected", "false")

  // Switch to Audio lens.
  await audioTab.click()
  await expect(audioTab).toHaveAttribute("aria-selected", "true", { timeout: 3_000 })
  await expect(textTab).toHaveAttribute("aria-selected", "false")

  // Switch back to Text lens.
  await textTab.click()
  await expect(textTab).toHaveAttribute("aria-selected", "true", { timeout: 3_000 })
  await expect(audioTab).toHaveAttribute("aria-selected", "false")
})
