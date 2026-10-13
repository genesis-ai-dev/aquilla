// AQU-525 — the JSON key picker is what the user configures the import with,
// so its selection semantics ARE the feature: ticking a key must decide
// exactly which values become translatable cells, and nothing else about the
// document. Everything left unticked is structure the exporter has to hand
// back untouched, so an over-broad selection here silently rewrites a key the
// user never meant to translate.
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import type { ReactNode } from "react"
import { JsonKeyPickerPanel } from "./JsonKeyPickerPanel"
import { listJsonStringPaths } from "@/lib/parsers/json-i18n"

vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

const SOURCE = JSON.stringify({
  app: { title: "My App", legal: "All rights reserved" },
  messages: ["Hello", "Goodbye"],
  version: 3,
  top: "Top level string",
})

function renderPicker(onConfirm = vi.fn()) {
  render(
    <JsonKeyPickerPanel
      fileName="en.json"
      leaves={listJsonStringPaths(SOURCE)}
      onConfirm={onConfirm}
      onCancel={vi.fn()}
    />,
  )
  return onConfirm
}

describe("JsonKeyPickerPanel", () => {
  const user = userEvent.setup()

  it("lists every string leaf grouped by its key, and no non-string value", () => {
    renderPicker()
    expect(screen.getByRole("checkbox", { name: "app" })).toBeInTheDocument()
    expect(screen.getByRole("checkbox", { name: "messages" })).toBeInTheDocument()
    expect(screen.getByRole("checkbox", { name: "app.title" })).toBeInTheDocument()
    expect(screen.getByRole("checkbox", { name: "messages[1]" })).toBeInTheDocument()
    // Root-level leaves group under a labelled group, not under a key path.
    expect(screen.getByRole("checkbox", { name: "Top level" })).toBeInTheDocument()
    // `version` is a number: not translatable, so never offered.
    expect(screen.queryByRole("checkbox", { name: "version" })).not.toBeInTheDocument()
    expect(screen.getByText("5 of 5 strings selected")).toBeInTheDocument()
  })

  it("starts with everything selected, so confirming imports the whole file", async () => {
    const onConfirm = renderPicker()
    await user.click(screen.getByRole("button", { name: "Import selected keys" }))
    expect(onConfirm).toHaveBeenCalledWith([
      "app.title",
      "app.legal",
      "messages[0]",
      "messages[1]",
      "top",
    ])
  })

  it("confirms only the ticked leaves when a single value is unticked", async () => {
    const onConfirm = renderPicker()
    await user.click(screen.getByRole("checkbox", { name: "app.legal" }))
    expect(screen.getByText("4 of 5 strings selected")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Import selected keys" }))
    expect(onConfirm).toHaveBeenCalledWith(["app.title", "messages[0]", "messages[1]", "top"])
  })

  it("a key's own checkbox toggles all of its values at once", async () => {
    const onConfirm = renderPicker()
    await user.click(screen.getByRole("checkbox", { name: "Select all keys" })) // clear
    expect(screen.getByText("0 of 5 strings selected")).toBeInTheDocument()
    await user.click(screen.getByRole("checkbox", { name: "messages" }))
    await user.click(screen.getByRole("button", { name: "Import selected keys" }))
    // Array entries included by their own paths — nested containers are
    // selectable exactly like object keys.
    expect(onConfirm).toHaveBeenCalledWith(["messages[0]", "messages[1]"])
  })

  it("cannot confirm an empty selection — an import with no cells is not an import", async () => {
    renderPicker()
    await user.click(screen.getByRole("checkbox", { name: "Select all keys" }))
    expect(screen.getByRole("button", { name: "Import selected keys" })).toBeDisabled()
  })

  it("shows a partially-selected key as indeterminate, not as selected", async () => {
    renderPicker()
    await user.click(screen.getByRole("checkbox", { name: "app.legal" }))
    const group = screen.getByRole("checkbox", { name: "app" })
    expect(group).toHaveAttribute("aria-checked", "mixed")
    expect(group).not.toBeChecked()
  })
})
