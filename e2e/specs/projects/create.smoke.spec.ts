import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

test("alice creates a project and it appears on her dashboard", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `Smoke ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await expect(alice.getByText(name).first()).toBeVisible({ timeout: 5_000 })
})
