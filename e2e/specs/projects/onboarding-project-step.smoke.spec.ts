import { test, expect } from "../../helpers/multi-user"

/**
 * Onboarding wizard — ProjectStep (step 5) fields: proj-name, src-lang, tgt-lang.
 *
 * OnboardingWizard.tsx steps (alice is already signed in so steps 2+3 skip):
 *   1. WelcomeStep     → "Get started"
 *   4. NameStep        → id="display-name"
 *   5. ProjectStep     → id="proj-name", id="src-lang", id="tgt-lang"
 *
 * ProjectStep only renders the form when a server session is present (alice
 * is always signed in). Submitting creates a project via the server, so
 * this spec only fills the fields and verifies the "Create Project" button
 * becomes enabled — it does NOT submit to avoid side effects.
 *
 * Navigation: click through WelcomeStep → NameStep (fill display-name) →
 * ProjectStep (verify inputs).
 */
test("onboarding ProjectStep inputs enable Create Project button", async ({ alice }) => {
  await alice.goto("/onboarding")
  await alice.waitForLoadState("networkidle")

  const MAX_CLICKS = 10
  for (let i = 0; i < MAX_CLICKS; i++) {
    // If ProjectStep inputs are visible, we're done navigating.
    const projName = alice.locator("#proj-name")
    if (await projName.isVisible({ timeout: 800 }).catch(() => false)) break

    // If NameStep is visible, fill it and continue.
    const nameInput = alice.locator("#display-name")
    if (await nameInput.isVisible({ timeout: 800 }).catch(() => false)) {
      const val = await nameInput.inputValue()
      if (!val) await nameInput.fill("Alice Translator")
      const continueBtn = alice.getByRole("button", { name: /Continue/i }).first()
      if (await continueBtn.isEnabled({ timeout: 1_000 }).catch(() => false)) {
        await continueBtn.click()
        await alice.waitForTimeout(400)
        continue
      }
    }

    // Generic forward button.
    const forwardBtn = alice.getByRole("button", {
      name: /Get started|Continue|Next|Skip|Already have|Sign in/i,
    }).first()
    if (await forwardBtn.isVisible({ timeout: 1_500 }).catch(() => false)) {
      await forwardBtn.click()
    } else {
      break
    }
    await alice.waitForTimeout(500)
  }

  const projName = alice.locator("#proj-name")
  await expect(projName).toBeVisible({ timeout: 10_000 })

  const srcLang = alice.locator("#src-lang")
  await expect(srcLang).toBeVisible({ timeout: 3_000 })

  const tgtLang = alice.locator("#tgt-lang")
  await expect(tgtLang).toBeVisible({ timeout: 3_000 })

  // Fill all fields.
  await projName.fill("My First Translation")
  await srcLang.fill("English")
  await tgtLang.fill("French")

  // "Create Project" button should become enabled.
  const createBtn = alice.getByRole("button", { name: /Create Project/i }).first()
  await expect(createBtn).toBeVisible({ timeout: 3_000 })
  await expect(createBtn).toBeEnabled({ timeout: 2_000 })
})
