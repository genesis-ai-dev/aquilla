import { test, expect } from "../../helpers/multi-user"
import type { Workspace } from "../../helpers/page-objects/Workspace"
import type { Page } from "@playwright/test"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

async function openWorkspaceWithSample(page: Page, namePrefix: string): Promise<Workspace> {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), {
    name: `${namePrefix} ${Date.now()}`,
  })
  return openSeededProject(page, seeded)
}

/**
 * TabStrip — open and close file tabs.
 *
 * TabStrip renders a role="tablist" aria-label="Open files" once a file
 * is opened. Each tab has role="tab" with the filename as title and a
 * Close button aria-label="Close <filename>" — revealed on tab hover.
 *
 * Clicking a second file opens a second tab. Clicking the close button
 * on a tab removes it from the tablist.
 *
 * This spec: import one file → tab appears → close it → tablist empties.
 */
test("TabStrip shows file tab and close button removes it", async ({ alice }) => {
  await openWorkspaceWithSample(alice, "TabStrip")

  // TabStrip becomes visible with one tab.
  const tabList = alice.getByRole("tablist", { name: /Open files/i })
  await expect(tabList).toBeVisible({ timeout: 5_000 })

  // There's at least one tab.
  const tabs = tabList.getByRole("tab")
  await expect(tabs.first()).toBeVisible({ timeout: 3_000 })

  // Close button is hover-revealed — hover the tab first.
  const tab = tabs.first()
  await tab.hover()
  const closeBtn = tabList.getByRole("button", { name: /^Close /i }).first()
  await expect(closeBtn).toBeVisible({ timeout: 3_000 })
  await closeBtn.click()

  // The tab itself is removed. The strip CONTAINER stays mounted — closing
  // the last tab is allowed now (commit 2af182924) and the empty strip
  // remains — so assert on the tabs, not the tablist.
  await expect(tabs).toHaveCount(0, { timeout: 5_000 })
})

test("TabStrip keeps the active file tab visible after page refresh", async ({ alice }) => {
  const ws = await openWorkspaceWithSample(alice, "TabStrip refresh")

  await alice.reload({ waitUntil: "domcontentloaded" })
  await ws.waitForEditor()

  const tabList = alice.getByRole("tablist", { name: /Open files/i })
  await expect(tabList).toBeVisible({ timeout: 5_000 })

  const sampleTab = tabList.getByRole("tab", { name: /sample\.md/i })
  await expect(sampleTab).toBeVisible({ timeout: 5_000 })

  await sampleTab.hover()
  const closeBtn = tabList.getByRole("button", { name: /^Close sample\.md$/i })
  await expect(closeBtn).toBeVisible({ timeout: 3_000 })
  await closeBtn.click()
  await expect(sampleTab).toHaveCount(0, { timeout: 5_000 })
})
