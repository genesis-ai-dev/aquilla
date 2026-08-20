import { expect, type Page } from "@playwright/test"

/** User-intent actions for the authenticated account switcher. */
export class AccountSwitcherPage {
  private readonly page: Page

  constructor(page: Page) {
    this.page = page
  }

  /** Open the account menu from the settled application sidebar. */
  async openMenu(username?: string): Promise<void> {
    const sidebarTrigger = this.page.locator('[data-account-switcher-surface="sidebar"]')
    const trigger = username
      ? sidebarTrigger.and(this.page.getByRole("button", { name: `Account menu: ${username}` }))
      : sidebarTrigger
    // Cold org hydration may first render OrgRouteGate's temporary header
    // switcher. The sidebar marker is the responsible readiness signal.
    await expect(trigger).toBeVisible({ timeout: 30_000 })
    await trigger.click()
    await expect(this.page.getByRole("menu")).toBeVisible({ timeout: 10_000 })
  }

  /** Log out the active account after verifying another session can take over. */
  async logOutCurrentAccount(activeUsername: string, nextUsername: string): Promise<void> {
    await this.openMenu(activeUsername)
    await expect(
      this.page.getByRole("menuitem", { name: new RegExp(nextUsername, "i") }),
    ).toBeVisible({ timeout: 10_000 })
    await this.page.getByRole("menuitem", { name: /^Log out$/i }).click()
  }

  /**
   * Open the add-account dialog from the settled application sidebar.
   *
   * OrgRouteGate deliberately exposes a temporary header switcher while it
   * resolves access. Waiting for the sidebar surface prevents that gate from
   * being replaced underneath the menu interaction.
   */
  async openAddAccountDialog(): Promise<void> {
    await this.openMenu()

    const addAccount = this.page.getByRole("menuitem", { name: /Add another account/i })
    await expect(addAccount).toBeVisible({ timeout: 10_000 })
    await addAccount.click()

    await expect(
      this.page.getByRole("heading", { name: /Add Frontier account/i }),
    ).toBeVisible({ timeout: 10_000 })
  }
}
