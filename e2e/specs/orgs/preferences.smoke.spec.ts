import { test, expect } from "../../helpers/multi-user"

/**
 * User preferences (/preferences).
 *
 * Preferences index renders a General card (theme, language, privacy) inline,
 * with Workspace nested under that category and other sections as nav rows.
 * This spec verifies the route loads those inline controls. It does NOT
 * mutate any settings.
 */
test("preferences page renders General controls inline", async ({ alice }) => {
  await alice.goto("/preferences")
  await expect(alice.locator("h1").filter({ hasText: /Preferences/i })).toBeVisible({
    timeout: 10_000,
  })

  await expect(alice.getByText("General", { exact: true })).toBeVisible({
    timeout: 5_000,
  })
  await expect(alice.getByRole("combobox", { name: "Theme" })).toBeVisible()
  await expect(alice.getByRole("combobox", { name: "UI language" })).toBeVisible()
  await expect(alice.getByRole("switch", { name: "Share usage data" })).toBeVisible()

  await expect(alice.getByRole("link", { name: /Workspace/i })).toBeVisible({
    timeout: 5_000,
  })
  await expect(alice.getByRole("link", { name: /Privacy/i })).toHaveCount(0)
})
