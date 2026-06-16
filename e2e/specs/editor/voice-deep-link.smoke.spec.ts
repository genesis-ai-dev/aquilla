import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * Voice deep-link — /project/:id/voice activates audio lens.
 *
 * ISSUE-3 fix (10c5d39): App.tsx registers a Route for /project/:id/voice
 * that renders ProjectWorkspace. ProjectWorkspace.tsx has a useEffect that
 * detects the /voice suffix and calls setLens("audio"), switching the editor
 * to audio/voice mode.
 *
 * This spec:
 *   1. Creates a project.
 *   2. Navigates directly to /project/:id/voice.
 *   3. Verifies the workspace renders (not a 404).
 *   4. Verifies the voice surface is active even before files are imported.
 */
test("/project/:id/voice deep-link activates audio lens on load", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `VoiceDeepLink ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  // Get the project ID from the URL.
  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  // Navigate directly to the /voice deep-link URL.
  await alice.goto(`/project/${projectId}/voice`)
  await alice.waitForLoadState("networkidle")

  // The workspace should render the voice surface (not a 404 blank page).
  // Empty projects have no file lens selector yet, but the Cast sidebar is active.
  await expect(alice.getByRole("heading", { name: /^Cast$/i })).toBeVisible({ timeout: 10_000 })
  await expect(alice.getByRole("button", { name: /New voice/i })).toBeVisible()
})
