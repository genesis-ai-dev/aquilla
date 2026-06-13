import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * WorkspaceHeader breadcrumb — "Dashboard" button navigates back to /.
 *
 * WorkspaceHeader.tsx renders a breadcrumb:
 *   <button onClick={onBack}>Dashboard</button> / <span>{project.name}</span>
 *
 * Clicking "Dashboard" calls onBack which navigates to the org home.
 *
 * This spec: imports a file, opens it, then clicks the Dashboard
 * breadcrumb button and verifies the URL returns to the root.
 */
test("Dashboard breadcrumb in workspace header navigates back to home", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `BreadCrumb ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Click the Dashboard breadcrumb button.
  const dashboardBtn = alice.getByRole("button", { name: /^Dashboard$/i })
  await expect(dashboardBtn).toBeVisible({ timeout: 5_000 })
  await dashboardBtn.click()

  // Should navigate back to the root / or /projects. waitForURL regexes
  // match the FULL url (origin included), so test the pathname instead.
  await alice.waitForURL(
    (url) => url.pathname === "/" || url.pathname === "/projects",
    { timeout: 5_000 },
  )
  expect(new URL(alice.url()).pathname).toMatch(/^\/(projects)?$/)
})
