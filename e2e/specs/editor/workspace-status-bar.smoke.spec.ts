import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * Workspace status bar (StatusBar.tsx + DecayBreakdown).
 *
 * The editor footer renders:
 *   - A HealthRing (with a DecayBreakdown popover parent)
 *   - Cell count text: "N cells · N translated (N%)"
 *   - Unvalidated / validated pill counts (when non-zero)
 *
 * This spec: import a file, open the editor, verify the cell count text
 * is present in the footer.
 */
test("workspace status bar shows cell count after importing a file", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `StatusBar ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Status bar footer shows "N cells · …"
  const footer = alice.locator("footer")
  await expect(footer).toBeVisible({ timeout: 5_000 })
  await expect(footer.getByText(/cells/i).first()).toBeVisible({ timeout: 5_000 })
})
