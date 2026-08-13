import { test, expect, orgRoute } from "../../helpers/multi-user"

/**
 * Org settings — rename organization.
 *
 * Settings identity page (/settings/identity) shows an inline Organization
 * name field (owner/admin editable). Blurring a changed value saves via PATCH;
 * the field keeps the new name. The test restores the original name afterward
 * so other specs that rely on the default org name stay stable.
 */
test("org settings rename and save updates org name", async ({ alice }) => {
  await alice.goto(orgRoute(alice, "/settings/identity"))

  const nameInput = alice.getByLabel(/^Organization name$/i)
  await expect(nameInput).toBeVisible({ timeout: 10_000 })
  await expect(nameInput).toBeEnabled()

  const originalName = await nameInput.inputValue()
  const newName = `RenamedOrg ${Date.now()}`
  await nameInput.fill(newName)

  const saveResponse = alice.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      /\/orgs\/\d+/.test(response.url()) &&
      response.ok(),
    { timeout: 10_000 },
  )
  await nameInput.blur()
  await saveResponse
  await expect(nameInput).toHaveValue(newName)

  // Restore original name to avoid polluting other tests.
  await nameInput.fill(originalName)
  const restoreResponse = alice.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      /\/orgs\/\d+/.test(response.url()) &&
      response.ok(),
    { timeout: 10_000 },
  )
  await nameInput.blur()
  await restoreResponse
  await expect(nameInput).toHaveValue(originalName)
})
