import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * TermbaseSharingSection — cross-project subscribe / unsubscribe.
 *
 * TermbaseSharingSection.tsx (src/components/ProjectSettings/TermbaseSharingSection.tsx):
 *   - When a project has published its termbase to the org, OTHER projects
 *     in the same org see it listed under "Available in your org".
 *   - Clicking "Subscribe" adds it to the subscribed list.
 *   - The subscribed row has aria-label="Unsubscribe from {name}".
 *   - Clicking that button removes it.
 *
 * Flow:
 *   1. Alice creates project A → goes to settings → toggles "Publish termbase to org" ON.
 *   2. Alice creates project B → goes to settings.
 *   3. Project A's name appears in "Available in your org".
 *   4. Click "Subscribe" → Project A moves to subscribed list.
 *   5. "Unsubscribe from {name}" button is visible.
 *   6. Click it → subscribed list is empty again.
 */
test("termbase subscribe and unsubscribe between two projects", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()

  // --- Step 1: Create Project A and publish its termbase ---
  const nameA = `TermbasePublisher ${Date.now()}`
  await dash.createProject({ name: nameA, source: "en", target: "fr" })
  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectAId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectAId).toBeTruthy()

  await alice.goto(`/project/${projectAId}/settings`)
  await alice.waitForLoadState("networkidle")

  const publishSwitch = alice.locator('[aria-label="Publish termbase to org"]')
  await expect(publishSwitch).toBeVisible({ timeout: 10_000 })
  // Ensure it's off, then turn on.
  const isOn = await publishSwitch.getAttribute("aria-checked")
  if (isOn !== "true") {
    await publishSwitch.click()
    await expect(publishSwitch).toHaveAttribute("aria-checked", "true", { timeout: 5_000 })
  }

  // --- Step 2: Create Project B ---
  await dash.goto()
  const nameB = `TermbaseSubscriber ${Date.now()}`
  await dash.createProject({ name: nameB, source: "en", target: "fr" })
  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectBId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectBId).toBeTruthy()
  expect(projectBId).not.toEqual(projectAId)

  await alice.goto(`/project/${projectBId}/settings`)
  await alice.waitForLoadState("networkidle")

  // --- Step 3: Verify Project A appears in Available section ---
  await expect(alice.getByText(/Available in your org/i).first()).toBeVisible({ timeout: 10_000 })

  // Project A's termbase should be listed.
  const availableRow = alice.getByText(nameA)
  await expect(availableRow).toBeVisible({ timeout: 8_000 })

  // --- Step 4: Subscribe ---
  const subscribeBtn = alice
    .locator("li")
    .filter({ hasText: nameA })
    .getByRole("button", { name: /^Subscribe$/i })
  await expect(subscribeBtn).toBeVisible({ timeout: 5_000 })
  await subscribeBtn.click()

  // --- Step 5: Subscribed row with Unsubscribe button ---
  const unsubscribeBtn = alice.locator(`[aria-label="Unsubscribe from ${nameA}"]`)
  await expect(unsubscribeBtn).toBeVisible({ timeout: 8_000 })

  // --- Step 6: Unsubscribe ---
  await unsubscribeBtn.click()
  // After unsubscribing, the button should disappear.
  await expect(unsubscribeBtn).not.toBeVisible({ timeout: 5_000 })
  // The project should be back in the Available list.
  await expect(alice.getByText(nameA)).toBeVisible({ timeout: 5_000 })
})
