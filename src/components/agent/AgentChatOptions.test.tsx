import { beforeAll, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { AgentChatOptions } from "./AgentChatOptions"

beforeAll(() => {
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  })
})

async function openReset(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Chat options" }))
  await user.click(await screen.findByRole("menuitem", { name: "Reset chat…" }))
  return screen.findByRole("alertdialog", { name: "Reset chat?" })
}

describe("AgentChatOptions", () => {
  it("requires confirmation, focuses Cancel, and returns focus without resetting on cancellation", async () => {
    const user = userEvent.setup()
    const onReset = vi.fn()
    render(<AgentChatOptions onReset={onReset} />)
    const trigger = screen.getByRole("button", { name: "Chat options" })
    expect(screen.queryByRole("button", { name: "Reset chat" })).not.toBeInTheDocument()

    const dialog = await openReset(user)
    expect(dialog).toHaveAccessibleDescription(/Undo controls/)
    expect(dialog).toHaveAccessibleDescription(/applied translations are unchanged/)
    expect(onReset).not.toHaveBeenCalled()
    const cancel = within(dialog).getByRole("button", { name: "Cancel" })
    await waitFor(() => expect(cancel).toHaveFocus())
    await user.click(cancel)
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
    await waitFor(() => expect(trigger).toHaveFocus())
    expect(onReset).not.toHaveBeenCalled()
  })

  it("calls the existing reset only after explicit confirmation", async () => {
    const user = userEvent.setup()
    const onReset = vi.fn()
    render(<AgentChatOptions onReset={onReset} />)
    const dialog = await openReset(user)
    await user.click(within(dialog).getByRole("button", { name: "Reset chat" }))
    expect(onReset).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
  })

  it("treats Escape as cancellation", async () => {
    const user = userEvent.setup()
    const onReset = vi.fn()
    render(<AgentChatOptions onReset={onReset} />)
    await openReset(user)
    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
    expect(onReset).not.toHaveBeenCalled()
  })

  it("disables reset while a project apply or undo is in progress", async () => {
    const user = userEvent.setup()
    const onReset = vi.fn()
    const view = render(<AgentChatOptions onReset={onReset} disabled />)
    await user.click(screen.getByRole("button", { name: "Chat options" }))
    const item = await screen.findByRole("menuitem", { name: "Reset chat…" })
    expect(item).toHaveAttribute("aria-disabled", "true")
    fireEvent.click(item)
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
    expect(onReset).not.toHaveBeenCalled()

    await user.keyboard("{Escape}")
    view.rerender(<AgentChatOptions onReset={onReset} />)
    const dialog = await openReset(user)
    view.rerender(<AgentChatOptions onReset={onReset} disabled />)
    expect(within(dialog).getByRole("button", { name: "Reset chat" })).toBeDisabled()
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeEnabled()
  })
})
