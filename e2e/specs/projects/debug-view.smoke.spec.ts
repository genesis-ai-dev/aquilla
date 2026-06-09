import { test, expect } from "../../helpers/multi-user"

/**
 * DebugView — /debug renders a JSON dump of all local projects.
 *
 * DebugView.tsx at /debug (no :id param) calls listProjects() and renders
 * the result as a <pre> block. The output is always valid JSON (or "null").
 *
 * This is a smoke test: just verify the page loads and renders a <pre> element.
 */
test("debug view renders pre block with project data", async ({ alice }) => {
  await alice.goto("/debug")
  await alice.waitForLoadState("networkidle")

  const pre = alice.locator("pre")
  await expect(pre).toBeVisible({ timeout: 10_000 })

  const text = await pre.textContent()
  expect(text).toBeTruthy()
  // Should be valid JSON.
  expect(() => JSON.parse(text ?? "")).not.toThrow()
})
