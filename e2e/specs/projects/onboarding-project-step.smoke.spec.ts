import { test, expect } from "../../helpers/multi-user"
import { advanceOnboardingTo } from "../../helpers/onboarding"

/**
 * Onboarding wizard — ProjectStep (step 5) fields: proj-title, src-lang, tgt-lang.
 *
 * OnboardingWizard.tsx steps (alice is already signed in so steps 2+3 skip):
 *   1. WelcomeStep     → "Get started"
 *   4. NameStep        → id="display-name"
 *   5. ProjectStep     → id="proj-title", id="src-lang", id="tgt-lang"
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
  await alice.goto("/")
  await alice.evaluate(() => localStorage.removeItem("codex:onboardingComplete"))
  await alice.goto("/onboarding")
  await advanceOnboardingTo(alice, 7)

  const projName = alice.locator("#proj-title")
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
