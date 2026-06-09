import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * TabStrip — open and close file tabs.
 *
 * TabStrip renders a role="tablist" aria-label="Open files" once a file
 * is opened. Each tab has role="tab" with the filename as title and a
 * close button aria-label="Close <filename>".
 *
 * Clicking a second file opens a second tab. Clicking the close button
 * on a tab removes it from the tablist.
 *
 * This spec: import one file → tab appears → close it → tablist empties.
 */
test("TabStrip shows file tab and close button removes it", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `TabStrip ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // TabStrip becomes visible with one tab.
  const tabList = alice.getByRole("tablist", { name: /Open files/i })
  await expect(tabList).toBeVisible({ timeout: 5_000 })

  // There's at least one tab.
  const tabs = tabList.getByRole("tab")
  await expect(tabs.first()).toBeVisible({ timeout: 3_000 })

  // Close the tab (aria-label="Close sample").
  const closeBtn = tabList.getByRole("button", { name: /^Close /i }).first()
  await expect(closeBtn).toBeVisible({ timeout: 3_000 })
  await closeBtn.click()

  // TabStrip disappears (no more open tabs).
  await expect(tabList).not.toBeVisible({ timeout: 5_000 })
})
