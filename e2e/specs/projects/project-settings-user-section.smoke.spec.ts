import { test, expect } from "../../helpers/multi-user"
import { jwtFor, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * ProjectSettings — User section.
 *
 * ProjectSettings.tsx has a "User" card (id="section-user") with an input
 * id="un" for the username. Changing it makes the form dirty, revealing a
 * "Save changes" button in the sticky footer.
 *
 * This spec: navigate to project settings → fill the username input →
 * verify the "Save changes" button becomes visible.
 */
test("project settings User section username input makes form dirty", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `UserSection ${Date.now()}` })

  await alice.goto(`/project/${seeded.projectId}/settings?section=general`)
  // Scroll to the User section to ensure it's visible.
  const userSection = alice.locator("#section-user")
  await expect(userSection).toBeVisible({ timeout: 10_000 })
  await userSection.scrollIntoViewIfNeeded()

  // Fill the username input.
  const usernameInput = alice.locator("#un")
  await expect(usernameInput).toBeVisible({ timeout: 5_000 })
  await usernameInput.fill(`testuser-${Date.now()}`)

  // "Save changes" button should now appear (form is dirty).
  const saveBtn = alice.getByRole("button", { name: /Save changes/i })
  await expect(saveBtn).toBeVisible({ timeout: 5_000 })
})
