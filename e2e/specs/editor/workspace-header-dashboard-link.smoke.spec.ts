import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * WorkspaceHeader — "Dashboard" breadcrumb navigation.
 *
 * WorkspaceHeader.tsx renders a breadcrumb:
 *   [Dashboard] / [project name]
 *
 * Clicking "Dashboard" calls onBack(), which navigates to the projects list.
 *
 * This spec: open a project → click "Dashboard" breadcrumb →
 * verify URL returns to the projects/dashboard route.
 */
test("workspace header Dashboard breadcrumb navigates to projects list", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `HeaderDash ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Click the "Dashboard" breadcrumb button.
  const dashboardLink = alice.getByRole("button", { name: /^Dashboard$/i })
  await expect(dashboardLink).toBeVisible({ timeout: 5_000 })
  await dashboardLink.click()

  // URL changes to / or /projects. waitForURL regexes match the FULL url
  // (origin included), so test the pathname instead.
  await alice.waitForURL(
    (url) => url.pathname === "/" || url.pathname === "/projects",
    { timeout: 5_000 },
  )
})
