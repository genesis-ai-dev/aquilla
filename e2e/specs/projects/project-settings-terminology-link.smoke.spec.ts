import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

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
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `TermLink ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  await alice.goto(`/project/${projectId}/settings/ai`)
  await alice.waitForLoadState("networkidle")

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
