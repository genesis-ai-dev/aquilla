import { test, expect, orgRoute } from "../../helpers/multi-user"
import { Workspace } from "../../helpers/page-objects/Workspace"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * Validation state persists across navigation.
 *
 * The JOURNEYS.md "Validation: History persists across navigation" gap.
 *
 * Validating a cell writes to D1 via the sync-worker. If the user navigates
 * away (e.g. to /projects) and then returns to the same file, the validation
 * indicator should still show the cell as validated.
 *
 * Workflow:
 *   1. Create project → import file → edit cell 0 → validate cell 0.
 *   2. Navigate away to /projects.
 *   3. Navigate back to the project workspace and open the same file.
 *   4. Verify cell 0's health button still shows "— validated".
 */
test("validated cell stays validated after navigating away and back", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `ValidPersist ${Date.now()}` })
  const ws = await openSeededProject(alice, seeded)
  await ws.editCell(0, "Persisted translation")

  // Validate cell 0 — waits for "— validated" title attribute.
  await ws.validateCell(0)

  // Navigate away to the org Projects table (bare `/projects` lands Overview,
  // which has no New project control for non-empty orgs).
  await alice.goto(orgRoute(alice, "/projects"))
  await expect(alice.getByRole("button", { name: /new project/i }).first()).toBeVisible({
    timeout: 5_000,
  })

  // Navigate back to the project workspace.
  await alice.goto(`/project/${seeded.projectId}/editor`)
  const ws2 = new Workspace(alice)
  await ws2.openFileBySubstring("sample")
  await ws2.waitForEditor()

  // Cell 0 validation button should still report validated state.
  const row = ws2.cellRow(0)
  await row.hover()
  const validationButton = row.getByRole("button", { name: /Validated/i }).first()
  await expect(validationButton).toBeVisible({ timeout: 10_000 })
  await expect(validationButton).toHaveAttribute("aria-pressed", "true", { timeout: 15_000 })
})
