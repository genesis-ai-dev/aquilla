import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * Workspace sidebar pins Terminology and Recently deleted below Comments
 * (outside "More") and no longer shows a Glossary pseudo-file above the
 * file list.
 *
 * SidebarProjectSection shows pinned project-nav rows always-visible; unpinned
 * items collapse behind "More project options". Terminology and trash are
 * pinned so translators can open the glossary and recover files without
 * opening an overflow menu. With nothing left unpinned, More is hidden.
 *
 * This spec: import a file → assert Comments + Terminology + Recently deleted
 * are visible in the aside → assert Glossary is absent from the file list →
 * click Terminology → land on /terminology.
 */
test("sidebar pins Terminology and Recently deleted below Comments", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), {
    name: `SidebarTerm ${Date.now()}`,
  })
  await openSeededProject(alice, seeded)

  const aside = alice.locator("aside")
  const comments = aside.getByRole("button", { name: /^Comments$/i })
  const terminology = aside.getByRole("button", { name: /^Terminology$/i })
  const trash = aside.getByRole("button", { name: /^Recently deleted$/i })
  await expect(comments).toBeVisible({ timeout: 10_000 })
  await expect(terminology).toBeVisible({ timeout: 10_000 })
  await expect(trash).toBeVisible({ timeout: 10_000 })

  // Terminology and trash are sibling pinned rows, not buried in More.
  // With nothing left unpinned, the overflow trigger is gone.
  await expect(alice.getByRole("button", { name: /^More project options$/i })).toHaveCount(0)
  // Project settings lives in the header cog, not the sidebar overflow.
  await expect(aside.getByRole("button", { name: /^Settings$/i })).toHaveCount(0)
  // Glossary no longer sits above the file list — Terminology owns that nav.
  await expect(aside.getByRole("button", { name: /^Glossary$/i })).toHaveCount(0)
  const boxComments = await comments.boundingBox()
  const boxTerminology = await terminology.boundingBox()
  const boxTrash = await trash.boundingBox()
  expect(boxComments && boxTerminology && boxTrash).toBeTruthy()
  expect(boxTerminology!.y).toBeGreaterThan(boxComments!.y)
  expect(boxTrash!.y).toBeGreaterThan(boxTerminology!.y)

  await trash.click()
  const trashDialog = alice.getByRole("dialog", { name: /Recently deleted/i })
  await expect(trashDialog).toBeVisible({ timeout: 5_000 })
  await expect(trashDialog.getByText(/No recently deleted files/i)).toBeVisible()
  await trashDialog.getByRole("button", { name: /^Close$/i }).click()
  await expect(trashDialog).not.toBeVisible({ timeout: 3_000 })

  await terminology.click()
  await alice.waitForURL(/\/project\/[^/]+\/terminology/, { timeout: 5_000 })
  expect(alice.url()).toMatch(/\/terminology/)
})
