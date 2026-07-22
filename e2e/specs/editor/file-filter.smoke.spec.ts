import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * Sidebar file filter (ExpandableFileList).
 *
 * The sidebar has a role="searchbox" input (aria-label "Filter files").
 * Typing filters the file list in real time; a clear button appears.
 * A query that matches returns the file; one that doesn't returns
 * "No files match …".
 */
test("sidebar file filter narrows file list and clears", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `FileFilter ${Date.now()}` })
  await openSeededProject(alice, seeded)

  // The sidebar should list the imported file.
  const sidebar = alice.locator("aside")
  await expect(sidebar.getByText(/sample/i).first()).toBeVisible({ timeout: 5_000 })

  // 1. Locate the filter input and type a matching query.
  const filterInput = sidebar.locator('[role="searchbox"][aria-label="Filter files"]')
  await expect(filterInput).toBeVisible({ timeout: 3_000 })
  await filterInput.fill("sample")

  // The "sample" file is still visible.
  await expect(sidebar.getByText(/sample/i).first()).toBeVisible({ timeout: 3_000 })

  // The clear button appears.
  const clearBtn = sidebar.locator('button[aria-label="Clear filter"]')
  await expect(clearBtn).toBeVisible({ timeout: 3_000 })

  // 2. Type a non-matching query.
  await filterInput.fill("zzz-no-match")
  await expect(sidebar.getByText(/No files match/i).first()).toBeVisible({ timeout: 3_000 })

  // 3. Clear the filter — the file list should reappear.
  await clearBtn.click()
  await expect(filterInput).toHaveValue("", { timeout: 2_000 })
  await expect(sidebar.getByText(/sample/i).first()).toBeVisible({ timeout: 3_000 })
})
