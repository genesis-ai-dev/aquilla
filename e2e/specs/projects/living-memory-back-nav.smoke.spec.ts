import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * Living Memory — shell-owned navigation back to the editor.
 *
 * AQU-254 moved Living Memory inside the ProjectWorkspace shell
 * (/project/:id/memory renders ProjectWorkspace with the memory surface in
 * the center). The page's own "Back to project" button was removed —
 * LivingMemoryPage.tsx: "no back button: shell owns nav". Navigation back to
 * the editor is via the persistent sidebar: clicking a file row calls
 * setActiveFileId → navigate(`/project/:id/editor/file/:fileId`).
 *
 * This spec: create a project → import a file → open Memory via the sidebar
 * "More" menu → verify the Living Memory page renders inside the shell →
 * click the file row in the sidebar → URL returns to the editor
 * (/project/:id/editor/file/:fileId).
 */
test("living memory shell nav returns to the project editor", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `MemoryBack ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)
  await alice.waitForURL(/\/project\/[^/]+/, { timeout: 10_000 })
  const projectId = alice.url().match(/\/project\/([^/?#]+)/)?.[1]
  expect(projectId).toBeTruthy()

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)

  // Open Living Memory via the sidebar "More" menu (shell-owned nav).
  await alice.getByRole("button", { name: /More project options/i }).click()
  await alice.getByRole("button", { name: /^Memory$/ }).click()
  await alice.waitForURL(/\/project\/[^/]+\/memory$/, { timeout: 5_000 })

  // The memory surface renders inside the workspace shell.
  await expect(alice.getByRole("heading", { name: /Living Memory/i }).first()).toBeVisible({
    timeout: 10_000,
  })
  await expect(alice.locator("aside")).toBeVisible()

  // Click the imported file's sidebar row — shell nav back to the editor.
  await alice.locator("aside").getByText(/sample/i).first().click()
  await alice.waitForURL(/\/project\/[^/]+\/file\/[^/]+/, { timeout: 5_000 })
  await expect(alice.getByRole("heading", { name: /Living Memory/i })).not.toBeVisible({
    timeout: 5_000,
  })
})
