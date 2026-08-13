import { test, expect, orgRoute } from "../../helpers/multi-user"
import { jwtFor, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * Org Projects page — /orgs/:id/projects shows the project table.
 *
 * Member orgs split Overview (`/orgs/:id`) from Projects. Bare `/projects`
 * redirects to Overview, so this journey goes straight to the Projects table.
 *
 * This spec: seed a project → open the org Projects page → verify the project
 * name appears → clicking the row navigates to /projects/:id.
 */
test("projects list page shows created project in grid", async ({ alice }) => {
  const projName = `ListProj ${Date.now()}`
  await seedProjectWithFile(await jwtFor("alice"), { name: projName })

  await alice.goto(orgRoute(alice, "/projects"))
  await expect(alice.getByRole("button", { name: /new project/i }).first()).toBeVisible({
    timeout: 10_000,
  })

  // Project table shows the created project.
  const card = alice.getByText(projName)
  await expect(card).toBeVisible({ timeout: 8_000 })

  // Clicking the project row navigates to /projects/:id.
  await card.click()
  await alice.waitForURL(/\/projects\/[^/]+/, { timeout: 5_000 })
})
