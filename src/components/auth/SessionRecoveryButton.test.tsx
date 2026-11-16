// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/react"
import { MemoryRouter, useLocation } from "react-router-dom"
import type { ComponentProps } from "react"
import type { FrontierLoginForm } from "@/components/git-import/FrontierLoginForm"
import type { FrontierForgotPasswordForm } from "@/components/git-import/FrontierForgotPasswordForm"
import { expect, it, vi } from "vitest"
import { SessionRecoveryButton } from "./SessionRecoveryButton"
vi.mock("@/components/git-import/FrontierLoginForm", () => ({
  FrontierLoginForm: ({ onSuccess, onForgotPassword, initialUsername, returnTo, navigateOnSuccess }: ComponentProps<typeof FrontierLoginForm>) => <>
    <p>{initialUsername}</p><p>{returnTo}</p><p>{String(navigateOnSuccess)}</p>
    <button onClick={() => void onSuccess({ username: "alice", jwt: "new-token", createdAt: "test" })}>Complete login</button><button onClick={onForgotPassword}>Forgot</button>
  </>,
}))
vi.mock("@/components/git-import/FrontierForgotPasswordForm", () => ({
  FrontierForgotPasswordForm: ({ onBack }: ComponentProps<typeof FrontierForgotPasswordForm>) => <button onClick={() => onBack?.()}>Return to login</button>,
}))
function Location() { const location = useLocation(); return <output>{location.pathname}</output> }
it("opens recovery in place with the saved username, preserves return URL and closes after login", async () => {
  render(<MemoryRouter initialEntries={["/preferences/login-methods?test=1"]}><Location /><SessionRecoveryButton username="alice" /></MemoryRouter>)
  fireEvent.click(screen.getByRole("button", { name: /log in again/i }))
  expect(await screen.findByRole("dialog")).toBeVisible()
  expect(screen.getByText("alice")).toBeVisible()
  expect(screen.getByText("/preferences/login-methods?test=1")).toBeVisible()
  expect(screen.getByText("false")).toBeVisible()
  expect(screen.getByRole("status", { hidden: true })).toHaveTextContent("/preferences/login-methods")
  fireEvent.click(screen.getByRole("button", { name: "Forgot" }))
  fireEvent.click(screen.getByRole("button", { name: "Return to login" }))
  fireEvent.click(screen.getByRole("button", { name: "Complete login" }))
  expect(screen.queryByRole("dialog")).toBeNull()
  expect(screen.getByRole("status", { hidden: true })).toHaveTextContent("/preferences/login-methods")
})
