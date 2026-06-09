import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * ProjectSettings — AI Instructions section.
 *
 * The AI Instructions card has:
 *   - textarea id="sp" (system prompt)
 *   - Input id="top-k" (examples retrieved, 1–20)
 *
 * Changing either field makes the form dirty and shows "Save changes".
 *
 * This spec: navigates to settings → fills the system prompt textarea →
 * verifies "Save changes" button appears.
 */
test("project settings AI instructions textarea makes form dirty", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `AIInstr ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  await alice.goto(`/project/${projectId}/settings`)
  await alice.waitForLoadState("networkidle")

  // The system prompt textarea.
  const textarea = alice.locator("#sp")
  await expect(textarea).toBeVisible({ timeout: 10_000 })

  // Fill it with something unique.
  const instruction = `Translate clearly and concisely. (test-${Date.now()})`
  await textarea.fill(instruction)

  // "Save changes" button should now be visible (form is dirty).
  const saveBtn = alice.getByRole("button", { name: /Save changes/i })
  await expect(saveBtn).toBeVisible({ timeout: 5_000 })
})
