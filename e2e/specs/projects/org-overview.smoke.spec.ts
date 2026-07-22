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
  const name = `Overview dashboard project with a deliberately long name ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "conversational Spanish" })

  // Give the project a deterministic status so the compact deadline indicator
  // and its explanatory tooltip can be exercised in the portfolio table.
  await alice.getByRole("button", { name: /Set deadline/i }).click()
  await alice.getByLabel(/Deadline date/i).fill(isoDateOffset(-3))
  await alice.getByRole("button", { name: /^Save$/i }).click()
  await expect(alice.locator('[data-testid="status-chip"]')).toHaveText(/Overdue/i)

  // Navigate to the org home.
  await alice.goto("/")
  // 1. Org name heading (h1) renders.
  await expect(alice.locator("h1").first()).toBeVisible({ timeout: 10_000 })

  // 2. Rollup stats strip — each tile has a label in a small paragraph.
  for (const label of ["Projects", "Avg translated", "Avg validated", "Avg audio"]) {
    await expect(alice.getByText(label).first()).toBeVisible({ timeout: 5_000 })
  }

  // 3. Filter bar — visible when projects exist.
  const filterInput = alice.locator('input[aria-label="Filter projects by name"]')
  await expect(filterInput).toBeVisible({ timeout: 5_000 })

  // 4. Status filter buttons (All / Stalled / Overdue / Needs attention).
  await expect(alice.getByRole("button", { name: "All" }).first()).toBeVisible({ timeout: 3_000 })
  await expect(alice.getByRole("button", { name: "Stalled" }).first()).toBeVisible({ timeout: 3_000 })
  await expect(alice.getByRole("button", { name: "Overdue" }).first()).toBeVisible({ timeout: 3_000 })
  await expect(alice.getByRole("button", { name: "Needs attention" }).first()).toBeVisible({ timeout: 3_000 })

  // 5. The new project's card is visible.
  await expect(alice.getByText(name).first()).toBeVisible({ timeout: 5_000 })

  // 6. In the all-organizations table, project and org identity remain useful
  // at both wide and compact desktop widths. Long names expand without shifting
  // the row, while ordinary names are not squeezed to one or two characters.
  const aliceSession = await ensureAuthState("alice")
  await createOrg(aliceSession.jwt, `A second organization with a long name ${Date.now()}`)
  await alice.goto("/?org=all")
  const projectRow = alice.locator(`[data-project-id]`).filter({ hasText: name }).first()
  await expect(projectRow).toBeVisible({ timeout: 10_000 })
  const projectName = projectRow.getByTestId("project-table-name")
  const expandedProjectName = projectRow.getByTestId("project-table-name-expanded")
  const organization = projectRow.getByTestId("project-table-organization")
  const projectTable = alice.getByTestId("project-table")
  await expect(projectName).toHaveText(name)
  await expect(organization).not.toBeEmpty()
  const projectHeader = projectTable.getByText("Project", { exact: true })
  await expect(projectTable.getByText("Language", { exact: true })).toBeVisible()
  const translatedHeader = projectTable.getByTestId("project-table-translated-header")
  const validatedHeader = projectTable.getByTestId("project-table-validated-header")
  const audioHeader = projectTable.getByTestId("project-table-audio-header")
  await expect(translatedHeader).toHaveAttribute("aria-label", "Translated")
  await expect(validatedHeader).toHaveAttribute("aria-label", "Validated")
  await expect(audioHeader).toHaveAttribute("aria-label", "Has audio")
  await translatedHeader.hover()
  await expect(alice.getByRole("tooltip")).toContainText("Translated", { timeout: 250 })
  await alice.keyboard.press("Escape")
  await audioHeader.focus()
  await expect(alice.getByRole("tooltip")).toContainText("Audio", { timeout: 250 })
  await alice.keyboard.press("Escape")
  await expect(projectTable.getByText("Role", { exact: true })).toHaveCount(0)
  await expect(projectTable.getByText("Updated", { exact: true })).toHaveCount(0)
  await expect(projectRow.getByText(/Updated /)).toHaveCount(0)
  const organizationName = await organization.getAttribute("data-org-name")
  expect(organizationName).toBeTruthy()
  const translatedHeaderBox = await translatedHeader.boundingBox()
  const projectHeaderBox = await projectHeader.boundingBox()
  const translatedValueBox = await projectRow.getByTestId("project-table-translated-value").boundingBox()
  const languagesBox = await projectRow.getByTestId("project-table-languages").boundingBox()
  const languageChip = projectRow.locator('[data-testid^="lane-chip-"]').first()
  const languageChipBox = await languageChip.boundingBox()
  const validatedHeaderBox = await validatedHeader.boundingBox()
  const validatedValueBox = await projectRow.getByTestId("project-table-validated-value").boundingBox()
  const audioHeaderBox = await audioHeader.boundingBox()
  const audioValueBox = await projectRow.getByTestId("project-table-audio-value").boundingBox()
  const projectTableBox = await projectTable.boundingBox()
  expect(translatedHeaderBox).not.toBeNull()
  expect(projectHeaderBox).not.toBeNull()
  expect(translatedValueBox).not.toBeNull()
  expect(languagesBox).not.toBeNull()
  expect(languageChipBox).not.toBeNull()
  expect(validatedHeaderBox).not.toBeNull()
  expect(validatedValueBox).not.toBeNull()
  expect(audioHeaderBox).not.toBeNull()
  expect(audioValueBox).not.toBeNull()
  expect(projectTableBox).not.toBeNull()
  expect(
    Math.abs(
      projectHeaderBox!.y + projectHeaderBox!.height / 2 -
        (translatedHeaderBox!.y + translatedHeaderBox!.height / 2),
    ),
  ).toBeLessThan(2)
  expect(Math.abs(translatedHeaderBox!.x - translatedValueBox!.x)).toBeLessThan(2)
  // Assert the painted child boundary, not only the grid track. The latter can
  // remain perfectly aligned while an intrinsically wide chip overpaints the
  // adjacent percentage column (the AQU-651 regression).
  expect(languageChipBox!.x).toBeGreaterThanOrEqual(languagesBox!.x)
  expect(languageChipBox!.x + languageChipBox!.width).toBeLessThanOrEqual(
    languagesBox!.x + languagesBox!.width,
  )
  expect(
    translatedValueBox!.x - (languageChipBox!.x + languageChipBox!.width),
  ).toBeGreaterThanOrEqual(8)
  expect(translatedValueBox!.x - (languagesBox!.x + languagesBox!.width)).toBeGreaterThanOrEqual(8)
  expect(Math.abs(validatedHeaderBox!.x - validatedValueBox!.x)).toBeLessThan(2)
  expect(Math.abs(audioHeaderBox!.x - audioValueBox!.x)).toBeLessThan(2)
  expect(projectTableBox!.x + projectTableBox!.width - (audioValueBox!.x + audioValueBox!.width)).toBeLessThanOrEqual(32)
  const projectNameBox = await projectName.boundingBox()
  const organizationBox = await organization.boundingBox()
  expect(projectNameBox).not.toBeNull()
  expect(organizationBox).not.toBeNull()
  // The project gets enough visible width for a meaningful prefix even in the
  // compact side-by-side layout; short names are allowed to size naturally.
  expect(projectNameBox!.width).toBeGreaterThanOrEqual(64)
  expect(organizationBox!.width).toBeLessThanOrEqual(160)

  const projectRowBoxBeforeHover = await projectRow.boundingBox()
  const projectNameBoxBeforeHover = await projectName.boundingBox()
  await expect(projectName).not.toHaveAttribute("title")
  await expect(projectName).toHaveCSS("text-overflow", "clip")
  await expect(projectRow.locator(`[title="${name}"]`)).toHaveCount(0)
  await expect(projectName.locator("..")).toHaveAttribute("data-project-name-truncated", "true")
  await projectName.hover()
  await expect(expandedProjectName).toHaveText(name)
  await expect(expandedProjectName).toHaveCSS("opacity", "1")
  await expect(expandedProjectName).toHaveCSS("z-index", "50")
  const expandedProjectNameBox = await expandedProjectName.boundingBox()
  expect(expandedProjectNameBox).not.toBeNull()
  expect(expandedProjectNameBox!.x).toBeLessThan(projectNameBoxBeforeHover!.x)
  expect(expandedProjectNameBox!.width).toBeGreaterThan(projectNameBoxBeforeHover!.width)
  await expect(alice.getByRole("tooltip")).toHaveCount(0)
  const projectRowBoxAfterHover = await projectRow.boundingBox()
  const projectNameBoxAfterHover = await projectName.boundingBox()
  expect(projectRowBoxAfterHover).toEqual(projectRowBoxBeforeHover)
  expect(projectNameBoxAfterHover).toEqual(projectNameBoxBeforeHover)

  await organization.hover()
  await expect(alice.getByRole("tooltip")).toHaveCount(0)
  const organizationHeader = alice.getByText("Org", { exact: true })
  await expect(organizationHeader).toBeVisible()
  const organizationHeaderBox = await organizationHeader.boundingBox()
  expect(organizationHeaderBox).not.toBeNull()
  expect(Math.abs(organizationHeaderBox!.x - organizationBox!.x)).toBeLessThan(16)

  const deadlineTrigger = projectRow.getByTestId("project-table-deadline-trigger")
  await expect(deadlineTrigger).toBeVisible()
  await deadlineTrigger.hover()
  const deadlineTooltip = alice.getByRole("tooltip")
  await expect(deadlineTooltip).toContainText("Overdue", { timeout: 250 })
  await expect(deadlineTooltip).toContainText("Due", { timeout: 250 })

  const organizationsBox = await alice.getByTestId("organizations-panel").boundingBox()
  const projectsBox = await alice.getByTestId("projects-panel").boundingBox()
  expect(organizationsBox).not.toBeNull()
  expect(projectsBox).not.toBeNull()
  expect(Math.abs(projectsBox!.y - organizationsBox!.y)).toBeLessThan(2)
  expect(projectsBox!.x).toBeGreaterThan(organizationsBox!.x + organizationsBox!.width)
  expect(projectsBox!.width / organizationsBox!.width).toBeGreaterThanOrEqual(1.9)
  const tableFits = await alice.getByTestId("project-table").evaluate(
    (element) => element.scrollWidth <= element.clientWidth,
  )
  expect(tableFits).toBe(true)

  const projectsPanelFits = await alice.getByTestId("projects-panel").evaluate(
    (element) => element.scrollWidth <= element.clientWidth,
  )
  expect(projectsPanelFits).toBe(true)
  const sortBox = await alice.getByRole("combobox", { name: "Sort projects" }).boundingBox()
  expect(sortBox).not.toBeNull()
  expect(sortBox!.x + sortBox!.width).toBeLessThanOrEqual(projectsBox!.x + projectsBox!.width)

  await expect(alice.getByRole("button", { name: "Side-by-side layout" })).toHaveCount(0)
  await expect(alice.getByRole("button", { name: "Stacked layout" })).toHaveCount(0)

  await alice.setViewportSize({ width: 1024, height: 650 })
  const narrowOrganizationsBox = await alice.getByTestId("organizations-panel").boundingBox()
  const narrowProjectsBox = await alice.getByTestId("projects-panel").boundingBox()
  expect(narrowOrganizationsBox).not.toBeNull()
  expect(narrowProjectsBox).not.toBeNull()
  expect(Math.abs(narrowProjectsBox!.y - narrowOrganizationsBox!.y)).toBeLessThan(2)
  expect(narrowOrganizationsBox!.y + narrowOrganizationsBox!.height).toBeLessThan(650)
  expect(narrowProjectsBox!.y + narrowProjectsBox!.height).toBeLessThan(650)
  await expect(alice.getByText("Org", { exact: true })).toBeVisible()
  await expect(alice.getByText("Language", { exact: true })).toBeVisible()
  const narrowLanguagesBox = await projectRow.getByTestId("project-table-languages").boundingBox()
  const narrowLanguageChipBox = await languageChip.boundingBox()
  const narrowTranslatedValueBox = await projectRow
    .getByTestId("project-table-translated-value")
    .boundingBox()
  expect(narrowLanguagesBox).not.toBeNull()
  expect(narrowLanguageChipBox).not.toBeNull()
  expect(narrowTranslatedValueBox).not.toBeNull()
  expect(narrowLanguageChipBox!.x + narrowLanguageChipBox!.width).toBeLessThanOrEqual(
    narrowLanguagesBox!.x + narrowLanguagesBox!.width,
  )
  expect(
    narrowTranslatedValueBox!.x - (narrowLanguageChipBox!.x + narrowLanguageChipBox!.width),
  ).toBeGreaterThanOrEqual(8)
  expect(
    await alice.getByTestId("projects-panel").evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true)

  const organizationsScroll = alice.getByTestId("organizations-scroll")
  const projectsScroll = alice.getByTestId("projects-scroll")
  expect(
    await organizationsScroll.evaluate((element) => getComputedStyle(element).overflowY),
  ).toBe("auto")
  expect(
    await projectsScroll.evaluate((element) => getComputedStyle(element).overflowY),
  ).toBe("auto")
  await organizationsScroll.evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  expect(await organizationsScroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  await expect(projectTable.getByText("Project", { exact: true })).toBeVisible()
})

test("org overview does not present false zeroes while its portfolio is loading", async ({ alice }) => {
  let releasePortfolio!: () => void
  const portfolioGate = new Promise<void>((resolve) => { releasePortfolio = resolve })
  await alice.route("**/api/v2/orgs/*/portfolio", async (route) => {
    await portfolioGate
    await route.continue()
  })

  try {
    await alice.goto("/")

    await expect(alice.getByTestId("org-home-loading")).toBeVisible()
    await expect(alice.getByText("Loading workspace…")).toBeVisible()
    await expect(alice.getByText("Your organization is ready")).toHaveCount(0)
    await expect(alice.getByText("Avg translated", { exact: true })).toHaveCount(0)
  } finally {
    releasePortfolio()
  }

  await expect(alice.getByTestId("org-home-loading")).toHaveCount(0)
  await expect(alice.getByText("Avg translated", { exact: true })).toBeVisible()
})
