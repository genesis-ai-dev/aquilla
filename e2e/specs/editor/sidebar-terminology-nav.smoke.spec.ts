import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * Workspace sidebar pins Terminology below Comments (outside "More") and
 * no longer shows a Glossary pseudo-file above the file list.
 *
 * SidebarProjectSection shows pinned project-nav rows always-visible; unpinned
 * items collapse behind "More project options". Terminology is pinned so
 * translators can open the glossary without opening the overflow menu.
 *
 * This spec: import a file → assert Comments + Terminology are visible in the
 * aside without opening More → assert Glossary is absent from the file list →
 * click Terminology → land on /terminology.
 */
test("sidebar Terminology is visible below Comments and navigates to glossary", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), {
    name: `SidebarTerm ${Date.now()}`,
  })
  await openSeededProject(alice, seeded)

  const aside = alice.locator("aside")
  const comments = aside.getByRole("button", { name: /^Comments$/i })
  const terminology = aside.getByRole("button", { name: /^Terminology$/i })
  await expect(comments).toBeVisible({ timeout: 10_000 })
  await expect(terminology).toBeVisible({ timeout: 10_000 })

  // Terminology must be a sibling pinned row, not buried in More.
  await expect(alice.getByRole("button", { name: /^More project options$/i })).toBeVisible()
  // Project settings lives in the header cog, not the sidebar overflow.
  await expect(aside.getByRole("button", { name: /^Settings$/i })).toHaveCount(0)
  // Glossary no longer sits above the file list — Terminology owns that nav.
  await expect(aside.getByRole("button", { name: /^Glossary$/i })).toHaveCount(0)
  const boxComments = await comments.boundingBox()
  const boxTerminology = await terminology.boundingBox()
  expect(boxComments && boxTerminology).toBeTruthy()
  expect(boxTerminology!.y).toBeGreaterThan(boxComments!.y)

  await terminology.click()
  await alice.waitForURL(/\/project\/[^/]+\/terminology/, { timeout: 5_000 })
  expect(alice.url()).toMatch(/\/terminology/)
})
