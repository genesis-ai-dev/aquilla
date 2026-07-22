import { test, expect } from "../../helpers/multi-user"

/**
 * Onboarding wizard — PrivacyStep "Continue" advances to step 3.
 *
 * OnboardingWizard.tsx multi-step flow:
 *   Step 1: WelcomeStep — "Get started"
 *   Step 2: PrivacyStep — "Continue" button
 *   Step 3: next step
 *
 * This spec: navigate to /onboarding → click "Get started" (step 1) →
 * verify PrivacyStep renders → click "Continue" → verify step 3 renders.
 */
test("onboarding wizard PrivacyStep Continue advances to step 3", async ({ alice }) => {
  await alice.goto("/onboarding")
  // Step 1: WelcomeStep — click "Get started".
  const getStartedBtn = alice.getByRole("button", { name: /Get started/i })
  await expect(getStartedBtn).toBeVisible({ timeout: 10_000 })
  await getStartedBtn.click()

  // Step 2: PrivacyStep — verify we're here.
  const step2 = alice.locator('[aria-label^="Step 2"]')
  await expect(step2).toBeVisible({ timeout: 5_000 })

  // Click "Continue" on PrivacyStep.
  const continueBtn = alice.getByRole("button", { name: /^Continue$/i })
  await expect(continueBtn).toBeVisible({ timeout: 3_000 })
  await continueBtn.click()

  // Step 3 indicator is now visible.
  const step3 = alice.locator('[aria-label^="Step 3"]')
  await expect(step3).toBeVisible({ timeout: 5_000 })
})
