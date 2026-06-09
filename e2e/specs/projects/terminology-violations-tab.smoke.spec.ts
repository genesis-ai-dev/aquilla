import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * TerminologyViolationsInbox — Violations tab on the Terminology page.
 *
 * TerminologyPage.tsx renders three tabs: Concepts, Candidate terms,
 * Violations. Clicking "Violations" mounts TerminologyViolationsInbox.
 *
 * When there are no concepts (no cells to check), it renders either:
 *   - "No terminology violations." — if the inbox ran successfully
 *   - Loading/empty state while checking
 *
 * This spec: creates a project → navigates to /terminology →
 * clicks "Violations" tab → asserts the violations panel content
 * is visible (empty state or "No terminology violations." text).
 */
test("Violations tab on terminology page shows inbox content", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `TermViolTab ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const projectId = alice.url().match(/\/project\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  await alice.goto(`/project/${projectId}/terminology`)
  await alice.waitForLoadState("networkidle")

  // Click the "Violations" tab.
  const violationsTab = alice.getByRole("button", { name: /^Violations$/i })
  await expect(violationsTab).toBeVisible({ timeout: 10_000 })
  await violationsTab.click()

  // The TerminologyViolationsInbox mounts.
  // With no cells / concepts it shows "No terminology violations."
  await expect(
    alice.getByText(/No terminology violations/i).first()
  ).toBeVisible({ timeout: 8_000 })
})
