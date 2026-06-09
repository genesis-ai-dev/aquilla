import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * Cmd+K / Ctrl+K keyboard shortcut opens the search panel.
 *
 * ProjectWorkspace.tsx keydown handler:
 *   if ((e.metaKey || e.ctrlKey) && !e.altKey && (key === "f" || key === "k"))
 *     → opens ParallelPassagesPanel
 *
 * This spec: open the workspace → import a file → press Ctrl+K →
 * verify the search input panel becomes visible.
 *
 * JOURNEYS.md gap: "Editor: Cmd+K search" (keyboard shortcut path).
 */
test("Ctrl+K keyboard shortcut opens the search panel", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `CmdK ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Press Ctrl+K to open the search panel.
  await alice.keyboard.press("Control+k")

  // The search input in ParallelPassagesPanel should appear.
  // It has aria-label matching the input placeholder or a labelled search field.
  const searchInput = alice.locator('[aria-label="Search project"]')
    .or(alice.locator('[aria-label="Search file"]'))
    .or(alice.locator('input[placeholder*="Search"]').first())
  await expect(searchInput).toBeVisible({ timeout: 5_000 })

  // Press Escape to dismiss — panel should close.
  await alice.keyboard.press("Escape")
  await expect(searchInput).not.toBeVisible({ timeout: 3_000 })
})
