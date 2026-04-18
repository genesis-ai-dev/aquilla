import { describe, it, expect, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import { WelcomeStep } from "../WelcomeStep"
import { BrandContext } from "@/branding/use-brand"
import { BRANDS } from "@/branding/brands"
import type { BrandId } from "@/branding/types"

describe("WelcomeStep per brand", () => {
  afterEach(() => {
    cleanup()
  })

  for (const id of ["codex", "honeycomb", "context"] as BrandId[]) {
    it(`renders brand ${id}'s headline and subhead`, () => {
      const brand = BRANDS[id]
      render(
        <BrandContext.Provider value={brand}>
          <WelcomeStep onNext={() => {}} />
        </BrandContext.Provider>,
      )
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(brand.marketing.onboardingHeadline)
      expect(screen.getByText(brand.marketing.onboardingSubhead)).toBeTruthy()
    })
  }
})
