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
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
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
  const writeText = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal("navigator", { clipboard: { writeText } })
  const view = render(<AdminAuthenticator jwt="account-one" />)
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Verify and set up authenticator",
    }),
  )
  expect(
    screen.queryByRole("button", { name: "Verify and set up authenticator" }),
  ).toBeNull()
  expect(adminTotp).not.toHaveBeenCalledWith("account-one", "setup", {})
  fireEvent.click(
    screen.getByRole("button", { name: "Complete fresh verification" }),
  )
  await screen.findByText("private-seed")
  fireEvent.click(screen.getByRole("button", { name: "Copy setup key" }))
  await screen.findByText("Copied")
  expect(writeText).toHaveBeenLastCalledWith("private-seed")
  fireEvent.change(screen.getByLabelText("Authenticator code"), {
    target: { value: "123456" },
  })
  fireEvent.click(screen.getByRole("button", { name: "Confirm authenticator" }))
  await screen.findByText("private-recovery")
  fireEvent.click(screen.getByRole("button", { name: "Copy recovery codes" }))
  await screen.findByText("Copied")
  expect(writeText).toHaveBeenLastCalledWith("private-recovery")
  expect(screen.queryByText("private-seed")).toBeNull()
  expect(screen.getByRole("button", { name: "Enable authenticator app" })).toBeDisabled()
  fireEvent.click(screen.getByLabelText("I have saved my recovery codes"))
  expect(screen.getByRole("button", { name: "Enable authenticator app" })).not.toBeDisabled()
  expect(adminTotp).not.toHaveBeenCalledWith(
    "account-one",
    "complete",
    expect.anything(),
  )
  view.rerender(<AdminAuthenticator jwt="account-two" />)
  await waitFor(() => expect(screen.queryByText("private-recovery")).toBeNull())
  expect(screen.queryByText("private-seed")).toBeNull()
})

it("keeps removal behind a warning and clears the code when cancelled", async () => {
  vi.mocked(adminTotp).mockResolvedValue({ enabled: true, configured: true } as never)
  render(<AdminAuthenticator jwt="account-one" />)
  fireEvent.click(await screen.findByRole("button", { name: "Turn off authenticator app" }))
  expect(screen.getByRole("alert")).toHaveTextContent("Make sure you can receive email")
  expect(screen.getByRole("button", { name: "Turn off and use email codes" })).toBeDisabled()
  expect(screen.getByLabelText("Authenticator code")).toHaveAttribute("maxlength", "6")
  fireEvent.change(screen.getByLabelText("Authenticator code"), { target: { value: "12345" } })
  expect(screen.getByRole("button", { name: "Turn off and use email codes" })).toBeDisabled()
  fireEvent.change(screen.getByLabelText("Authenticator code"), { target: { value: "123456" } })
  expect(screen.getByRole("button", { name: "Turn off and use email codes" })).not.toBeDisabled()
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
  expect(screen.queryByLabelText("Authenticator code")).toBeNull()
  expect(adminTotp).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole("button", { name: "Turn off authenticator app" }))
  expect(screen.getByLabelText("Authenticator code")).toHaveValue("")
})
it("requires explicit confirmation and keeps protection on when verification fails", async () => {
  vi.mocked(adminTotp).mockImplementation(async (_jwt, path) => {
    if (!path) return { enabled: true, configured: true } as never
    throw new Error("invalid code")
  })
  render(<AdminAuthenticator jwt="account-one" />)
  fireEvent.click(await screen.findByRole("button", { name: "Turn off authenticator app" }))
  fireEvent.click(screen.getByRole("button", { name: "Use a recovery code" }))
  fireEvent.change(screen.getByLabelText("Recovery code"), { target: { value: "recovery-example" } })
  expect(adminTotp).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole("button", { name: "Turn off and use email codes" }))
  await screen.findByText(/Verification failed or expired/)
  expect(adminTotp).toHaveBeenLastCalledWith("account-one", "verify", {
    code: "recovery-example", recovery: true, disable: true,
  })
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
  expect(screen.getByText("Authenticator app is on")).toBeVisible()
})
