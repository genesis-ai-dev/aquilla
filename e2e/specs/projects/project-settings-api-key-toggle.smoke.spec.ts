import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * ProjectSettings — ApiKeyField show/hide toggle.
 *
 * ApiKeyField.tsx has a button with aria-label "Show key" (Eye icon) that
 * changes to "Hide key" (EyeOff) when clicked. It also switches the input
 * type from "password" to "text" so the key value becomes visible.
 *
 * This spec: navigate to project settings → scroll to the AI section →
 * verify the input is type="password" → click "Show key" → input becomes
 * type="text" → click "Hide key" → type="password" again.
 */
test("project settings API key toggle shows and hides key", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `ApiKeyToggle ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  await alice.goto(`/project/${projectId}/settings`)
  await alice.waitForLoadState("networkidle")

  // The ApiKeyField is inside the AI section; scroll into view.
  const showKeyBtn = alice.getByRole("button", { name: /Show key/i }).first()
  await expect(showKeyBtn).toBeVisible({ timeout: 10_000 })
  await showKeyBtn.scrollIntoViewIfNeeded()

  // The adjacent input should be password-masked.
  const keyInput = showKeyBtn.locator("..").locator("..").locator('input[type="password"]')
  await expect(keyInput).toBeVisible({ timeout: 3_000 })

  // Click "Show key" — input type changes to text.
  await showKeyBtn.click()
  const hideKeyBtn = alice.getByRole("button", { name: /Hide key/i }).first()
  await expect(hideKeyBtn).toBeVisible({ timeout: 2_000 })
  await expect(keyInput).not.toBeVisible()
  await expect(showKeyBtn.locator("..").locator("..").locator('input[type="text"]')).toBeVisible({ timeout: 2_000 })

  // Click "Hide key" — reverts to password.
  await hideKeyBtn.click()
  await expect(showKeyBtn).toBeVisible({ timeout: 2_000 })
})
