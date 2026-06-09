import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * Terminology CSV and TBX export.
 *
 * After adding a concept the "CSV" and "TBX" buttons (aria-label="Export CSV"
 * and aria-label="Export TBX") become enabled. Clicking them triggers a
 * URL.createObjectURL → anchor.click download (same pattern as TSV export).
 *
 * This spec adds one concept then verifies both exports download a file.
 */
test("terminology CSV export downloads after adding a concept", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `TermExport ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  await alice.goto(`/project/${projectId}/terminology`)
  await alice.waitForLoadState("networkidle")

  // Add a concept so exports are enabled.
  await alice.getByRole("button", { name: /Add concept/i }).first().click()
  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await dialog.locator("#concept-source-term").fill("grace")
  await dialog.locator('input[placeholder="rendering"]').first().fill("grâce")
  await dialog.getByRole("button", { name: /^Add concept$/i }).click()
  await expect(dialog).not.toBeVisible({ timeout: 5_000 })

  // CSV export — button becomes enabled once concepts exist.
  const csvBtn = alice.getByRole("button", { name: /Export CSV/i })
  await expect(csvBtn).toBeEnabled({ timeout: 5_000 })

  const csvDownload = alice.waitForEvent("download", { timeout: 10_000 })
  await csvBtn.click()
  const csv = await csvDownload
  expect(csv.suggestedFilename()).toMatch(/\.csv$/)
})

test("terminology TBX export downloads after adding a concept", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `TermTBX ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  await alice.goto(`/project/${projectId}/terminology`)
  await alice.waitForLoadState("networkidle")

  // Add a concept.
  await alice.getByRole("button", { name: /Add concept/i }).first().click()
  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await dialog.locator("#concept-source-term").fill("faith")
  await dialog.locator('input[placeholder="rendering"]').first().fill("foi")
  await dialog.getByRole("button", { name: /^Add concept$/i }).click()
  await expect(dialog).not.toBeVisible({ timeout: 5_000 })

  // TBX export.
  const tbxBtn = alice.getByRole("button", { name: /Export TBX/i })
  await expect(tbxBtn).toBeEnabled({ timeout: 5_000 })

  const tbxDownload = alice.waitForEvent("download", { timeout: 10_000 })
  await tbxBtn.click()
  const tbx = await tbxDownload
  expect(tbx.suggestedFilename()).toMatch(/\.tbx$/)
})
