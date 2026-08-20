import { test, expect, orgRoute } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * Below lg (1024px), org chrome (not the editor dock) hides the in-flow
 * sidebar and opens it from a PanelLeft control to the left of the breadcrumbs.
 *
 * This spec: set a just-under-lg viewport → land on Projects → open the sheet →
 * navigate to Teams from it → the sheet closes on the destination.
 */
test("mobile org sidebar opens in a sheet from the header", async ({ alice }) => {
  await alice.setViewportSize({ width: 1023, height: 768 })
  await alice.goto(orgRoute(alice, "/projects"))
  await expect(alice.getByRole("button", { name: /new project/i }).first()).toBeVisible({
    timeout: 15_000,
  })

  const dash = new Dashboard(alice)
  const trigger = dash.openSidebarButton()
  await expect(trigger).toBeVisible({ timeout: 10_000 })
  await expect(alice.locator("aside")).toHaveCount(0)

  const crumbs = alice.getByRole("navigation", { name: "breadcrumb" })
  await expect(crumbs).toBeVisible()
  const triggerBox = await trigger.boundingBox()
  const crumbBox = await crumbs.boundingBox()
  expect(triggerBox).not.toBeNull()
  expect(crumbBox).not.toBeNull()
  expect(triggerBox!.x).toBeLessThan(crumbBox!.x)

  const sheet = await dash.openMobileSidebar()
  await expect(sheet.getByRole("link", { name: "Teams" })).toBeVisible({ timeout: 10_000 })
  await sheet.getByRole("link", { name: "Teams" }).click()

  await expect(alice).toHaveURL(/\/teams(?:[/?#].*)?$/, { timeout: 10_000 })
  await expect(alice.getByRole("heading", { name: /Teams/i })).toBeVisible({ timeout: 10_000 })
  await expect(alice.getByRole("dialog", { name: "Navigation" })).toHaveCount(0)
})
