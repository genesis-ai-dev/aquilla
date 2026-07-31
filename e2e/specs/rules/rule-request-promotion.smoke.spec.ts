import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { ensureAuthState } from "../../helpers/auth"
import { addOrgMember, getMyOrg, ROLE } from "../../helpers/frontier-api"

/**
 * RulesSurface — "Request promotion" button for project_lead users.
 *
 * When a user has org role >= PROJECT_LEAD (500) but NOT canEditOrgRules
 * (i.e. not org maintainer/owner), project rule rows show a
 * "Request promotion" button instead of "Promote to org".
 *
 * Clicking it calls requestPromotion() and on success the button is
 * replaced by a "Requested" chip with a Clock icon.
 *
 * This spec:
 *   1. Adds bob to alice's org as PROJECT_LEAD.
 *   2. Alice creates a project and adds bob as a project member.
 *   3. Bob navigates to the project's /rules page.
 *   4. Bob creates a rule (bob is added as contributor-level on project, but
 *      the important thing is he has PROJECT_LEAD on the org so the
 *      canRequestPromotion flag is true).
 *   5. Bob sees "Request promotion" and clicks it.
 *   6. The button becomes a "Requested" indicator.
 */
test("Request promotion button shows Requested state after click", async ({ alice, bob }) => {
  const aliceSession = await ensureAuthState("alice")
  const acme = await getMyOrg(aliceSession.jwt)

  // Add bob as PROJECT_LEAD in the org.
  await addOrgMember(aliceSession.jwt, acme.id, "bob", ROLE.PROJECT_LEAD)

  // Alice creates a project and adds bob as MAINTAINER so he can add rules.
  const aliceDash = new Dashboard(alice)
  await aliceDash.goto()
  const name = `ReqPromo ${Date.now()}`
  await aliceDash.createProject({ name })
  await aliceDash.openProject(name)

  const projectId = alice.url().match(/\/project\/([^/]+)/)?.[1]
  expect(projectId).toBeTruthy()

  // Add bob to the project as maintainer so he can manage rules.
  const { addProjectMember } = await import("../../helpers/frontier-api")
  await addProjectMember(aliceSession.jwt, projectId!, "bob", ROLE.MAINTAINER)

  // Bob navigates to the rules page.
  await bob.goto(`/project/${projectId}/rules`)
  // Bob creates a rule.
  const addRuleBtn = bob.getByRole("button", { name: /Add Rule|New rule|Add rule/i }).first()
  await expect(addRuleBtn).toBeVisible({ timeout: 10_000 })
  await addRuleBtn.click()

  const ruleName = `BobRule ${Date.now()}`
  const nameInput = bob.locator("#re-name")
  await expect(nameInput).toBeVisible({ timeout: 5_000 })
  await nameInput.fill(ruleName)

  // Pattern is required for a valid rule.
  const patInput = bob.locator("#re-pat")
  await expect(patInput).toBeVisible({ timeout: 3_000 })
  await patInput.fill("test-pattern")

  await bob.getByRole("button", { name: /^Create rule$/ }).click()
  await expect(bob.getByText(ruleName)).toBeVisible({ timeout: 8_000 })

  // Bob should see "Request promotion" (not "Promote to org") since he's PROJECT_LEAD, not maintainer.
  const ruleRow = bob.locator("li, tr, div").filter({ hasText: ruleName }).first()
  const requestBtn = ruleRow.getByRole("button", { name: /Request promotion/i })
    .or(bob.getByRole("button", { name: /Request promotion/i }).first())
  await expect(requestBtn.first()).toBeVisible({ timeout: 8_000 })
  await requestBtn.first().click()

  // After clicking, the button should be replaced with a "Requested" indicator.
  await expect(
    bob.getByText(/Requested/i).first()
  ).toBeVisible({ timeout: 8_000 })
})
