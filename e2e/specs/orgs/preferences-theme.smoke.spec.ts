import { test, expect } from "../../helpers/multi-user"

test("appearance preference selects and persists the workspace theme", async ({ alice }) => {
  await alice.addInitScript(() => {
    window.localStorage.setItem("codex-color-theme", "rose")
  })
  await alice.goto("/preferences/appearance")
  await expect(alice.getByRole("heading", { name: "Appearance" })).toBeVisible()
  await expect(alice.getByRole("tab", { name: "System" })).toBeVisible()
  await expect(alice.getByRole("tab", { name: "Light" })).toBeVisible()
  await expect(alice.getByRole("tab", { name: "Dark" })).toBeVisible()
  await expect(alice.getByText("Accent color")).toHaveCount(0)
  await expect.poll(() => alice.evaluate(() => window.localStorage.getItem("codex-color-theme"))).toBeNull()
  await expect(alice.locator("html")).not.toHaveAttribute("data-color-theme")

  await alice.getByRole("tab", { name: "Dark" }).click()
  await expect(alice.locator("html")).toHaveClass(/dark/)

  await alice.reload()
  await expect(alice.getByRole("tab", { name: "Dark" })).toHaveAttribute("aria-selected", "true")
  await expect(alice.locator("html")).toHaveClass(/dark/)

  await alice.getByRole("tab", { name: "Light" }).click()
  await expect(alice.locator("html")).not.toHaveClass(/dark/)
})
