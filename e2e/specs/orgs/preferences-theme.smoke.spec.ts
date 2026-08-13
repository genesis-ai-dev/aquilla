import { test, expect } from "../../helpers/multi-user"

test("appearance preference selects and persists the workspace theme", async ({ alice }) => {
  await alice.addInitScript(() => {
    window.localStorage.setItem("codex-color-theme", "rose")
  })
  await alice.goto("/preferences")
  await expect(alice.getByRole("heading", { name: "Preferences" })).toBeVisible()
  const theme = alice.getByRole("combobox", { name: "Theme" })
  await expect(theme).toBeVisible()
  await expect(alice.getByRole("link", { name: /Appearance/ })).toHaveCount(0)
  await expect(alice.getByRole("tab", { name: "System" })).toHaveCount(0)
  await expect(alice.getByText("Accent color")).toHaveCount(0)
  await expect.poll(() => alice.evaluate(() => window.localStorage.getItem("codex-color-theme"))).toBeNull()
  await expect(alice.locator("html")).not.toHaveAttribute("data-color-theme")

  await theme.click()
  await alice.getByRole("option", { name: "Dark" }).click()
  await expect(alice.locator("html")).toHaveClass(/dark/)
  await expect.poll(() => alice.evaluate(() => window.localStorage.getItem("codex-theme"))).toBe("dark")
  await expect(theme).toContainText("Dark")

  await alice.reload()
  await expect(alice.getByRole("combobox", { name: "Theme" })).toContainText("Dark")
  await expect(alice.locator("html")).toHaveClass(/dark/)

  await alice.getByRole("combobox", { name: "Theme" }).click()
  await alice.getByRole("option", { name: "Light" }).click()
  await expect(alice.locator("html")).not.toHaveClass(/dark/)
})
