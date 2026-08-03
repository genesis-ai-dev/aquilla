import { test, expect } from "../../helpers/multi-user"
import { jwtFor, seedProjectWithFile } from "../../helpers/seed-project"

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
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `AssignProj ${Date.now()}` })

  await alice.goto(`/projects/${seeded.projectId}`)
  // Prefer the AssignWork control ("Assign…") — do NOT match the Project
  // manager card's plain "Assign" button (AQU-507), which opens a different dialog.
  const assignBtn = alice.getByRole("button", { name: "Assign…" })
  await expect(assignBtn).toBeVisible({ timeout: 10_000 })
  await assignBtn.click()

  // The assign panel should open.
  const panel = alice.locator('[aria-label="Assign work"]')
  await expect(panel).toBeVisible({ timeout: 5_000 })

  // Assignee select is visible.
  const assigneeSelect = panel.getByRole("combobox", { name: "Assignee" })
  await expect(assigneeSelect).toBeVisible({ timeout: 3_000 })

  // Book select is visible.
  const bookSelect = panel.getByRole("combobox", { name: "Book" })
  await expect(bookSelect).toBeVisible({ timeout: 3_000 })

  // Cancel closes the panel.
  const cancelBtn = panel.getByRole("button", { name: /^Cancel$/i })
  await expect(cancelBtn).toBeVisible({ timeout: 2_000 })
  await cancelBtn.click()
  await expect(panel).not.toBeVisible({ timeout: 3_000 })
})
