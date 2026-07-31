import { test, expect } from "../../helpers/multi-user"
import { jwtFor, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * ProjectSettings — Terminology Library card.
 *
 * ProjectSettings.tsx has a "Terminology Library" card with an
 * "Open Terminology Library" button that navigates to /project/:id/terminology.
 *
 * This spec: navigate to project settings → click "Open Terminology Library"
 * → verify URL changes to the terminology route.
 */
test("project settings Terminology Library button navigates to terminology page", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `TermLink ${Date.now()}` })

  await alice.goto(`/project/${seeded.projectId}/settings/ai`)
  // Scroll to the Terminology Library card.
  const termCard = alice.getByText(/Terminology Library/i).first()
  await expect(termCard).toBeVisible({ timeout: 10_000 })
  await termCard.scrollIntoViewIfNeeded()

  // Click "Open Terminology Library".
  const openBtn = alice.getByRole("button", { name: /Open Terminology Library/i })
  await expect(openBtn).toBeVisible({ timeout: 5_000 })
  await openBtn.click()

  // URL changes to the terminology route.
  await alice.waitForURL(/\/project\/[^/]+\/terminology/, { timeout: 5_000 })
  expect(alice.url()).toMatch(/\/terminology/)
})
