import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * ParallelPassagesPanel — Search mode toggle: Search vs Passages.
 *
 * ParallelPassagesPanel has a "Search mode" PillToggle with options:
 *   - "Search" (default, aria-pressed="true")
 *   - "Passages" (aria-pressed="false")
 *   - "Replace"
 *
 * Clicking "Passages" makes it the active mode.
 *
 * This spec: open the search panel → verify "Search" mode is pressed →
 * click "Passages" → verify "Passages" is now pressed.
 */
test("search panel Passages mode toggle changes active mode", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `SearchMode ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Open the search panel. FRO-308: the toolbar "Search & replace" button was
  // replaced by the dock rail Search tab; the full ParallelPassagesPanel
  // dialog opens from the dock panel's "Open full search panel" button.
  await alice.getByRole("button", { name: "Search", exact: true }).click()
  const openFullBtn = alice.getByRole("button", { name: "Open full search panel" })
  await expect(openFullBtn).toBeVisible({ timeout: 5_000 })
  await openFullBtn.click()

  const panel = alice.getByRole("dialog")
  await expect(panel).toBeVisible({ timeout: 5_000 })

  // "Search" mode pill is pressed by default.
  const searchPill = panel.getByRole("button", { name: /^Search$/i })
  await expect(searchPill).toBeVisible({ timeout: 3_000 })
  await expect(searchPill).toHaveAttribute("aria-pressed", "true")

  // Click "Passages".
  const passagesPill = panel.getByRole("button", { name: /^Passages$/i })
  await expect(passagesPill).toBeVisible({ timeout: 3_000 })
  await expect(passagesPill).toHaveAttribute("aria-pressed", "false")
  await passagesPill.click()

  // "Passages" is now pressed, "Search" is not.
  await expect(passagesPill).toHaveAttribute("aria-pressed", "true", { timeout: 2_000 })
  await expect(searchPill).toHaveAttribute("aria-pressed", "false")

  // Dismiss.
  await alice.keyboard.press("Escape")
})
