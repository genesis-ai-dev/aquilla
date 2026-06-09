import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * EditorModeToggle — Text / Audio lens switch in the workspace header.
 *
 * EditorModeToggle.tsx renders two aria-pressed buttons:
 *   - "Text" (aria-pressed="true" by default)
 *   - "Audio" (aria-pressed="false" by default)
 *
 * Clicking "Audio" switches the lens; "Text" switches back.
 *
 * This spec: open the workspace → verify Text is pressed / Audio is not →
 * click Audio → Audio becomes pressed / Text is not → click Text → back.
 */
test("EditorModeToggle switches between Text and Audio lens", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `ModeToggle ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Locate the Text and Audio buttons.
  const textBtn = alice.getByRole("button", { name: /^Text$/i })
  const audioBtn = alice.getByRole("button", { name: /^Audio$/i })

  await expect(textBtn).toBeVisible({ timeout: 10_000 })
  await expect(audioBtn).toBeVisible({ timeout: 5_000 })

  // Default: Text is pressed, Audio is not.
  await expect(textBtn).toHaveAttribute("aria-pressed", "true")
  await expect(audioBtn).toHaveAttribute("aria-pressed", "false")

  // Switch to Audio.
  await audioBtn.click()
  await expect(audioBtn).toHaveAttribute("aria-pressed", "true", { timeout: 3_000 })
  await expect(textBtn).toHaveAttribute("aria-pressed", "false")

  // Switch back to Text.
  await textBtn.click()
  await expect(textBtn).toHaveAttribute("aria-pressed", "true", { timeout: 3_000 })
  await expect(audioBtn).toHaveAttribute("aria-pressed", "false")
})
