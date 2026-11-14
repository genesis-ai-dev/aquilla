import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const state = vi.hoisted(() => ({
  session: { username: "tester", createdAt: "seed" } as
    | { username: string; createdAt: string }
    | null,
  loading: false,
  opfsAvailable: false,
}))

vi.mock("@/hooks/useOpfsAvailability", () => ({
  useOpfsAvailability: () => state.opfsAvailable,
}))
vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: state.session, loading: state.loading }),
}))

import { PrivateModeBanner } from "./PrivateModeBanner"

let keySeq = 0

beforeEach(() => {
  // The component remembers dismissals per (username, createdAt) in module
  // memory and sessionStorage, so every test needs its own identity.
  keySeq += 1
  state.session = { username: "tester", createdAt: `created-${keySeq}` }
  state.loading = false
  state.opfsAvailable = false
})

describe("PrivateModeBanner (AQU-2483)", () => {
  it("keeps the dismiss control out of the message's text flow so it stays at the bar's end edge", () => {
    const { container } = render(<PrivateModeBanner />)

    const bar = container.firstElementChild as HTMLElement
    const dismiss = screen.getByRole("button", { name: "Dismiss" })
    const message = screen.getByText(/Private browsing is restricting local storage/)

    // The control is the bar's own last child: nothing after it can displace it.
    expect(dismiss.parentElement).toBe(bar)
    expect(bar.lastElementChild).toBe(dismiss)
    // The message sits in its own track, so wrapping text cannot drag the
    // control inline after the last word.
    expect(message.parentElement).not.toBe(bar)
    expect(bar.contains(message)).toBe(true)
  })

  it("exposes the dismiss control to the keyboard and hides the banner when it is used", async () => {
    const user = userEvent.setup()
    render(<PrivateModeBanner />)

    const dismiss = screen.getByRole("button", { name: "Dismiss" })
    await user.tab()
    expect(document.activeElement).toBe(dismiss)

    await user.keyboard("{Enter}")
    expect(screen.queryByText(/Private browsing is restricting local storage/)).toBeNull()
  })
})
