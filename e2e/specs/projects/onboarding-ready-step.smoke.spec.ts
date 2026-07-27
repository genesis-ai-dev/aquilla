import { test, expect } from "../../helpers/multi-user"
import { advanceOnboardingTo } from "../../helpers/onboarding"

/**
 * Onboarding wizard — ReadyStep "Start Translating" navigates to the project.
 *
 * The full onboarding flow:
 *   Step 1: WelcomeStep → "Get started"
 *   Step 2: PrivacyStep → "Continue" (or skipped if consent already set)
 *   Step 3: SignInStep → "Already have an account" / "Sign in" (already signed in)
 *   Step 4: NameStep → fill display name → "Continue"
 *   Step 5: ProjectStep → fill project name + langs → "Create Project"
 *   Step 6: ReadyStep → "Start Translating" → navigate to /project/:id/editor
 *
 * This spec drives through all steps to reach ReadyStep, then clicks
 * "Start Translating" and verifies the URL becomes /project/:id/editor
 *
 * Note: alice is already authenticated, so the SignInStep auto-advances or
 * shows a bypass option.
 */
test("ReadyStep 'Start Translating' navigates to the created project", async ({ alice }) => {
  await alice.goto("/")
  await alice.evaluate(() => localStorage.removeItem("codex:onboardingComplete"))
  await alice.goto("/onboarding")
  await advanceOnboardingTo(alice, 8, {
    displayName: "Alice Tester",
    projectName: "E2E Onboarding Project",
  })

  // We should now be on ReadyStep — "You're all set!" heading.
  const readyHeading = alice.getByText("You're all set!").first()
  await expect(readyHeading).toBeVisible({ timeout: 10_000 })

  // Click "Start Translating".
  const startBtn = alice.getByRole("button", { name: /Start Translating/i }).first()
  await expect(startBtn).toBeVisible({ timeout: 3_000 })
  await startBtn.click()

  // Should navigate to /project/:id/editor
  await alice.waitForURL(/\/project\/[^/]+\/editor(?:\/file\/[^/]+)?(?:\?|$)/, { timeout: 10_000 })
  expect(alice.url()).toMatch(/\/project\/[^/]+\/editor(?:\/file\/[^/]+)?(?:\?|$)/)
})
