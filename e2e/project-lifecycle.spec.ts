import { test, expect } from "@playwright/test"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  resetAndGotoDashboard,
  createProject,
  openProject,
  importFile,
  waitForEditor,
} from "./helpers"

const __dirname = dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = resolve(__dirname, "fixtures/sample.md")
const PROJECT_NAME = "Lifecycle Test"

test.describe("Project lifecycle", () => {
  test.beforeEach(async ({ page }) => {
    await resetAndGotoDashboard(page)
    await createProject(page, { name: PROJECT_NAME })
    await openProject(page, PROJECT_NAME)
  })

  test("import markdown file creates cells in editor", async ({ page }) => {
    // Click the Import button and upload the sample markdown file
    await importFile(page, SAMPLE_MD)

    // Expect the sidebar file list to show at least one file
    const sidebarFiles = page.locator("aside [role='treeitem'], aside li, aside a[href]")
    await expect(sidebarFiles.first()).toBeVisible({ timeout: 10_000 })

    // Click the first file in the sidebar to open it in the editor
    await sidebarFiles.first().click()

    // Wait for editor cells to render (virtualized rows with data-cell-id)
    await waitForEditor(page)
    const cells = page.locator("[data-cell-id]")
    expect(await cells.count()).toBeGreaterThan(0)
  })

  test("cell editing persists on blur", async ({ page }) => {
    // Import and open the file in the editor
    await importFile(page, SAMPLE_MD)
    const sidebarFiles = page.locator("aside [role='treeitem'], aside li, aside a[href]")
    await expect(sidebarFiles.first()).toBeVisible({ timeout: 10_000 })
    await sidebarFiles.first().click()
    await waitForEditor(page)

    // Find a target cell (third column in the CSS grid row) with TipTap or contenteditable
    const firstRow = page.locator("[data-cell-id]").first()
    const targetCell = firstRow.locator(
      ".tiptap, [contenteditable='true'], textarea"
    )
    await targetCell.first().click()

    const testText = "Hello e2e test text"
    await page.keyboard.type(testText)

    // Click outside the cell to trigger blur
    await page.locator("aside").click()

    // Scroll away and back to exercise virtualization
    await page.mouse.wheel(0, 600)
    await page.waitForTimeout(300)
    await page.mouse.wheel(0, -600)
    await page.waitForTimeout(300)

    // Re-locate the first row after possible re-render and verify text persists
    const refreshedRow = page.locator("[data-cell-id]").first()
    await expect(refreshedRow).toContainText(testText, { timeout: 5_000 })
  })

  test("search dialog opens with Cmd+K", async ({ page }) => {
    // Import so we have content to search
    await importFile(page, SAMPLE_MD)
    const sidebarFiles = page.locator("aside [role='treeitem'], aside li, aside a[href]")
    await expect(sidebarFiles.first()).toBeVisible({ timeout: 10_000 })
    await sidebarFiles.first().click()
    await waitForEditor(page)

    // Open search dialog with Meta+K (Cmd+K on macOS)
    await page.keyboard.press("Meta+k")

    // Expect the search dialog input to appear
    const searchInput = page.locator(
      "dialog input, [role='dialog'] input, [data-radix-collection-item] input, [cmdk-input]"
    )
    await expect(searchInput.first()).toBeVisible({ timeout: 5_000 })

    // Type a search query
    await searchInput.first().fill("sample")

    // Close the dialog with Escape
    await page.keyboard.press("Escape")

    // Verify dialog is closed
    await expect(searchInput.first()).not.toBeVisible({ timeout: 3_000 })
  })
})
