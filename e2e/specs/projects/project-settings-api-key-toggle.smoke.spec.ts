import { test, expect } from "../../helpers/multi-user"
import { jwtFor, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * ProjectSettings — ApiKeyField show/hide toggle.
 *
 * ApiKeyField.tsx has a button with aria-label "Show key" (Eye icon) that
 * changes to "Hide key" (EyeOff) when clicked. It also switches the input
 * type from "password" to "text" so the key value becomes visible.
 *
 * On a fresh project the only mounted ApiKeyField is the Gemini key in the
 * Voice card (#section-voice) — the Advanced LLM ApiKeyField only mounts
 * when provider === "custom", inside a collapsed <details>. Scope to the
 * Voice card so the locators stay stable when the button's aria-label flips
 * between "Show key" and "Hide key".
 *
 * This spec: navigate to project settings → scroll to the Voice section →
 * verify the input is type="password" → click "Show key" → input becomes
 * type="text" → click "Hide key" → type="password" again.
 */
test("project settings API key toggle shows and hides key", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `ApiKeyToggle ${Date.now()}` })

  await alice.goto(`/project/${seeded.projectId}/settings?section=ai`)
  // The Gemini ApiKeyField lives inside the Voice card.
  const voice = alice.locator("#section-voice")
  await expect(voice).toBeVisible({ timeout: 10_000 })
  await voice.scrollIntoViewIfNeeded()

  const showKeyBtn = voice.getByRole("button", { name: /Show key/i })
  await expect(showKeyBtn).toBeVisible({ timeout: 5_000 })

  // The key input should be password-masked.
  await expect(voice.locator('input[type="password"]')).toBeVisible({ timeout: 3_000 })

  // Click "Show key" — input type changes to text.
  await showKeyBtn.click()
  const hideKeyBtn = voice.getByRole("button", { name: /Hide key/i })
  await expect(hideKeyBtn).toBeVisible({ timeout: 2_000 })
  await expect(voice.locator('input[type="password"]')).not.toBeVisible()
  await expect(voice.locator('input[type="text"]')).toBeVisible({ timeout: 2_000 })

  // Click "Hide key" — reverts to password.
  await hideKeyBtn.click()
  await expect(voice.getByRole("button", { name: /Show key/i })).toBeVisible({ timeout: 2_000 })
  await expect(voice.locator('input[type="password"]')).toBeVisible({ timeout: 2_000 })
})
