import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * CellAreaPlaceholder — empty-state variants (FRO-149).
 *
 * Two cases:
 *   A. Project has ZERO files → show "No files yet" + "Import a file" CTA button.
 *      The old "pick a file from the sidebar" message is wrong here (sidebar is empty).
 *   B. Project has files but none is selected → show "No file selected" +
 *      "Pick a file from the sidebar" (original copy, sidebar is populated).
 *
 * Case B is hard to exercise reliably in smoke tests (the workspace auto-selects
 * the only file when there is one). We focus on Case A here.
 */
test("editor shows Import a file CTA when project has no files", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `NoFile ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  // Navigate directly to the workspace without opening a file.
  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
    ?? alice.url().match(/\/project\/([^/]+)$/)?.[1]

  // If createProject already went to the workspace, navigate to get clean state.
  await alice.goto(`/project/${projectId}`)
  await alice.waitForLoadState("networkidle")

  // "No files yet" heading is visible when the project has no imported files.
  await expect(alice.getByText(/No files yet/i).first()).toBeVisible({ timeout: 10_000 })

  // "Import a file" CTA button is shown (not the sidebar instruction).
  await expect(
    alice.getByRole("button", { name: /Import a file/i }).first()
  ).toBeVisible({ timeout: 3_000 })

  // The "Pick a file from the sidebar" copy must NOT appear (sidebar is empty).
  await expect(
    alice.getByText(/Pick a file from the sidebar/i).first()
  ).not.toBeVisible()
})
