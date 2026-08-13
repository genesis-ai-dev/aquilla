import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { ensureAuthState } from "../../helpers/auth"
import { createOrg } from "../../helpers/frontier-api"

function isoDateOffset(days: number): string {
  const date = new Date()
  date.setDate(date.getDate() + days)
  return date.toISOString().slice(0, 10)
}

/**
 * Org overview + projects split.
 *
 * Overview (`/orgs/:id/overview`, landing after `/`):
 *  - Org name heading (h1)
 *  - Rollup strip: Projects / Avg translated / Avg validated / Avg audio /
 *    Stalled / Overdue tiles
 *  - Needs attention table
 *
 * Projects (`/orgs/:id/projects`):
 *  - Filter bar (search + status filter select) when projects exist
 *  - Project rows linking to /projects/:id
 *
 * All organizations (`/orgs/all`): portfolio Overview only (sidebar label
 * "Overview", no separate Projects nav) — rollups + cross-org project table.
 *
 * We create a project first so the portfolio API has at least one entry,
 * guaranteeing the filter bar and attention surfaces can render.
 */
test("org overview renders rollup stats and project filter", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()

  // Create a project so the portfolio has at least one entry.
  const name = `Overview dashboard project with a deliberately long name ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "conversational Spanish" })

  // Give the project a deterministic status so the compact deadline indicator
  // and its explanatory tooltip can be exercised in the portfolio table.
  await alice.getByRole("button", { name: /Set deadline/i }).click()
  await alice.getByLabel(/Deadline date/i).fill(isoDateOffset(-3))
  await alice.getByRole("button", { name: /^Save$/i }).click()
  await expect(alice.locator('[data-testid="status-chip"]')).toHaveText(/Overdue/i)

  // Navigate to the org home (redirects member orgs to /overview).
  await alice.goto("/")
  // 1. Org name heading (h1) renders.
  await expect(alice.locator("h1").first()).toBeVisible({ timeout: 10_000 })
  await expect(alice).toHaveURL(/\/orgs\/\d+\/overview/)

  // 2. Rollup stats strip — each tile has a label in a small paragraph.
  for (const label of ["Projects", "Avg translated", "Avg validated", "Avg audio"]) {
    await expect(alice.getByText(label).first()).toBeVisible({ timeout: 5_000 })
  }

  // 3. Projects page — breadcrumb includes Projects; filter bar when projects exist.
  await alice.getByRole("navigation").getByRole("link", { name: "Projects" }).click()
  await expect(alice).toHaveURL(/\/orgs\/\d+\/projects/)
  await expect(
    alice.getByRole("navigation", { name: "breadcrumb" }).getByText("Projects", { exact: true }),
  ).toHaveAttribute("aria-current", "page")
  const filterInput = alice.locator('input[aria-label="Search projects…"]')
    .or(alice.getByRole("textbox", { name: /Search projects/i }))
    .or(alice.locator('input[aria-label="Filter projects by name"]'))
    .first()
  await expect(filterInput).toBeVisible({ timeout: 5_000 })

  // 4. Status filter select (All / Stalled / Overdue / Needs attention).
  const statusFilter = alice.getByRole("combobox", { name: /project status filter/i })
  await expect(statusFilter).toBeVisible({ timeout: 3_000 })
  await expect(statusFilter).toContainText(/^All/i)
  await statusFilter.click()
  await expect(alice.getByRole("option", { name: "Stalled" })).toBeVisible({ timeout: 3_000 })
  await expect(alice.getByRole("option", { name: "Overdue" })).toBeVisible({ timeout: 3_000 })
  await expect(alice.getByRole("option", { name: "Needs attention" })).toBeVisible({ timeout: 3_000 })
  // Close the listbox before continuing.
  await alice.keyboard.press("Escape")
  await expect(alice.getByRole("listbox")).toHaveCount(0)

  // 5. The new project's row is visible.
  await expect(alice.getByText(name).first()).toBeVisible({ timeout: 5_000 })

  // 6. All-organizations portfolio home is Overview (not a separate Projects
  // tool). Projects stack above Organizations; both use admin DataTable chrome.
  const aliceSession = await ensureAuthState("alice")
  // Enough orgs that the capped Organizations panel must scroll.
  for (let i = 0; i < 6; i++) {
    await createOrg(aliceSession.jwt, `Stacked org ${i} ${Date.now()}`)
  }
  await alice.goto("/orgs/all")
  await expect(alice.getByRole("navigation").getByRole("link", { name: "Overview" })).toBeVisible({
    timeout: 10_000,
  })
  await expect(alice.getByRole("navigation").getByRole("link", { name: "Projects" })).toHaveCount(0)

  const projectTable = alice.getByTestId("project-table")
  await expect(projectTable).toBeVisible({ timeout: 10_000 })
  const projectRow = alice.locator(`[data-project-id]`).filter({ hasText: name }).first()
  await expect(projectRow).toBeVisible({ timeout: 10_000 })

  const projectName = projectRow.getByTestId("project-table-name")
  const organization = projectRow.getByTestId("project-table-organization")
  await expect(projectName).toHaveText(name)
  await expect(organization).not.toBeEmpty()
  const organizationName = await organization.getAttribute("data-org-name")
  expect(organizationName).toBeTruthy()

  for (const header of ["Project", "Org", "Language", "Translated", "Validated", "Audio", "Status"]) {
    await expect(projectTable.getByText(header, { exact: true }).first()).toBeVisible()
  }
  // Embedded all-orgs table keeps Role / Updated out of the visible set (Updated
  // may exist as a hidden sort column — assert it is not shown as a header button).
  await expect(projectTable.getByRole("button", { name: /^Role/i })).toHaveCount(0)
  await expect(projectTable.getByRole("button", { name: /^Updated/i })).toHaveCount(0)

  await expect(projectRow.getByTestId("project-table-languages")).toBeVisible()
  await expect(projectRow.getByTestId("project-table-translated-value")).toBeVisible()
  await expect(projectRow.getByTestId("project-table-validated-value")).toBeVisible()
  await expect(projectRow.getByTestId("project-table-audio-value")).toBeVisible()
  await expect(projectRow.getByTestId("project-table-deadline-status")).toContainText("Overdue")

  const search = alice.getByRole("textbox", { name: /Search projects/i })
  await expect(search).toBeVisible()
  const statusFilterAllOrgs = alice.getByRole("combobox", { name: /project status filter/i })
  await expect(statusFilterAllOrgs).toBeVisible()
  // Column headers own sort — no separate Sort-by combobox.
  await expect(alice.getByRole("combobox", { name: "Sort projects" })).toHaveCount(0)

  const organizationsBox = await alice.getByTestId("organizations-panel").boundingBox()
  const projectsBox = await alice.getByTestId("projects-panel").boundingBox()
  expect(organizationsBox).not.toBeNull()
  expect(projectsBox).not.toBeNull()
  // Stacked: Projects above Organizations, full content width.
  expect(organizationsBox!.y).toBeGreaterThan(projectsBox!.y + projectsBox!.height - 2)
  expect(Math.abs(projectsBox!.x - organizationsBox!.x)).toBeLessThan(2)
  expect(Math.abs(projectsBox!.width - organizationsBox!.width)).toBeLessThan(4)
  const tableFits = await projectTable.evaluate(
    (element) => element.scrollWidth <= element.clientWidth,
  )
  expect(tableFits).toBe(true)

  const projectsPanelFits = await alice.getByTestId("projects-panel").evaluate(
    (element) => element.scrollWidth <= element.clientWidth,
  )
  expect(projectsPanelFits).toBe(true)

  await expect(alice.getByRole("button", { name: "Side-by-side layout" })).toHaveCount(0)
  await expect(alice.getByRole("button", { name: "Stacked layout" })).toHaveCount(0)

  await alice.setViewportSize({ width: 1024, height: 650 })
  const narrowOrganizationsBox = await alice.getByTestId("organizations-panel").boundingBox()
  const narrowProjectsBox = await alice.getByTestId("projects-panel").boundingBox()
  expect(narrowOrganizationsBox).not.toBeNull()
  expect(narrowProjectsBox).not.toBeNull()
  expect(narrowOrganizationsBox!.y).toBeGreaterThan(
    narrowProjectsBox!.y + narrowProjectsBox!.height - 2,
  )
  await expect(alice.getByText("Org", { exact: true }).first()).toBeVisible()
  await expect(alice.getByText("Language", { exact: true }).first()).toBeVisible()
  expect(
    await alice.getByTestId("projects-panel").evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true)

  const organizationsScroll = alice.getByTestId("organizations-scroll")
  // Rows scroll inside the table shell; search/status stay pinned above it.
  const projectsScroll = alice.getByTestId("project-table")
  expect(
    await organizationsScroll.evaluate((element) => getComputedStyle(element).overflowY),
  ).toBe("auto")
  expect(
    await projectsScroll.evaluate((element) => getComputedStyle(element).overflowY),
  ).toBe("auto")
  await expect(alice.getByRole("textbox", { name: /Search projects/i })).toBeVisible()
  await expect(alice.getByRole("combobox", { name: /project status filter/i })).toBeVisible()
  await expect
    .poll(async () =>
      organizationsScroll.evaluate((element) => element.scrollHeight > element.clientHeight + 1),
    )
    .toBe(true)
  await organizationsScroll.evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  expect(await organizationsScroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  await expect(projectTable.getByText("Project", { exact: true }).first()).toBeVisible()
})

test("org overview does not present false zeroes while its portfolio is loading", async ({ alice }) => {
  // The authenticated-page fixture reloads the app after injecting its session.
  // Wait for that navigation's dashboard request to settle before installing
  // counters for the explicit navigation below; otherwise a slow first load is
  // counted alongside the reload this test is actually measuring.
  await expect(alice.getByText("Avg translated", { exact: true })).toBeVisible()

  let releasePortfolio!: () => void
  let projectDirectoryRequests = 0
  const portfolioGate = new Promise<void>((resolve) => { releasePortfolio = resolve })
  await alice.route("**/api/v2/projects**", async (route) => {
    const request = route.request()
    if (request.method() === "GET" && new URL(request.url()).pathname === "/api/v2/projects") {
      projectDirectoryRequests += 1
    }
    await route.continue()
  })
  await alice.route("**/api/v2/orgs/*/portfolio", async (route) => {
    await portfolioGate
    await route.continue()
  })

  try {
    await alice.goto("/")

    await expect(alice.getByTestId("org-overview-loading")).toBeVisible()
    await expect(alice.getByText("Loading overview…")).toBeVisible()
    await expect(alice.getByTestId("org-overview-loading-template")).toBeVisible()
    await expect(alice.locator('[data-slot="app-shell-header"]')).toBeVisible()
    await expect(alice.getByTestId("loading-neutral-template")).toHaveCount(0)
    await expect(alice.getByText("Your organization is ready")).toHaveCount(0)
    await expect(alice.getByText("Avg translated", { exact: true })).toHaveCount(0)
  } finally {
    releasePortfolio()
  }

  await expect(alice.getByTestId("org-overview-loading")).toHaveCount(0)
  await expect(alice.getByText("Avg translated", { exact: true })).toBeVisible()
  // Portfolio gating must not fan out into a request storm. Strict remount /
  // org-shell hydration can legitimately issue a second directory read; the
  // invariant under test is "no false zeroes while loading", not single-flight.
  expect(projectDirectoryRequests).toBeGreaterThanOrEqual(1)
  expect(projectDirectoryRequests).toBeLessThanOrEqual(2)
})
