import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * Terminology concept dialog — RenderingRow status select.
 *
 * Each rendering row in the concept dialog (TerminologyPage.tsx) has a
 * <select aria-label="Rendering N status"> with options:
 *   - "required" → value "preferred"
 *   - "alternate" → value "admitted" (default for new rows)
 *   - "forbidden" → value "forbidden"
 *
 * This spec: open the Add concept dialog → verify rendering 1 status defaults
 * to "admitted" → change to "preferred" → verify value is "preferred" →
 * change to "forbidden" → verify value is "forbidden".
 */
test("terminology rendering row status select changes rendering status", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `TermRenderStatus ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  await alice.goto(`/project/${projectId}/terminology`)
  await alice.waitForLoadState("networkidle")

  // Open "Add concept" dialog.
  const addBtn = alice.getByRole("button", { name: /Add concept/i })
  await expect(addBtn).toBeVisible({ timeout: 10_000 })
  await addBtn.click()

  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })

  // Rendering 1 status select defaults to "admitted" (Alternate).
  const statusSelect = dialog.locator('[aria-label="Rendering 1 status"]')
  await expect(statusSelect).toBeVisible({ timeout: 3_000 })
  await expect(statusSelect).toHaveValue("admitted")

  // Change to "preferred" (Required).
  await statusSelect.selectOption("preferred")
  await expect(statusSelect).toHaveValue("preferred")

  // Change to "forbidden".
  await statusSelect.selectOption("forbidden")
  await expect(statusSelect).toHaveValue("forbidden")

  // Close dialog.
  await alice.keyboard.press("Escape")
})
