import { test, expect } from "../../helpers/multi-user"
import { jwtFor, seedProjectWithFile } from "../../helpers/seed-project"

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
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `AIInstr ${Date.now()}` })

  await alice.goto(`/project/${seeded.projectId}/settings/ai`)
  // The system prompt textarea.
  const textarea = alice.locator("#sp")
  await expect(textarea).toBeVisible({ timeout: 10_000 })

  // Luna's research-backed defaults: one ten-example approved pool plus a
  // separate five-cell bilingual discourse window.
  await expect(alice.locator("#top-k")).toHaveValue("10")
  await expect(alice.locator("#preceding-target-cells")).toHaveValue("5")

  // Fill it with something unique.
  const instruction = `Translate clearly and concisely. (test-${Date.now()})`
  await textarea.fill(instruction)

  // "Save changes" button should now be visible (form is dirty).
  const saveBtn = alice.getByRole("button", { name: /Save changes/i })
  await expect(saveBtn).toBeVisible({ timeout: 5_000 })
})
