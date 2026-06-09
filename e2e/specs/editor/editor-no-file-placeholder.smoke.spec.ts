import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * CellAreaPlaceholder — "No file selected" empty state.
 *
 * When a project is opened but no file has been selected, the editor area
 * renders CellAreaPlaceholder with state.kind="no-file", showing:
 *   - "No file selected" heading
 *   - "Pick a file from the sidebar to start translating." description
 *
 * This spec: open a project workspace without opening a file → verify the
 * "No file selected" empty state is shown.
 */
test("editor shows No file selected placeholder when no file is open", async ({ alice }) => {
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

  // "No file selected" heading is visible in the editor area.
  await expect(alice.getByText(/No file selected/i).first()).toBeVisible({ timeout: 10_000 })

  // Description text is also present.
  await expect(
    alice.getByText(/Pick a file from the sidebar/i).first()
  ).toBeVisible({ timeout: 3_000 })
})
