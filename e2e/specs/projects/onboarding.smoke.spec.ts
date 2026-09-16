import { test, expect } from "@playwright/test"
import { resetBackend } from "../../helpers/seed"
import { advanceOnboardingTo } from "../../helpers/onboarding"

/**
 * Surface session: onboarding wizard steps as one sequential walkthrough.
 *
 * The wizard classifies every sign-in through GET /orgs at the sign-in step
 * (OnboardingWizard.handleLoginComplete), and the server lazily creates a
 * personal org for any org-less account on that same call — so every LOGIN
 * (and any already-signed-in Continue) takes the returning-user skip to the
 * workspace instead of walking the wizard. That skip fork is RTL-covered in
 * OnboardingWizard.skip.test.tsx. The only flow that still walks steps 4–8
 * is the brand-new SIGNUP path — the wizard's primary funnel — so this
 * journey registers a fresh account through the real /auth/register route
 * (backed by the mock legacy-migration server in the e2e stack) and carries
 * it through name → project creation → ready.
 */

test("onboarding wizard welcome through ready surface session", async ({ page }) => {
  test.setTimeout(120_000)
  await resetBackend()

  await page.goto("/onboarding")

  await test.step("welcome Get started advances to step 2", async () => {
    const h1 = page.locator("h1").first()
    await expect(h1).toBeVisible({ timeout: 10_000 })

    const progressBar = page.locator('[aria-label^="Step 1"]')
    await expect(progressBar).toBeVisible({ timeout: 5_000 })

    const getStartedBtn = page.getByRole("button", { name: /Get started/i })
    await expect(getStartedBtn).toBeVisible({ timeout: 5_000 })
    await getStartedBtn.click()

    await expect(page.locator('[aria-label^="Step 2"]')).toBeVisible({ timeout: 5_000 })
  })

  await test.step("PrivacyStep Continue advances to step 3", async () => {
    const continueBtn = page.getByRole("button", { name: /^Continue$/i })
    await expect(continueBtn).toBeVisible({ timeout: 3_000 })
    await continueBtn.click()
    await expect(page.locator('[aria-label^="Step 3"]')).toBeVisible({ timeout: 5_000 })
  })

  await test.step("SignInStep signup registers a fresh account and advances to step 4", async () => {
    const ts = Date.now()
    await page.locator("#s-user").fill(`wizard${ts}`)
    await page.locator("#s-email").fill(`wizard${ts}@example.test`)
    await page.locator("#s-pass").fill("wizard-pw-12345")
    await page.getByRole("button", { name: /Create account/i }).click()
    // Registration is a live auth-worker round trip (register + session mint).
    await expect(page.locator('[aria-label^="Step 4"]')).toBeVisible({ timeout: 15_000 })
  })

  await test.step("NameStep accepts display name and enables Continue", async () => {
    const nameInput = page.locator("#display-name")
    await expect(nameInput).toBeVisible({ timeout: 10_000 })
    await nameInput.fill("Wizard Translator")
    await expect(nameInput).toHaveValue("Wizard Translator")

    const continueBtn = page.getByRole("button", { name: /Continue/i }).first()
    await expect(continueBtn).toBeVisible({ timeout: 3_000 })
    await expect(continueBtn).toBeEnabled({ timeout: 2_000 })
  })

  await test.step("ProjectStep inputs enable Create Project", async () => {
    await advanceOnboardingTo(page, 7, { displayName: "Wizard Translator" })

    const projName = page.locator("#proj-title")
    await expect(projName).toBeVisible({ timeout: 10_000 })
    await expect(page.locator("#src-lang")).toBeVisible({ timeout: 3_000 })
    await expect(page.locator("#tgt-lang")).toBeVisible({ timeout: 3_000 })

    await projName.fill("My First Translation")
    await page.locator("#src-lang").fill("English")
    await page.locator("#tgt-lang").fill("French")

    const createBtn = page.getByRole("button", { name: /Create Project/i }).first()
    await expect(createBtn).toBeVisible({ timeout: 3_000 })
    await expect(createBtn).toBeEnabled({ timeout: 2_000 })
  })

  await test.step("ReadyStep Start Translating navigates to the project", async () => {
    // ProjectStep fields were filled in the prior step — create and land on Ready.
    const createBtn = page.getByRole("button", { name: /Create Project/i }).first()
    await expect(createBtn).toBeVisible({ timeout: 3_000 })
    await createBtn.click()

    const readyHeading = page.getByText("You're all set!").first()
    await expect(readyHeading).toBeVisible({ timeout: 10_000 })

    const startBtn = page.getByRole("button", { name: /Start Translating/i }).first()
    await expect(startBtn).toBeVisible({ timeout: 3_000 })
    await startBtn.click()

    await page.waitForURL(/\/project\/[^/]+\/editor(?:\/file\/[^/]+)?(?:\?|$)/, {
      timeout: 10_000,
    })
    expect(page.url()).toMatch(/\/project\/[^/]+\/editor(?:\/file\/[^/]+)?(?:\?|$)/)
  })
})
