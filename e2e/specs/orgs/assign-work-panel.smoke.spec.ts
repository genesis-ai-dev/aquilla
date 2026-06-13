import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * AssignWork panel — clicking "Assign…" opens the assignment form.
 *
 * AssignWork.tsx renders as a button labelled "Assign…" when collapsed.
 * When opened it shows a group with aria-label="Assign work" containing:
 *   - <select aria-label="Assignee">
 *   - <select aria-label="Book">
 *   - <select aria-label="Chapter">
 *   - <input aria-label="Deadline (optional)">
 *
 * The component is rendered in ProjectOverview.tsx for maintainer+ users.
 * Alice is the project owner so she should see the Assign panel.
 *
 * This spec: create a project → import a file → navigate to the org
 * project overview → click "Assign…" → verify the panel opens with the
 * Assignee and Book selects visible.
 */
test("assign-work panel opens and shows Assignee and Book selects", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `AssignProj ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  // Import a file so there is a "Book" to assign.
  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)

  // Navigate to the org project overview.
  await alice.waitForURL(/\/project\/([^/]+)\//, { timeout: 5_000 })
  const projectId = alice.url().match(/\/project\/([^/]+)\//)?.[1]
  expect(projectId).toBeTruthy()

  await alice.goto(`/projects/${projectId}`)
  await alice.waitForLoadState("networkidle")

  // The "Assign…" button should be visible for the project owner.
  const assignBtn = alice.getByRole("button", { name: /^Assign…$/i })
    .or(alice.getByRole("button", { name: /^Assign$/i }))
    .first()
  await expect(assignBtn).toBeVisible({ timeout: 10_000 })
  await assignBtn.click()

  // The assign panel should open.
  const panel = alice.locator('[aria-label="Assign work"]')
  await expect(panel).toBeVisible({ timeout: 5_000 })

  // Assignee select is visible.
  const assigneeSelect = panel.locator('[aria-label="Assignee"]')
  await expect(assigneeSelect).toBeVisible({ timeout: 3_000 })

  // Book select is visible.
  const bookSelect = panel.locator('[aria-label="Book"]')
  await expect(bookSelect).toBeVisible({ timeout: 3_000 })

  // Cancel closes the panel.
  const cancelBtn = panel.getByRole("button", { name: /^Cancel$/i })
  await expect(cancelBtn).toBeVisible({ timeout: 2_000 })
  await cancelBtn.click()
  await expect(panel).not.toBeVisible({ timeout: 3_000 })
})
