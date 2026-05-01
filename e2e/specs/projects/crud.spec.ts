import { test, expect } from "@playwright/test"
import { resetAndGotoDashboard, createProject, openProject } from "../../helpers/legacy"

test.describe("Dashboard", () => {
  test.beforeEach(async ({ page }) => {
    await resetAndGotoDashboard(page)
  })

  test("dashboard loads with app title", async ({ page }) => {
    // The brand name appears in the header
    await expect(page.locator("h1")).toBeVisible({ timeout: 10_000 })
  })

  test("shows empty state when no projects exist", async ({ page }) => {
    await expect(
      page.getByText(/no.*projects/i),
    ).toBeVisible({ timeout: 5000 })
  })

  test("create project appears on dashboard", async ({ page }) => {
    await page.getByRole("button", { name: /new project/i }).click()
    await page.getByLabel("Project Name").fill("My Test")
    await page.getByLabel("Source Language").fill("en")
    await page.getByLabel("Target Language").fill("fr")
    await page.getByRole("button", { name: "Create Project" }).click()

    await expect(page.getByText("My Test")).toBeVisible({ timeout: 5000 })
  })

  test("clicking project card navigates to workspace", async ({ page }) => {
    await createProject(page, { name: "Nav Test", source: "en", target: "fr" })
    await openProject(page, "Nav Test")

    await expect(page).toHaveURL(/\/project\//)
    await expect(page.locator("aside")).toBeVisible({ timeout: 10_000 })
  })
})
