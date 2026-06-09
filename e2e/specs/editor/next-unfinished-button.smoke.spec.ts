import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * NextUnfinishedButton — "Next unfinished" nav button.
 *
 * ProjectWorkspace renders a NextUnfinishedButton (aria-label="Next unfinished",
 * title="Jump to next unfinished cell (Cmd+.)") in the toolbar.
 *
 * It is enabled whenever `useNextUnfinished` finds any cell that lacks a
 * translation or sufficient validators. Freshly-imported cells have no
 * translation, so importing sample.md guarantees the button is enabled.
 *
 * This spec:
 *   1. Imports sample.md.
 *   2. Waits for editor to load (cells are unfinished).
 *   3. Verifies "Next unfinished" button is enabled.
 *   4. Clicks it — verifies the editor is still rendered (no crash).
 *   5. Clicks it again — wraps around, still no crash.
 */
test("Next unfinished button is enabled after import and navigates without error", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `NextUnfinished ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.waitForEditor()

  // The "Next unfinished" button should be enabled (imported cells have no translations).
  const btn = alice.getByRole("button", { name: /Next unfinished/i })
  await expect(btn).toBeVisible({ timeout: 5_000 })
  await expect(btn).toBeEnabled({ timeout: 3_000 })

  // Click — jumps to next unfinished cell; editor should still be visible.
  await btn.click()
  await ws.waitForEditor()

  // Click again — wraps around; still no crash.
  await btn.click()
  await ws.waitForEditor()
})
