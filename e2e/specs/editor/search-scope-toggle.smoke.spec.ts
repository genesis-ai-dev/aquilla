import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * ParallelPassagesPanel — scope and side tab toggles.
 *
 * The search panel has three SegmentTabs groups in the "Panel controls" row:
 *   - "Search scope" (Project, File)
 *   - "Search mode" (Search, Passages, Replace)
 *   - "Content side" (Both, Source, Target)
 *
 * Each tab has aria-selected reflecting the current value.
 *
 * This spec: opens the panel via Cmd/Ctrl+K → verifies "Project" is selected →
 * clicks "Both" content side → verifies it's selected → clicks "Source" →
 * "Source" becomes selected.
 */
test("search panel content side toggle changes aria-selected", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `SearchScope ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Open the search panel. AQU-308 removed the toolbar "Search & replace"
  // button; Cmd/Ctrl+K is the documented project-wide search shortcut
  // (ProjectWorkspace keydown handler: mode "search", scope "project").
  await alice.keyboard.press("ControlOrMeta+k")

  const panel = alice.getByRole("dialog")
  await expect(panel).toBeVisible({ timeout: 5_000 })

  // "Project" scope tab is selected (Cmd+K contract: project-wide search).
  const projectTab = panel.getByRole("tab", { name: /^Project$/i })
  await expect(projectTab).toBeVisible({ timeout: 3_000 })
  await expect(projectTab).toHaveAttribute("aria-selected", "true")

  // Content side: "Both" is selected by default.
  const bothTab = panel.getByRole("tab", { name: /^Both$/i })
  await expect(bothTab).toHaveAttribute("aria-selected", "true", { timeout: 3_000 })

  // Click "Source".
  const sourceTab = panel.getByRole("tab", { name: /^Source$/i })
  await expect(sourceTab).toBeVisible({ timeout: 3_000 })
  await sourceTab.click()
  await expect(sourceTab).toHaveAttribute("aria-selected", "true", { timeout: 2_000 })
  await expect(bothTab).toHaveAttribute("aria-selected", "false")

  // Restore Both.
  await bothTab.click()
  await expect(bothTab).toHaveAttribute("aria-selected", "true", { timeout: 2_000 })

  // Dismiss.
  await alice.keyboard.press("Escape")
})
