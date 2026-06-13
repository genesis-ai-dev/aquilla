import { test, expect } from "../../helpers/multi-user"
import { expectSelectValue, pickSelectOption } from "../../helpers/base-ui"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * Terminology concept dialog — RenderingRow status select.
 *
 * Each rendering row in the concept dialog (TerminologyPage.tsx) has a
 * Base UI Select (trigger aria-label="Rendering N status") with options:
 *   - "required" → value "preferred" (default for the pre-populated first row)
 *   - "alternate" → value "admitted" (default for rows added via "Add rendering")
 *   - "forbidden" → value "forbidden"
 *
 * This spec: open the Add concept dialog → verify rendering 1 status defaults
 * to "required" → change to "alternate" → verify the trigger shows "alternate" →
 * change to "forbidden" → verify it shows "forbidden".
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

  // Rendering 1 status select defaults to "required" (value "preferred" —
  // ConceptDialog seeds the first row with { status: "preferred" }).
  const statusSelect = dialog.getByRole("combobox", { name: "Rendering 1 status" })
  await expect(statusSelect).toBeVisible({ timeout: 3_000 })
  await expectSelectValue(statusSelect, "required")

  // Change to "alternate" (value "admitted").
  await pickSelectOption(alice, statusSelect, "alternate")
  await expectSelectValue(statusSelect, "alternate")

  // Change to "forbidden".
  await pickSelectOption(alice, statusSelect, "forbidden")
  await expectSelectValue(statusSelect, "forbidden")

  // Close dialog.
  await alice.keyboard.press("Escape")
})
