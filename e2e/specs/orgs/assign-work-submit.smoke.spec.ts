import { test, expect } from "../../helpers/multi-user"
import { expectSelectValue } from "../../helpers/base-ui"
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
 *   - "Assign" button (stays enabled; validates on click)
 *
 * On submit, createAssignment() posts an assignment.create event to the
 * sync-worker. On success, the panel collapses so the refreshed workload is
 * visible and reopening starts from a clean form.
 *
 * This spec extends assign-work-panel.smoke.spec.ts to cover the submit
 * path (not just opening the panel).
 *
 * Setup: alice (org owner) creates project → imports sample.md →
 * opens ProjectOverview → opens Assign panel → selects herself as
 * assignee + the imported file → clicks Assign → panel collapses.
 */
test("AssignWork form submits and collapses after success", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `AssignSubmit ${Date.now()}`
  await dash.createProject({ name })
  await dash.openProject(name)

  await alice.waitForURL(/\/project\/[^/]+\/editor(?:\/file\/[^/]+)?(?:\?|$)/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/project\/([^/]+)/)?.[1]
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
  const assigneeSelect = panel.getByRole("combobox", { name: "Assignee" })
  await expect(assigneeSelect).toBeVisible({ timeout: 5_000 })

  // Wait for org members to load (API call on panel open).
  await alice.waitForTimeout(1_500)

  // Select alice as the assignee (she's the project owner, so she's in the org).
  await assigneeSelect.click()
  const assigneeOptions = alice.getByRole("option")
  await expect(assigneeOptions.first()).toBeVisible({ timeout: 3_000 })
  const aliceOption = assigneeOptions.filter({ hasText: /alice/i }).first()
  if ((await aliceOption.count()) > 0) {
    await aliceOption.click()
  } else {
    // Fallback: select the first non-placeholder option.
    await assigneeOptions.filter({ hasNotText: /Select member/i }).first().click()
  }
  await expect(alice.getByRole("listbox")).toBeHidden({ timeout: 3_000 })

  // Book dropdown should already have sample.md selected (first file).
  const bookSelect = panel.getByRole("combobox", { name: "Book" })
  await expect(bookSelect).toBeVisible({ timeout: 3_000 })
  // The closed trigger renders the selected file's label (sample.md).
  await expectSelectValue(bookSelect, /sample/i)

  // Click "Assign" — the submit button.
  const submitBtn = panel.getByRole("button", { name: /^Assign$/i })
  await expect(submitBtn).toBeEnabled({ timeout: 3_000 })
  await submitBtn.click()

  await expect(panel).not.toBeVisible({ timeout: 10_000 })
  await expect(alice.getByRole("button", { name: /^Assign…$/i })).toBeVisible()
})
