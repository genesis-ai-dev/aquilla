import { expect, type Page } from "@playwright/test"

type OnboardingTarget = 4 | 7 | 8

interface OnboardingValues {
  displayName?: string
  projectName?: string
  sourceLanguage?: string
  targetLanguage?: string
}

/**
 * Advance the signed-in onboarding wizard by its explicit progress state.
 * Every transition waits for aria-valuenow to change, so a slow render cannot
 * be mistaken for a missing/optional step or cause a double click.
 */
export async function advanceOnboardingTo(
  page: Page,
  target: OnboardingTarget,
  values: OnboardingValues = {},
): Promise<void> {
  const progress = page.getByRole("progressbar", { name: /Step \d+ of \d+/i })
  await expect(progress).toBeVisible({ timeout: 15_000 })

  for (let transition = 0; transition < 8; transition += 1) {
    const rawStep = await progress.getAttribute("aria-valuenow")
    const step = Number(rawStep)
    if (step === target) return
    if (!Number.isInteger(step) || step < 1 || step > 8 || step > target) {
      throw new Error(`Cannot advance onboarding from step ${rawStep ?? "unknown"} to step ${target}`)
    }

    switch (step) {
      case 1:
        await page.getByRole("button", { name: /^Get Started$/i }).click()
        break
      case 2:
      case 3:
        await page.getByRole("button", { name: /^Continue$/i }).click()
        break
      case 4: {
        const input = page.locator("#display-name")
        await expect(input).toBeVisible()
        await input.fill(values.displayName ?? "Alice Translator")
        await page.getByRole("button", { name: /^Continue$/i }).click()
        break
      }
      case 5:
        await page.getByRole("button", { name: /Just me/i }).click()
        break
      case 6:
        throw new Error("Personal onboarding unexpectedly entered the team organization step")
      case 7:
        await page.locator("#proj-name").fill(values.projectName ?? `E2E Onboarding ${Date.now()}`)
        await page.locator("#src-lang").fill(values.sourceLanguage ?? "English")
        await page.locator("#tgt-lang").fill(values.targetLanguage ?? "French")
        await page.getByRole("button", { name: /^Create Project$/i }).click()
        break
      default:
        throw new Error(`Unhandled onboarding step ${step}`)
    }

    await expect.poll(
      () => progress.getAttribute("aria-valuenow"),
      { message: `onboarding step ${step} should advance`, timeout: 20_000 },
    ).not.toBe(String(step))
  }

  throw new Error(`Onboarding did not reach step ${target} within 8 transitions`)
}
