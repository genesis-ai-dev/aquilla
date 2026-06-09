import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * AssignWork — submitting the assignment form.
 *
 * AssignWork.tsx renders a form with:
 *   - Assignee <select> (org members)
 *   - Book <select> (project files)
 *   - Chapter <select> (optional sections)
 *   - Deadline <input type="date"> (optional)
 *   - "Assign" button (disabled until assignee + file selected)
 *
 * On submit, createAssignment() posts an assignment.create event to the
 * sync-worker. On success, {done} message appears:
 *   "Assigned <scopeLabel> to <name>."
 *
 * This spec extends assign-work-panel.smoke.spec.ts to cover the submit
 * path (not just opening the panel).
 *
 * Setup: alice (org owner) creates project → imports sample.md →
 * opens ProjectOverview → opens Assign panel → selects herself as
 * assignee + the imported file → clicks Assign → success message appears.
 */
test("AssignWork form submits and shows success message", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `AssignSubmit ${Date.now()}`
  await dash.createProject({ name })
  await dash.openProject(name)

  await alice.waitForURL(/\/project\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/project\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  // Import a file so the "Book" dropdown has an option.
  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)

  // Navigate to the org project overview (ProjectOverview.tsx).
  await alice.goto(`/projects/${projectId}`)
  await alice.waitForLoadState("networkidle")

  // The "Assign…" button should be visible for the project owner.
  const assignBtn = alice.getByRole("button", { name: /^Assign…$/i })
  await expect(assignBtn).toBeVisible({ timeout: 10_000 })
  await assignBtn.click()

  // The assign panel opens with Assignee and Book selects.
  const panel = alice.locator('[role="group"][aria-label="Assign work"]')
  await expect(panel).toBeVisible({ timeout: 5_000 })

  // Select assignee — alice is in the org so her option should appear.
  const assigneeSelect = panel.locator('select[aria-label="Assignee"]')
  await expect(assigneeSelect).toBeVisible({ timeout: 5_000 })

  // Wait for org members to load (API call on panel open).
  await alice.waitForTimeout(1_500)

  // Select alice as the assignee (she's the project owner, so she's in the org).
  const assigneeOptions = await assigneeSelect.locator("option").allTextContents()
  const aliceOption = assigneeOptions.find((t) => t.toLowerCase().includes("alice"))
  if (aliceOption) {
    await assigneeSelect.selectOption({ label: aliceOption })
  } else {
    // Fallback: select the first non-empty option.
    const options = assigneeOptions.filter((t) => !t.includes("Select member"))
    if (options.length > 0) await assigneeSelect.selectOption({ label: options[0] })
  }

  // Book dropdown should already have sample.md selected (first file).
  const bookSelect = panel.locator('select[aria-label="Book"]')
  await expect(bookSelect).toBeVisible({ timeout: 3_000 })
  // Verify it has at least one file option (sample.md).
  await expect(bookSelect.locator("option").first()).toBeVisible({ timeout: 5_000 })

  // Click "Assign" — the submit button.
  const submitBtn = panel.getByRole("button", { name: /^Assign$/i })
  await expect(submitBtn).toBeEnabled({ timeout: 3_000 })
  await submitBtn.click()

  // Success message: "Assigned <file> to <name>."
  const successMsg = panel.locator("p").filter({ hasText: /Assigned .+ to .+\./i }).first()
  await expect(successMsg).toBeVisible({ timeout: 10_000 })
})
