import { type Page, expect } from "@playwright/test"

/**
 * Skip onboarding by setting the localStorage flag, then navigate to dashboard.
 * Call this in beforeEach when you want a clean dashboard with no onboarding redirect.
 */
export async function skipOnboarding(page: Page) {
  await page.evaluate(() => localStorage.setItem("codex:onboardingComplete", "true"))
  await page.goto("/")
  // Wait for the dashboard to actually render (h1 or "Your projects" heading)
  await page.waitForLoadState("networkidle")
}

/**
 * Clear all IndexedDB databases so each test starts with a clean slate.
 * Must be called after page.goto (needs a page context).
 */
export async function clearIndexedDB(page: Page) {
  await page.evaluate(async () => {
    const dbs = await indexedDB.databases()
    for (const db of dbs) {
      if (db.name) indexedDB.deleteDatabase(db.name)
    }
    // Also clear localStorage except the onboarding flag
    const onboardingFlag = localStorage.getItem("codex:onboardingComplete")
    localStorage.clear()
    if (onboardingFlag) localStorage.setItem("codex:onboardingComplete", onboardingFlag)
  })
}

/**
 * Full reset: navigate to a page context, clear IDB, skip onboarding, land on dashboard.
 * Use this as the standard beforeEach setup.
 */
export async function resetAndGotoDashboard(page: Page) {
  await page.goto("/")
  // Set onboarding flag first (before any app JS runs that checks it)
  await page.evaluate(() => localStorage.setItem("codex:onboardingComplete", "true"))
  // Clear IDB
  await page.evaluate(async () => {
    const dbs = await indexedDB.databases()
    for (const db of dbs) {
      if (db.name) indexedDB.deleteDatabase(db.name)
    }
  })
  // Reload to get a clean dashboard with the onboarding flag set
  await page.goto("/")
  await page.waitForLoadState("networkidle")
}

/**
 * Create a project through the UI: click "+ New Project", fill form, submit.
 * Returns the project name used.
 */
export async function createProject(
  page: Page,
  opts: { name?: string; source?: string; target?: string } = {},
) {
  const name = opts.name ?? "Test Project"
  const source = opts.source ?? "en"
  const target = opts.target ?? "fr"

  await page.getByRole("button", { name: /new project/i }).click()
  await page.getByLabel("Project Name").fill(name)
  await page.getByLabel("Source Language").fill(source)
  await page.getByLabel("Target Language").fill(target)
  await page.getByRole("button", { name: "Create Project" }).click()

  // Wait for the dialog to close and card to appear
  await expect(page.getByText(name)).toBeVisible({ timeout: 5000 })
  return name
}

/**
 * Navigate into a project by clicking its card on the dashboard.
 */
export async function openProject(page: Page, name: string) {
  await page.getByText(name).click()
  // Wait for workspace to load (sidebar visible)
  await expect(page.locator("aside")).toBeVisible({ timeout: 10_000 })
}

/**
 * Open the import dialog via the primary action button.
 */
export async function openImportDialog(page: Page) {
  // The primary action button shows "Import" when no file is selected
  await page.getByRole("button", { name: /^Import$/i }).click()
  await expect(page.getByText("Import Files")).toBeVisible({ timeout: 5000 })
}

/**
 * Import a file by uploading it through the import dialog.
 */
export async function importFile(page: Page, filePath: string) {
  await openImportDialog(page)
  const fileInput = page.locator('input[type="file"]')
  await fileInput.setInputFiles(filePath)
  // Wait for dialog to close (import complete)
  await expect(page.getByText("Import Files")).not.toBeVisible({ timeout: 15_000 })
}

/**
 * Wait for the editor table to render with at least one cell.
 */
export async function waitForEditor(page: Page) {
  await expect(page.locator("[data-cell-id]").first()).toBeVisible({ timeout: 10_000 })
}
