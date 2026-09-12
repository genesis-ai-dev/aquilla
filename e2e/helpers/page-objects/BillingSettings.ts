import { billingSelectionPath } from '../../../src/lib/billing/intent'
import type { BillingPlanSelection } from '../../../db/shared/billing-review'
import { expect, type Page } from '@playwright/test'

export class BillingSettingsPage {
  private readonly page: Page

  constructor(page: Page) {
    this.page = page
  }

  async reviewSelectedPlan(selection: BillingPlanSelection, workspaceName: string) {
    await this.page.goto(billingSelectionPath(selection))
    await expect(this.page.getByRole('heading', { name: 'Choose a workspace for this plan' })).toBeVisible()
    await expect(this.page.getByRole('region', { name: 'Review selected plan' })).toHaveCount(0)
    await this.page.getByRole('button', { name: `Review for ${workspaceName}`, exact: true }).click()
  }

  async expectIncompatibleWorkspace() {
    await expect(this.page.getByRole('region', { name: 'Review selected plan' }))
      .toContainText('This plan does not match the workspace type')
    await expect(this.page.getByRole('button', { name: 'Checkout coming soon' })).toHaveCount(0)
  }

  async openWorkspace(orgId: number) {
    await this.page.goto(`/orgs/${orgId}/settings/billing`)
    await expect(this.page.getByRole('heading', { name: 'Billing & usage', exact: true })).toBeVisible()
    await expect(this.page.getByTestId('billing-workspace')).toBeVisible()
  }

  async expectRecordedPlan(label: string) {
    await expect(this.page.getByTestId('billing-plan')).toHaveText(label)
    await expect(this.page.getByText('Billed annually.')).toBeVisible()
    await expect(this.page.getByText('Your workspace’s plan, billing, and AI usage.')).toBeVisible()
    await expect(this.page.getByTestId('billing-usage')).toContainText('every seven days from your plan’s activation')
    await expect(this.page.getByTestId('billing-usage')).not.toContainText('rolling seven-day')
    await expect(this.page.getByTestId('manage-billing')).toHaveCount(0)
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
