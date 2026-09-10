import { expect, type Page } from '@playwright/test'

export class BillingSettingsPage {
  private readonly page: Page

  constructor(page: Page) {
    this.page = page
  }

  async openWorkspace(orgId: number) {
    await this.page.goto(`/orgs/${orgId}/settings/billing`)
    await expect(this.page.getByRole('heading', { name: 'Billing & usage', exact: true })).toBeVisible()
    await expect(this.page.getByTestId('billing-workspace')).toBeVisible()
  }

  async expectWorkspaceScope(scope: 'personal' | 'team' | 'unconfirmed') {
    const label = scope === 'personal' ? 'Personal workspace'
      : scope === 'team' ? 'Team workspace — shared billing'
      : 'Workspace type needs confirmation'
    await expect(this.page.getByTestId('billing-workspace')).toContainText(label)
    await expect(this.page.getByTestId('billing-workspace'))
      .toContainText('personal subscription does not add capacity here')
  }
}
