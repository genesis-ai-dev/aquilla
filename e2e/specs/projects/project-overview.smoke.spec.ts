import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * ProjectOverview (/projects/:id).
 *
 * After creating a project, the dashboard navigates to /projects/:id.
 * The page renders:
 *   - h1 with the project name
 *   - h2 "Deadline" and "Team" cards (always rendered; the "Progress" card
 *     only renders once the project has cells — `audio.totalCells > 0` in
 *     ProjectOverview.tsx — so a freshly created empty project shows none)
 *   - "Open project" button linking to the workspace
 *
 * This spec verifies the overview renders correctly, the Open project button
 * navigates to the workspace, and the shared breadcrumb path remains useful
 * across both surfaces.
 */
test("project overview renders name, overview cards, and Open project button", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `Overview ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  // createProject navigates to /projects/:id.
  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  // h1 — project name.
  await expect(
    alice.locator("h1").filter({ hasText: name })
  ).toBeVisible({ timeout: 10_000 })

  // h2 "Deadline" and "Team" cards (always rendered; "Progress" requires
  // cells, which a freshly created project doesn't have yet).
  await expect(
    alice.locator("h2").filter({ hasText: /Deadline/i }).first()
  ).toBeVisible({ timeout: 5_000 })
  await expect(
    alice.locator("h2").filter({ hasText: /Team/i }).first()
  ).toBeVisible({ timeout: 5_000 })

  const overviewBreadcrumb = alice.getByRole("navigation", { name: "breadcrumb" })
  await expect(overviewBreadcrumb.getByRole("link", { name: "All organizations", exact: true })).toBeVisible()
  await expect(overviewBreadcrumb.getByText(name, { exact: true })).toHaveAttribute("aria-current", "page")

  // "Open project" button navigates to the workspace.
  const openBtn = alice.getByRole("link", { name: /Open project/i })
    .or(alice.getByRole("button", { name: /Open project/i }))
  await expect(openBtn.first()).toBeVisible({ timeout: 5_000 })
  await openBtn.first().click()

  // Workspace URL: /project/:id/editor
  await alice.waitForURL(/\/project\/[^/]+\/editor(?:\/file\/[^/]+)?(?:\?|$)/, { timeout: 10_000 })
  await expect(alice.locator('[aria-label="Filter files"]')).toBeVisible({ timeout: 5_000 })

  const workspaceBreadcrumb = alice.getByRole("navigation", { name: "breadcrumb" })
  const allOrganizations = workspaceBreadcrumb.getByRole("link", { name: "All organizations", exact: true })
  await expect(allOrganizations).toBeVisible()
  await expect(workspaceBreadcrumb.getByRole("link", { name, exact: true })).toBeVisible()
  await expect(workspaceBreadcrumb.getByText("Editor", { exact: true })).toHaveAttribute("aria-current", "page")

  await allOrganizations.click()
  await alice.waitForURL(/\/orgs\/all$/, { timeout: 10_000 })
  await expect(
    alice.getByRole("navigation", { name: "breadcrumb" }).getByText("All organizations", { exact: true }),
  ).toHaveAttribute("aria-current", "page")
})

test("project overview keeps its template visible with explicit progress while details load", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `Overview loading ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/?]+)/)?.[1]
  expect(projectId).toBeTruthy()

  await alice.goto("/")

  let releaseProject!: () => void
  const projectGate = new Promise<void>((resolve) => {
    releaseProject = resolve
  })
  await alice.route(`**/api/v2/projects/${projectId}`, async (route) => {
    if (route.request().method() === "GET") await projectGate
    await route.continue()
  })

  try {
    await alice.goto(`/projects/${projectId}`)

    const loading = alice.getByRole("status", {
      name: "Loading project details",
    })
    await expect(loading).toBeVisible()
    await expect(loading.locator("[data-slot='spinner']")).toBeVisible()
    await expect(alice.getByText("Loading project details…")).toBeVisible()
    await expect(alice.getByRole("heading", { level: 1, name })).toHaveCount(0)
  } finally {
    releaseProject()
  }

  await expect(
    alice.getByRole("heading", { level: 1, name }),
  ).toBeVisible()
})
