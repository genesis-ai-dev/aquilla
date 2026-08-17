import { test, expect } from "../../helpers/multi-user"
import { advanceOnboardingTo } from "../../helpers/onboarding"

/**
 * Surface session: onboarding wizard steps as one sequential walkthrough.
 * One `{ alice }` → one resetBackend(); localStorage is cleared once up front.
 */

test("onboarding wizard welcome through ready surface session", async ({ alice }) => {
  test.setTimeout(120_000)

  await alice.goto("/")
  await alice.evaluate(() => localStorage.removeItem("codex:onboardingComplete"))
  await alice.goto("/onboarding")

  await test.step("welcome Get started advances to step 2", async () => {
    const h1 = alice.locator("h1").first()
    await expect(h1).toBeVisible({ timeout: 10_000 })

    const progressBar = alice.locator('[aria-label^="Step 1"]')
    await expect(progressBar).toBeVisible({ timeout: 5_000 })

    const getStartedBtn = alice.getByRole("button", { name: /Get started/i })
    await expect(getStartedBtn).toBeVisible({ timeout: 5_000 })
    await getStartedBtn.click()

    await expect(alice.locator('[aria-label^="Step 2"]')).toBeVisible({ timeout: 5_000 })
  })

  await test.step("PrivacyStep Continue advances to step 3", async () => {
    const continueBtn = alice.getByRole("button", { name: /^Continue$/i })
    await expect(continueBtn).toBeVisible({ timeout: 3_000 })
    await continueBtn.click()
    await expect(alice.locator('[aria-label^="Step 3"]')).toBeVisible({ timeout: 5_000 })
  })

  await test.step("NameStep accepts display name and enables Continue", async () => {
    // Step 3 → 4 (name).
    await alice.getByRole("button", { name: /^Continue$/i }).click()
    await expect(alice.locator('[aria-label^="Step 4"]')).toBeVisible({ timeout: 5_000 })

    const nameInput = alice.locator("#display-name")
    await expect(nameInput).toBeVisible({ timeout: 10_000 })
    await nameInput.fill("Alice Translator")
    await expect(nameInput).toHaveValue("Alice Translator")

    const continueBtn = alice.getByRole("button", { name: /Continue/i }).first()
    await expect(continueBtn).toBeVisible({ timeout: 3_000 })
    await expect(continueBtn).toBeEnabled({ timeout: 2_000 })
  })

  await test.step("ProjectStep inputs enable Create Project", async () => {
    await advanceOnboardingTo(alice, 7, { displayName: "Alice Translator" })

    const projName = alice.locator("#proj-title")
    await expect(projName).toBeVisible({ timeout: 10_000 })
    await expect(alice.locator("#src-lang")).toBeVisible({ timeout: 3_000 })
    await expect(alice.locator("#tgt-lang")).toBeVisible({ timeout: 3_000 })

    await projName.fill("My First Translation")
    await alice.locator("#src-lang").fill("English")
    await alice.locator("#tgt-lang").fill("French")

    const createBtn = alice.getByRole("button", { name: /Create Project/i }).first()
    await expect(createBtn).toBeVisible({ timeout: 3_000 })
    await expect(createBtn).toBeEnabled({ timeout: 2_000 })
  })

  await test.step("ReadyStep Start Translating navigates to the project", async () => {
    // ProjectStep fields were filled in the prior step — create and land on Ready.
    const createBtn = alice.getByRole("button", { name: /Create Project/i }).first()
    await expect(createBtn).toBeVisible({ timeout: 3_000 })
    await createBtn.click()

    const readyHeading = alice.getByText("You're all set!").first()
    await expect(readyHeading).toBeVisible({ timeout: 10_000 })

    const startBtn = alice.getByRole("button", { name: /Start Translating/i }).first()
    await expect(startBtn).toBeVisible({ timeout: 3_000 })
    await startBtn.click()

    await alice.waitForURL(/\/project\/[^/]+\/editor(?:\/file\/[^/]+)?(?:\?|$)/, {
      timeout: 10_000,
    })
    expect(alice.url()).toMatch(/\/project\/[^/]+\/editor(?:\/file\/[^/]+)?(?:\?|$)/)
  })
})
