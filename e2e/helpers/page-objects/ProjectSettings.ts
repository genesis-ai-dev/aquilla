import { type Page, type Locator, expect } from "@playwright/test"

/**
 * Page object for the project settings route ("/project/:id/settings").
 *
 * Settings is a two-level index → group → sections drill-down
 * (`ProjectSettings.tsx`'s `SETTINGS_GROUPS`, `/settings/<groupId>`). The
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
   * Navigate from the open workspace ("/project/:id/editor") into Settings →
   * General, where the Languages section renders. Mirrors the header Settings
   * cog flow already exercised by `workspace-settings-navigate.smoke.spec.ts`.
   */
  async openSettings(): Promise<void> {
    const settingsBtn = this.page.getByRole("button", { name: /^Settings$/i })
    await expect(settingsBtn).toBeVisible({ timeout: 10_000 })
    await settingsBtn.click()
    await this.page.waitForURL(/\/project\/[^/]+\/settings/, { timeout: 10_000 })

    // Lands on the settings index (index path — no section segment yet) — drill into "General",
    // which holds the Languages section. If a deep-link already put us inside
    // a group (e.g. `/settings/general`), the section is already there and the
    // index link never appears. NOTE: `isVisible()` reports the INSTANTANEOUS
    // state (its timeout option is ignored), so guard-then-click races the
    // index render — wait for whichever of the two states materializes first.
    const generalLink = this.page.getByRole("link", { name: /General/i })
    const section = this.page.locator("#section-languages")
    await expect(generalLink.or(section).first()).toBeVisible({ timeout: 10_000 })
    if (!(await section.isVisible().catch(() => false))) {
      await generalLink.click()
    }
    await expect(section).toBeVisible({ timeout: 10_000 })
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
    await this.page.getByRole("button", { name: /^Editor$/i }).click()
    await this.page.waitForURL(/\/project\/[^/]+\/editor(?:\/file\/[^/]+)?(?:\?|$)/, { timeout: 10_000 })
  }

  /** Project id from `/project/:id/...` or `/projects/:id`. */
  projectIdFromCurrentUrl(): string {
    const match = this.page.url().match(/\/project(?:s)?\/([^/?#]+)/)
    if (!match?.[1]) throw new Error(`No project id in ${this.page.url()}`)
    return match[1]
  }

  /** Open Settings → Members (`/project/:id/settings/members`). */
  async openMembers(projectId: string): Promise<void> {
    await this.page.goto(`/project/${projectId}/settings/members`)
    await expect(this.page.getByTestId("settings-members-section")).toBeVisible({ timeout: 10_000 })
    await expect(this.page.getByRole("button", { name: /^Add a member$/i })).toBeVisible({ timeout: 10_000 })
  }

  /** Open the Add a member dialog (members + invite-link tabs). */
  async openAddMemberDialog(projectId: string): Promise<Locator> {
    await this.openMembers(projectId)
    await this.page.getByRole("button", { name: /^Add a member$/i }).click()
    const dialog = this.page.getByRole("dialog", { name: /Add a member/i })
    await expect(dialog).toBeVisible({ timeout: 5_000 })
    return dialog
  }

  /** Open Add a member → Invite link (replacement for the old Share panel). */
  async openInviteLinkTab(projectId: string): Promise<Locator> {
    const dialog = await this.openAddMemberDialog(projectId)
    await dialog.getByRole("tab", { name: /^Invite link$/i }).click()
    return dialog
  }
}
