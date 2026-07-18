import { test, expect } from "../../helpers/multi-user"

/**
 * Onboarding wizard — ReadyStep "Start Translating" navigates to the project.
 *
 * The full onboarding flow:
 *   Step 1: WelcomeStep → "Get started"
 *   Step 2: PrivacyStep → "Continue" (or skipped if consent already set)
 *   Step 3: SignInStep → "Already have an account" / "Sign in" (already signed in)
 *   Step 4: NameStep → fill display name → "Continue"
 *   Step 5: ProjectStep → fill project name + langs → "Create Project"
 *   Step 6: ReadyStep → "Start Translating" → navigate to /project/:id
 *
 * This spec drives through all steps to reach ReadyStep, then clicks
 * "Start Translating" and verifies the URL becomes /project/:id.
 *
 * Note: alice is already authenticated, so the SignInStep auto-advances or
 * shows a bypass option.
 */
test("ReadyStep 'Start Translating' navigates to the created project", async ({ alice }) => {
  await alice.goto("/")
  await alice.evaluate(() => localStorage.removeItem("codex:onboardingComplete"))
  await alice.goto("/onboarding")
  await alice.waitForLoadState("networkidle")

  // Advance through wizard steps until we reach ReadyStep.
  // We drive generically — click Continue/Next/Get started/Skip until
  // we encounter the project fields (step 5) or the ReadyStep (step 6).
  for (let i = 0; i < 10; i++) {
    const url = alice.url()

    // If we're already on a project page, we went past ReadyStep.
    if (/\/project\//.test(url)) break

    // Step 5: ProjectStep has #proj-name input.
    const projName = alice.locator("#proj-name")
    if (await projName.isVisible({ timeout: 800 }).catch(() => false)) {
      await projName.fill("E2E Onboarding Project")
      const srcLang = alice.locator("#src-lang")
      await srcLang.fill("English")
      const tgtLang = alice.locator("#tgt-lang")
      await tgtLang.fill("French")
      const createBtn = alice.getByRole("button", { name: /Create Project/i }).first()
      await createBtn.click()
      // Wait for ReadyStep.
      await alice.waitForTimeout(1_500)
      break
    }

    // Step 4: NameStep has a display name input.
    const nameInput = alice.locator('input[id="display-name"], input[name="display-name"], input[placeholder*="name" i]').first()
    if (await nameInput.isVisible({ timeout: 800 }).catch(() => false)) {
      const currentVal = await nameInput.inputValue()
      if (!currentVal) await nameInput.fill("Alice Tester")
      const continueBtn = alice.getByRole("button", { name: /Continue|Next/i }).first()
      await continueBtn.click()
      await alice.waitForTimeout(500)
      continue
    }

    // Other steps: click the primary forward button.
    const fwdBtn = alice.getByRole("button", {
      name: /Get started|Continue|Next|Skip|Already have|Sign in|Just me/i,
    }).first()
    if (await fwdBtn.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await fwdBtn.click()
      await alice.waitForTimeout(500)
    } else {
      break
    }
  }

  // We should now be on ReadyStep — "You're all set!" heading.
  const readyHeading = alice.getByText("You're all set!").first()
  await expect(readyHeading).toBeVisible({ timeout: 10_000 })

  // Click "Start Translating".
  const startBtn = alice.getByRole("button", { name: /Start Translating/i }).first()
  await expect(startBtn).toBeVisible({ timeout: 3_000 })
  await startBtn.click()

  // Should navigate to /project/:id.
  await alice.waitForURL(/\/project\/[^/]+$/, { timeout: 10_000 })
  expect(alice.url()).toMatch(/\/project\/[^/]+$/)
})
