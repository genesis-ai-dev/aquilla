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
 * The tab strip shows a Tabs control with "Text" and "Audio" triggers.
 * Each tab carries aria-selected reflecting the active lens. Toggling is
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

  const textTab = alice.getByRole("tab", { name: /^Text$/i })
  const audioTab = alice.getByRole("tab", { name: /^Audio$/i })

  await expect(textTab).toBeVisible({ timeout: 5_000 })
  await expect(audioTab).toBeVisible({ timeout: 5_000 })

  // 1. Initially in Text mode: Text selected, Audio not selected.
  await expect(textTab).toHaveAttribute("aria-selected", "true")
  await expect(audioTab).toHaveAttribute("aria-selected", "false")

  // 2. Switch to Audio lens.
  await audioTab.click()
  await expect(audioTab).toHaveAttribute("aria-selected", "true", { timeout: 3_000 })
  await expect(textTab).toHaveAttribute("aria-selected", "false")

  // The editor cells should still be mounted (lens toggle doesn't unmount the list).
  await expect(alice.locator("[data-cell-id]").first()).toBeVisible({ timeout: 5_000 })

  // 3. Switch back to Text lens.
  await textTab.click()
  await expect(textTab).toHaveAttribute("aria-selected", "true", { timeout: 3_000 })
  await expect(audioTab).toHaveAttribute("aria-selected", "false")
})
