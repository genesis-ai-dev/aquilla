import { type Page, type Locator, expect } from "@playwright/test"

/**
 * Page object for the project settings route ("/project/:id/settings").
 *
 * Settings is a two-level index → group → sections drill-down
 * (`ProjectSettings.tsx`'s `SETTINGS_GROUPS`, `?section=<groupId>`). The
 * Languages section (`LanguagesSection.tsx`, `id="section-languages"`,
 * AQU-538 slice 2) lives in the "General" group alongside Project info /
 * Bible resources / User.
 */
export class ProjectSettings {
  private readonly page: Page

  constructor(page: Page) {
    this.page = page
  }

  /**
   * Navigate from the open workspace ("/project/:id") into Settings →
   * General, where the Languages section renders. Mirrors the sidebar
   * "More project options" → "Settings" flow already exercised by
   * `workspace-settings-navigate.smoke.spec.ts`.
   */
  async openSettings(): Promise<void> {
    const moreBtn = this.page.getByRole("button", { name: /^More project options$/i })
    await expect(moreBtn).toBeVisible({ timeout: 10_000 })
    await moreBtn.click()

    const settingsItem = this.page.getByRole("button", { name: /^Settings$/i })
    await expect(settingsItem).toBeVisible({ timeout: 3_000 })
    await settingsItem.click()
    await this.page.waitForURL(/\/project\/[^/]+\/settings/, { timeout: 10_000 })

    // Lands on the settings index (no `?section=` yet) — drill into "General",
    // which holds the Languages section. If a deep-link already put us inside
    // a group (e.g. `?section=general`), the index/back-link isn't shown and
    // this is a no-op.
    const generalLink = this.page.getByRole("link", { name: /General/i })
    if (await generalLink.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await generalLink.click()
    }
    await expect(this.page.locator("#section-languages")).toBeVisible({ timeout: 10_000 })
  }

  private laneRow(tag: string): Locator {
    return this.page.getByTestId("target-lanes-list").locator("li").filter({ hasText: tag })
  }

  /** Add a target lane via the Languages section's add-lane form. */
  async addTargetLanguage(tag: string): Promise<void> {
    const input = this.page.getByTestId("add-target-lang-input")
    await expect(input).toBeVisible({ timeout: 10_000 })
    await input.fill(tag)
    await this.page.getByTestId("add-target-lang-btn").click()
    await expect(this.laneRow(tag)).toBeVisible({ timeout: 10_000 })
  }

  /** Remove a target lane (click the row's trash icon, then confirm). */
  async removeTargetLanguage(tag: string): Promise<void> {
    await this.page.getByTestId(`remove-lane-${tag}`).click()
    await this.page.getByRole("button", { name: /^Confirm remove$/i }).click()
    await expect(this.laneRow(tag)).not.toBeVisible({ timeout: 10_000 })
  }

  /** Navigate back to the project's workspace editor. */
  async backToEditor(): Promise<void> {
    await this.page.getByRole("button", { name: /Back to Editor/i }).click()
    await this.page.waitForURL(/\/project\/[^/]+(?:\/file\/[^/]+)?$/, { timeout: 10_000 })
  }
}
