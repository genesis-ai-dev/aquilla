import { test, expect } from "../../helpers/multi-user"
import { jwtFor, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * ProjectSettings — System prompt lives on a nested page under AI & completion.
 *
 * Journey:
 *   settings/ai → NavRow "System prompt" (chevron) → textarea id="sp"
 * Changing the prompt makes the form dirty and shows "Save changes".
 */
test("project settings system prompt nested page makes form dirty", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `AIInstr ${Date.now()}` })

  await alice.goto(`/project/${seeded.projectId}/settings/ai`)
  // Chevron NavRow opens the nested system-prompt page.
  await expect(alice.getByRole("link", { name: /System prompt/i })).toBeVisible({
    timeout: 10_000,
  })
  await alice.getByRole("link", { name: /System prompt/i }).click()
  await expect(alice).toHaveURL(
    new RegExp(`/project/${seeded.projectId}/settings/system-prompt`),
  )

  const textarea = alice.locator("#sp")
  await expect(textarea).toBeVisible({ timeout: 10_000 })

  const instruction = `Translate clearly and concisely. (test-${Date.now()})`
  await textarea.fill(instruction)

  const saveBtn = alice.getByRole("button", { name: /Save changes/i })
  await expect(saveBtn).toBeVisible({ timeout: 5_000 })
})
