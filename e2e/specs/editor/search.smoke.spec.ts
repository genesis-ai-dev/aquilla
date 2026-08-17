import { test, expect, type AuthedPage } from "../../helpers/multi-user"
import {
  jwtFor,
  openSeededProject,
  seedProjectWithFile,
} from "../../helpers/seed-project"

/**
 * Surface session: Search panel (ParallelPassagesPanel) — open paths, replace,
 * scope, mode. One `{ alice }` → one resetBackend(); steps dismiss the panel
 * so later shortcuts/opens stay independent.
 */

/** Dock rail Search (aside) — not the toolbar Search twin that appears after replace. */
async function openDockSearch(page: AuthedPage): Promise<void> {
  const openFullBtn = page.getByRole("button", { name: "Open full search panel" })
  // Branch: dock may already be open from a prior step in this surface session.
  if (await openFullBtn.isVisible()) return
  await page.locator("aside").getByRole("button", { name: "Search", exact: true }).click()
  await expect(openFullBtn).toBeVisible({ timeout: 5_000 })
}

test("search panel open paths, scope, and mode surface session", async ({ alice }) => {
  test.setTimeout(120_000)

  const seeded = await seedProjectWithFile(await jwtFor(alice.username), {
    name: `Search ${Date.now()}`,
  })
  await openSeededProject(alice, seeded)

  await test.step("dock Search → full panel accepts query and shows no-results", async () => {
    await openDockSearch(alice)
    await alice.getByRole("button", { name: "Open full search panel" }).click()

    const panel = alice.getByRole("dialog")
    await expect(panel).toBeVisible({ timeout: 5_000 })

    const input = panel.getByRole("combobox").first()
    await expect(input).toBeVisible({ timeout: 5_000 })
    const needle = `zzz-no-match-${Date.now()}`
    await input.fill(needle)
    await expect(panel.getByText(/No results for/i)).toBeVisible({ timeout: 10_000 })

    await alice.keyboard.press("Escape")
    await expect(panel).not.toBeVisible({ timeout: 5_000 })
  })

  await test.step("Ctrl+K opens the search panel", async () => {
    await alice.keyboard.press("Control+k")
    const panel = alice.getByRole("dialog")
    await expect(panel).toBeVisible({ timeout: 5_000 })
    const searchInput = panel.getByRole("combobox", { name: /Search/i }).first()
    await expect(searchInput).toBeVisible({ timeout: 5_000 })
    await alice.keyboard.press("Escape")
    await expect(panel).not.toBeVisible({ timeout: 3_000 })
  })

  await test.step("Ctrl+Shift+R opens search+replace", async () => {
    await alice.keyboard.press("Control+Shift+r")
    const panel = alice.getByRole("dialog")
    await expect(panel).toBeVisible({ timeout: 8_000 })
    const replaceInput = panel.getByRole("textbox", { name: /Replacement/i })
    await expect(replaceInput).toBeVisible({ timeout: 8_000 })
    await alice.keyboard.press("Escape")
    await expect(panel).not.toBeVisible({ timeout: 3_000 })
  })

  await test.step("dock Search tab and Open full search panel", async () => {
    await openDockSearch(alice)
    const dockInput = alice.locator("aside").locator('input[placeholder*="Search" i]').first()
    await expect(dockInput).toBeVisible({ timeout: 5_000 })

    await alice.getByRole("button", { name: "Open full search panel" }).click()
    const panel = alice.getByRole("dialog")
    await expect(panel).toBeVisible({ timeout: 5_000 })
    const searchInput = panel.getByRole("combobox", { name: /Search/i }).first()
    await expect(searchInput).toBeVisible({ timeout: 5_000 })
    await alice.keyboard.press("Escape")
    await expect(panel).not.toBeVisible({ timeout: 5_000 })
  })

  await test.step("content side toggle changes aria-selected", async () => {
    await alice.keyboard.press("ControlOrMeta+k")
    const panel = alice.getByRole("dialog")
    await expect(panel).toBeVisible({ timeout: 5_000 })

    const projectTab = panel.getByRole("tab", { name: /^Project$/i })
    await expect(projectTab).toBeVisible({ timeout: 3_000 })
    await expect(projectTab).toHaveAttribute("aria-selected", "true")

    // Prior steps may leave a non-Both content side selected — normalize first.
    const bothTab = panel.getByRole("tab", { name: /^Both$/i })
    await bothTab.click()
    await expect(bothTab).toHaveAttribute("aria-selected", "true", { timeout: 3_000 })

    const sourceTab = panel.getByRole("tab", { name: /^Source$/i })
    await expect(sourceTab).toBeVisible({ timeout: 3_000 })
    await sourceTab.click()
    await expect(sourceTab).toHaveAttribute("aria-selected", "true", { timeout: 2_000 })
    await expect(bothTab).toHaveAttribute("aria-selected", "false")

    await bothTab.click()
    await expect(bothTab).toHaveAttribute("aria-selected", "true", { timeout: 2_000 })
    await alice.keyboard.press("Escape")
  })

  await test.step("Passages mode toggle changes active mode", async () => {
    await openDockSearch(alice)
    await alice.getByRole("button", { name: "Open full search panel" }).click()

    const panel = alice.getByRole("dialog")
    await expect(panel).toBeVisible({ timeout: 5_000 })

    const searchTab = panel.getByRole("tab", { name: /^Search$/i })
    await expect(searchTab).toBeVisible({ timeout: 3_000 })
    await expect(searchTab).toHaveAttribute("aria-selected", "true")

    const passagesTab = panel.getByRole("tab", { name: /^Passages$/i })
    await expect(passagesTab).toBeVisible({ timeout: 3_000 })
    await expect(passagesTab).toHaveAttribute("aria-selected", "false")
    await passagesTab.click()
    await expect(passagesTab).toHaveAttribute("aria-selected", "true", { timeout: 2_000 })
    await expect(searchTab).toHaveAttribute("aria-selected", "false")
    await alice.keyboard.press("Escape")
  })

  await test.step("Ctrl+Shift+F opens with project scope selected", async () => {
    await alice.keyboard.press("Control+Shift+f")
    const panel = alice.getByRole("dialog")
    await expect(panel).toBeVisible({ timeout: 8_000 })
    const searchInput = panel.getByRole("combobox", { name: /Search project/i })
    await expect(searchInput).toBeVisible({ timeout: 8_000 })

    const projectTab = panel.getByRole("tab", { name: /^Project$/i })
    await expect(projectTab).toHaveAttribute("aria-selected", "true", { timeout: 3_000 })

    await alice.keyboard.press("Escape")
    await expect(panel).not.toBeVisible({ timeout: 3_000 })
  })
})
