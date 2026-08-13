import { test, expect, orgRoute } from "../../helpers/multi-user"

/**
 * Organization rename — Settings Identity detail page (/settings/identity).
 *
 * The Identity page shows an inline Organization name field (owner/admin
 * editable). Blurring a changed value PATCHes the org and keeps the new name
 * in the field.
 *
 * NOTE: This test mutates the org name. The dev stack resets between test
 * runs so this is safe.
 */
test("org rename saves new name in settings page", async ({ alice }) => {
  await alice.goto(orgRoute(alice, "/settings/identity"))
  await expect(
    alice.locator("h1").filter({ hasText: /^Identity$/i })
  ).toBeVisible({ timeout: 10_000 })

  const orgNameInput = alice.getByLabel(/^Organization name$/i)
  await expect(orgNameInput).toBeVisible({ timeout: 5_000 })
  await expect(orgNameInput).toBeEnabled()

  const newOrgName = `AcmeE2E ${Date.now()}`
  await orgNameInput.fill(newOrgName)

  const saveResponse = alice.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      /\/orgs\/\d+/.test(response.url()) &&
      response.ok(),
    { timeout: 10_000 },
  )
  await orgNameInput.blur()
  await saveResponse

  await expect(orgNameInput).toHaveValue(newOrgName)
})
