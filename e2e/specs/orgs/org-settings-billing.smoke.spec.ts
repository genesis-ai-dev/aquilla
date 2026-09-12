import { recordTestWorkspacePlan, recordTestWorkspaceFailure } from "../../helpers/billing"
import { BillingSettingsPage } from "../../helpers/page-objects/BillingSettings"
import { createOrg } from "../../helpers/frontier-api"
import { ensureAuthState } from "../../helpers/auth"
import { test, expect, orgRoute } from "../../helpers/multi-user"

/** Existing organization billing boundary: auth → API → billing UI. */
test("org billing settings preserves access while new pricing is unavailable", async ({ alice }) => {
  await alice.goto(orgRoute(alice, "/settings"))
  await expect(alice.locator("h1").filter({ hasText: /Organization settings/i })).toBeVisible()
  await alice.getByRole("link", { name: /Billing & usage/i }).click()
  await expect(alice).toHaveURL(orgRoute(alice, "/settings/billing"))
  await expect(alice.locator("h1").filter({ hasText: /Billing & usage/i })).toBeVisible()
  await expect(alice.getByTestId("billing-plan")).toBeVisible()
  await expect(alice.getByTestId("billing-usage")).toContainText("rolling seven-day")
  await expect(alice.getByRole("tab", { name: "Team & Enterprise" })).toBeVisible()
  await expect(alice.getByText(/Plan prices are temporarily unavailable/)).toBeVisible()
  await expect(alice.getByTestId("subscribe-field-plan")).toHaveCount(0)
  await expect(alice.getByRole("link", { name: "Check covered access" })).toHaveAttribute("href", /ETEN%20affiliate/)
  await expect(alice.getByTestId("billing-plan")).toHaveText("Free")
  await new BillingSettingsPage(alice).expectWorkspaceScope("unconfirmed")
})


test("new workspace scope survives billing navigation and reload", async ({ bob }) => {
  const billing = new BillingSettingsPage(bob)
  await billing.openWorkspace(bob.orgId)
  await billing.expectWorkspaceScope("personal")
  const session = await ensureAuthState("bob")
  const team = await createOrg(session.jwt, "Billing team")
  await billing.openWorkspace(team.id)
  await billing.expectWorkspaceScope("team")
  await bob.reload()
  await billing.expectWorkspaceScope("team")
  await billing.openWorkspace(bob.orgId)
  await billing.expectWorkspaceScope("personal")
  await billing.reviewSelectedPlan({ offer: "pro", interval: "year", quantity: 1 }, "Billing team")
  await billing.expectIncompatibleWorkspace()
})


test("recorded paid plan survives reload and stays with its workspace", async ({ bob }, testInfo) => {
  const session = await ensureAuthState("bob")
  const team = await createOrg(session.jwt, "Paid billing team")
  await recordTestWorkspacePlan(team.id)
  const billing = new BillingSettingsPage(bob)
  await billing.openWorkspace(team.id)
  await billing.expectRecordedPlan("Team 20×")
  await bob.reload()
  await billing.expectRecordedPlan("Team 20×")
  await bob.screenshot({ path: testInfo.outputPath("paid-workspace-billing.png"), fullPage: true })
  await billing.openWorkspace(bob.orgId)
  await billing.expectWorkspaceScope("personal")
  await expect(bob.getByTestId("billing-plan")).toHaveText("Free")
  await billing.openWorkspace(team.id)
  await billing.expectRecordedPlan("Team 20×")
  await recordTestWorkspaceFailure(team.id)
  await bob.reload()
  await billing.expectFreeAllowanceAfterFailure()
  await bob.screenshot({ path: testInfo.outputPath("failed-payment-billing.png"), fullPage: true })
})
