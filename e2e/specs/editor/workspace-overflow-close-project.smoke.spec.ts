import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * WorkspaceHeader overflow menu — "Close project" navigates home.
 *
 * WorkspaceHeader.tsx renders an OverflowMenu (aria-label="More") with a
 * single item: { id: "close", label: "Close project", onClick: onBack }.
 * Clicking it calls onBack which navigates to the org home (/).
 *
 * This spec: opens a workspace → clicks the "More" overflow button →
 * clicks "Close project" → verifies URL returns to root.
 */
test("overflow menu Close project navigates back to home", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `OverflowClose ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Click the "More" overflow button in the workspace header.
  const moreBtn = alice.getByRole("button", { name: /^More$/i })
  await expect(moreBtn).toBeVisible({ timeout: 5_000 })
  await moreBtn.click()

  // "Close project" menuitem appears.
  const closeItem = alice.getByRole("menuitem", { name: /Close project/i })
  await expect(closeItem).toBeVisible({ timeout: 3_000 })
  await closeItem.click()

  // URL returns to / or /projects. waitForURL regexes match the FULL url
  // (origin included), so test the pathname instead.
  await alice.waitForURL(
    (url) => url.pathname === "/" || url.pathname === "/projects",
    { timeout: 5_000 },
  )
  expect(new URL(alice.url()).pathname).toMatch(/^\/(projects)?$/)
})
