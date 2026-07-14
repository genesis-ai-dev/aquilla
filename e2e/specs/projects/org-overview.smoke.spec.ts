import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { ensureAuthState } from "../../helpers/auth"
import { createOrg } from "../../helpers/frontier-api"

/**
 * Org overview (OrgHome at "/").
 *
 * The page shows:
 *  - Org name heading (h1)
 *  - Rollup strip: Projects / Avg translated / Avg validated / Avg audio /
 *    Stalled / Overdue tiles
 *  - Filter bar (input + status filter buttons) when projects exist
 *  - Project cards linking to /projects/:id
 *
 * We create a project first so the portfolio API has at least one entry,
 * guaranteeing the filter bar renders.
 */
test("org overview renders rollup stats and project filter", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()

  // Create a project so the portfolio has at least one entry.
  const name = `Overview ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  // Navigate to the org home.
  await alice.goto("/")
  await alice.waitForLoadState("networkidle")

  // 1. Org name heading (h1) renders.
  await expect(alice.locator("h1").first()).toBeVisible({ timeout: 10_000 })

  // 2. Rollup stats strip — each tile has a label in a small paragraph.
  for (const label of ["Projects", "Avg translated", "Avg validated", "Avg audio"]) {
    await expect(alice.getByText(label).first()).toBeVisible({ timeout: 5_000 })
  }

  // 3. Filter bar — visible when projects exist.
  const filterInput = alice.locator('input[aria-label="Filter projects by name"]')
  await expect(filterInput).toBeVisible({ timeout: 5_000 })

  // 4. Status filter buttons (All / Stalled / Overdue).
  await expect(alice.getByRole("button", { name: "All" }).first()).toBeVisible({ timeout: 3_000 })
  await expect(alice.getByRole("button", { name: "Stalled" }).first()).toBeVisible({ timeout: 3_000 })

  // 5. The new project's card is visible.
  await expect(alice.getByText(name).first()).toBeVisible({ timeout: 5_000 })

  // 6. In the all-organizations table, the org remains a compact secondary
  // badge beside the project name. It must not become a separate rigid column
  // or squeeze the project name down to one or two characters.
  const aliceSession = await ensureAuthState("alice")
  await createOrg(aliceSession.jwt, `A second organization with a long name ${Date.now()}`)
  await alice.goto("/?org=all")
  await alice.waitForLoadState("networkidle")

  const projectRow = alice.locator(`[data-project-id]`).filter({ hasText: name }).first()
  await expect(projectRow).toBeVisible({ timeout: 10_000 })
  const projectName = projectRow.getByTestId("project-table-name")
  const organization = projectRow.getByTestId("project-table-organization")
  await expect(projectName).toHaveText(name)
  await expect(organization).not.toBeEmpty()
  const organizationName = await organization.getAttribute("data-org-name")
  expect(organizationName).toBeTruthy()
  const projectNameBox = await projectName.boundingBox()
  const organizationBox = await organization.boundingBox()
  expect(projectNameBox).not.toBeNull()
  expect(organizationBox).not.toBeNull()
  expect(projectNameBox!.width).toBeGreaterThanOrEqual(96)
  expect(organizationBox!.width).toBeLessThanOrEqual(160)

  await organization.hover()
  await expect(alice.getByRole("tooltip")).toHaveCount(0)
  const organizationHeader = alice.getByText("Organization", { exact: true })
  await expect(organizationHeader).toBeVisible()
  const organizationHeaderBox = await organizationHeader.boundingBox()
  expect(organizationHeaderBox).not.toBeNull()
  expect(Math.abs(organizationHeaderBox!.x + organizationHeaderBox!.width - (organizationBox!.x + organizationBox!.width))).toBeLessThan(16)
  const organizationsBox = await alice.getByTestId("organizations-panel").boundingBox()
  const projectsBox = await alice.getByTestId("projects-panel").boundingBox()
  expect(organizationsBox).not.toBeNull()
  expect(projectsBox).not.toBeNull()
  expect(Math.abs(projectsBox!.y - organizationsBox!.y)).toBeLessThan(2)
  expect(projectsBox!.x).toBeGreaterThan(organizationsBox!.x + organizationsBox!.width)
  const tableFits = await alice.getByTestId("project-table").evaluate(
    (element) => element.scrollWidth <= element.clientWidth,
  )
  expect(tableFits).toBe(true)
})
