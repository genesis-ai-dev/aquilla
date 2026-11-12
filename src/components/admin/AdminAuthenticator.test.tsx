import { beforeEach, afterEach, expect, it, vi } from "vitest"
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react"
import { AdminAuthenticator } from "./AdminAuthenticator"
import { adminTotp } from "@/lib/frontier/admin"
vi.mock("@/lib/frontier/admin", () => ({ adminTotp: vi.fn() }))
vi.mock("qrcode", () => ({
  default: {
    toDataURL: vi.fn().mockResolvedValue("data:image/png;base64,test"),
  },
}))
vi.mock("./AdminElevationGate", () => ({
  AdminElevationGate: ({ onElevated }: { onElevated: () => void }) => (
    <button onClick={onElevated}>Complete fresh verification</button>
  ),
}))
beforeEach(() => vi.clearAllMocks())
afterEach(cleanup)
it("requires fresh verification, confirmation and saved-code acknowledgment; clears secrets on account switch", async () => {
  vi.mocked(adminTotp).mockImplementation(async (_jwt, path) => {
    if (!path) return { enabled: false, configured: true } as never
    if (path === "setup")
      return {
        generation: "generation",
        secret: "private-seed",
        uri: "otpauth://test",
      } as never
    if (path === "confirm")
      return { recoveryCodes: ["private-recovery"] } as never
    return {} as never
  })
  const view = render(<AdminAuthenticator jwt="account-one" />)
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Verify and set up authenticator",
    }),
  )
  expect(adminTotp).not.toHaveBeenCalledWith("account-one", "setup", {})
  fireEvent.click(
    screen.getByRole("button", { name: "Complete fresh verification" }),
  )
  await screen.findByText("private-seed")
  fireEvent.change(screen.getByLabelText("Authenticator code"), {
    target: { value: "123456" },
  })
  fireEvent.click(screen.getByRole("button", { name: "Confirm authenticator" }))
  await screen.findByText("private-recovery")
  expect(screen.queryByText("private-seed")).toBeNull()
  expect(screen.getByRole("button", { name: "Enable TOTP" })).toBeDisabled()
  fireEvent.click(screen.getByLabelText("I have saved my recovery codes"))
  expect(screen.getByRole("button", { name: "Enable TOTP" })).not.toBeDisabled()
  expect(adminTotp).not.toHaveBeenCalledWith(
    "account-one",
    "complete",
    expect.anything(),
  )
  view.rerender(<AdminAuthenticator jwt="account-two" />)
  await waitFor(() => expect(screen.queryByText("private-recovery")).toBeNull())
  expect(screen.queryByText("private-seed")).toBeNull()
})
