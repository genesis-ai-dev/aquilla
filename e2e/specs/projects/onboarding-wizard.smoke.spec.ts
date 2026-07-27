import { test, expect } from "../../helpers/multi-user"

/**
 * Onboarding wizard — welcome step renders and "Get started" navigates forward.
 *
 * OnboardingWizard.tsx renders multi-step at /onboarding:
 *   Step 1: WelcomeStep — h1 headline + "Get started" button
 *   Step 2: PrivacyStep
 *   Step 3: SignInStep
 *   ...
 *
 * This spec visits /onboarding, verifies the h1 renders, clicks
 * "Get started" and verifies the step indicator advances (step 2 of 5).
 *
 * NOTE: Alice is already authenticated so SignInStep will be skipped/fast.
 */
test("onboarding wizard welcome step renders and Get started advances to step 2", async ({ alice }) => {
  await alice.goto("/onboarding")
  // WelcomeStep h1 renders.
  const h1 = alice.locator("h1").first()
  await expect(h1).toBeVisible({ timeout: 10_000 })

  // Step indicator (aria-label "Step 1 of 5" or similar).
  const progressBar = alice.locator('[aria-label^="Step 1"]')
  await expect(progressBar).toBeVisible({ timeout: 5_000 })

  // "Get started" button.
  const getStartedBtn = alice.getByRole("button", { name: /Get started/i })
  await expect(getStartedBtn).toBeVisible({ timeout: 5_000 })
  await getStartedBtn.click()

  // Step 2 (PrivacyStep) renders — progress bar updates.
  const step2 = alice.locator('[aria-label^="Step 2"]')
  await expect(step2).toBeVisible({ timeout: 5_000 })
})
