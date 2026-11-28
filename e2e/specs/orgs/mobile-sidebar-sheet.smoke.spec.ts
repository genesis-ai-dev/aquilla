import { test, expect, orgRoute } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * Below lg (1024px), org chrome hides the in-flow sidebar and opens it from
 * a PanelLeft control to the left of the breadcrumbs. The editor dock uses
 * the same sheet chrome (covered in RTL); this spec is the org navigate-and-close
 * contract.
 *
 * This spec: set a just-under-lg viewport → land on Projects → open the sheet →
 * navigate to People & access from it → the sheet closes on the destination.
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

  const crumbs = alice.getByRole("navigation", { name: "Breadcrumb" })
  await expect(crumbs).toBeVisible()
  const triggerBox = await trigger.boundingBox()
  const crumbBox = await crumbs.boundingBox()
  expect(triggerBox).not.toBeNull()
  expect(crumbBox).not.toBeNull()
  expect(triggerBox!.x).toBeLessThan(crumbBox!.x)

  const sheet = await dash.openMobileSidebar()
  const accessLink = sheet.getByRole("link", { name: "People & access" })
  await expect(accessLink).toBeVisible({ timeout: 10_000 })
  await accessLink.click()

  await expect(alice).toHaveURL(/\/access(?:[/?#].*)?$/, { timeout: 10_000 })
  await expect(alice.getByRole("heading", { name: "People & access" })).toBeVisible({ timeout: 10_000 })
  await expect(alice.getByRole("dialog", { name: "Navigation" })).toHaveCount(0)
})
