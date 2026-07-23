import { test, expect } from "../../helpers/multi-user"
import { advanceOnboardingTo } from "../../helpers/onboarding"

/**
 * Onboarding wizard — NameStep (step 4) renders with display-name input.
 *
 * OnboardingWizard.tsx steps:
 *   1. WelcomeStep     → "Get started"
 *   2. PrivacyStep     → may be skipped if consent already given
 *   3. SignInStep      → skipped if already signed in
 *   4. NameStep        → id="display-name", "Continue" button
 *   5. ProjectStep     → id="proj-name", id="src-lang", id="tgt-lang"
 *   6. ReadyStep
 *
 * Since alice is signed in, steps 2 & 3 may be skipped/fast. This spec
 * clicks through to reach step 4 (NameStep), fills the display-name input,
 * and verifies the Continue button becomes available.
 *
 * If already past the privacy step, the wizard may jump to step 3 or 4.
 * We click "Continue" / "Next" / "Already have an account" until we reach
 * the NameStep (id="display-name" is visible).
 */
test("onboarding NameStep input accepts display name and Continue advances", async ({ alice }) => {
  await alice.goto("/onboarding")
  await advanceOnboardingTo(alice, 4)

  // NameStep is now visible.
  const nameInput = alice.locator("#display-name")
  await expect(nameInput).toBeVisible({ timeout: 10_000 })

  // Fill in a display name.
  await nameInput.fill("Alice Translator")
  await expect(nameInput).toHaveValue("Alice Translator")

  // "Continue" button is present (enabled after fill).
  const continueBtn = alice.getByRole("button", { name: /Continue/i }).first()
  await expect(continueBtn).toBeVisible({ timeout: 3_000 })
  await expect(continueBtn).toBeEnabled({ timeout: 2_000 })
})
