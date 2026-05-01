import { test, expect } from "@playwright/test"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  resetAndGotoDashboard,
  createProject,
  openProject,
  importFile,
  waitForEditor,
  clickFileInSidebar,
} from "../../helpers/legacy"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const sampleFile = path.resolve(__dirname, "../../fixtures/sample.md")

let projectName: string

test.beforeEach(async ({ page }) => {
  await resetAndGotoDashboard(page)
  projectName = await createProject(page)
  await openProject(page, projectName)
  await importFile(page, sampleFile)

  // Click first file in sidebar to open it
  await clickFileInSidebar(page, "sample")
})

test("validate a translated cell changes its icon", async ({ page }) => {
  await waitForEditor(page)

  // Get the first cell row
  const firstRow = page.locator("[data-cell-id]").first()
  const cellId = await firstRow.getAttribute("data-cell-id")
  expect(cellId).toBeTruthy()

  // Type text into the target area (could be a tiptap editor or textarea)
  const targetArea = firstRow.locator("textarea, .tiptap [contenteditable]").first()
  await targetArea.click()
  await targetArea.fill?.("Test translation text").catch(async () => {
    // If fill doesn't work (contenteditable), use keyboard
    await page.keyboard.type("Test translation text")
  })
  await targetArea.blur()

  // Wait for the validation button to appear (it only shows when cell has content)
  const validationButton = firstRow.locator("button[title*='Health']").first()
  await expect(validationButton).toBeVisible({ timeout: 10_000 })

  // Click the validation button to validate
  await validationButton.click()

  // In the popover, click Validate if there's such a button, otherwise the click itself toggles
  const validateAction = page.getByRole("button", { name: /validate/i })
  if (await validateAction.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await validateAction.click()
  }

  // Verify emerald-500 color class appears on the button (self-validated)
  await expect(firstRow.locator(".text-emerald-500").first()).toBeVisible({ timeout: 10_000 })
})

test("validation persists across navigation", async ({ page }) => {
  await waitForEditor(page)

  // Validate the first cell (same steps as above)
  const firstRow = page.locator("[data-cell-id]").first()
  const targetArea = firstRow.locator("textarea, .tiptap [contenteditable]").first()
  await targetArea.click()
  await targetArea.fill?.("Test translation text").catch(async () => {
    await page.keyboard.type("Test translation text")
  })
  await targetArea.blur()

  const validationButton = firstRow.locator("button[title*='Health']").first()
  await expect(validationButton).toBeVisible({ timeout: 10_000 })
  await validationButton.click()

  const validateAction = page.getByRole("button", { name: /validate/i })
  if (await validateAction.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await validateAction.click()
  }

  // Verify validated
  await expect(firstRow.locator(".text-emerald-500").first()).toBeVisible({ timeout: 10_000 })

  // Click Dashboard breadcrumb to go back
  await page.getByRole("button", { name: "Dashboard" }).click()
  await expect(page.getByText(projectName)).toBeVisible({ timeout: 5_000 })

  // Re-open the project and file
  await openProject(page, projectName)
  await clickFileInSidebar(page, "sample")
  await waitForEditor(page)

  // Verify emerald-500 still shows (validation persisted)
  await expect(
    page.locator("[data-cell-id]").first().locator(".text-emerald-500").first(),
  ).toBeVisible({ timeout: 10_000 })
})
