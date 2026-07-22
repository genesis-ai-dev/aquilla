import { test, expect } from "../../helpers/multi-user"
import { jwtFor, seedProjectWithFile } from "../../helpers/seed-project"

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
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `AssistLang ${Date.now()}` })

  await alice.goto(`/project/${seeded.projectId}/settings?section=ai`)
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
