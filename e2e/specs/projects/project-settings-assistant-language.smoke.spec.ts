import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * ProjectSettings — "Assistant language" input (#main-chat-language).
 *
 * The AI Instructions card has an Input#main-chat-language for specifying
 * the language the AI assistant uses in chat responses (e.g. "English",
 * "Français", "Español…"). Filling it marks the form dirty.
 *
 * This spec: navigate to /project/:id/settings → fill #main-chat-language →
 * verify "Save changes" button appears (form is dirty).
 */
test("project settings assistant language input marks form dirty", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `AssistLang ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  await alice.goto(`/project/${projectId}/settings`)
  await alice.waitForLoadState("networkidle")

  // #main-chat-language input is visible.
  const langInput = alice.locator("#main-chat-language")
  await expect(langInput).toBeVisible({ timeout: 10_000 })

  // Fill with a language.
  await langInput.fill("Español")

  // "Save changes" button is visible — form is dirty.
  const saveBtn = alice.getByRole("button", { name: /Save changes/i })
  await expect(saveBtn).toBeVisible({ timeout: 5_000 })
})
