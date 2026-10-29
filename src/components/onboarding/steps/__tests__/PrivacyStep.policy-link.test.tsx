import { describe, it, expect, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import { PrivacyStep } from "../PrivacyStep"

// AQU-2243: the footer link pointed at /privacy-policy, an in-app route holding
// a second, stale copy of the policy — and once that route was dropped from the
// deploy the address answered "404: Not Found". The live policy is /privacy
// (served by the aquilla-marketing Worker). Guard the target, not the copy.
describe("PrivacyStep policy link", () => {
  afterEach(() => {
    cleanup()
  })

  it("points at the one live policy at /privacy", () => {
    render(<PrivacyStep onNext={() => {}} onBack={() => {}} />)
    const links = screen.getAllByRole("link")
    expect(links).toHaveLength(1)
    expect(links[0].getAttribute("href")).toBe("/privacy")
  })
})
