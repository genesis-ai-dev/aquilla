import type { ComponentProps } from "react"
import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import { INHERIT_DEFAULTS } from "@/lib/sync/inherited-settings"
import { InheritedSettingsChoice } from "./InheritedSettingsChoice"

function renderChoice(
  props: Partial<ComponentProps<typeof InheritedSettingsChoice>> = {},
) {
  const onChange = vi.fn()
  render(
    <I18nProvider>
      <InheritedSettingsChoice
        title="Copy these from the upstream project"
        description="Turn on what this project should receive."
        receive={{ ...INHERIT_DEFAULTS }}
        detached={{}}
        onChange={onChange}
        {...props}
      />
    </I18nProvider>,
  )
  return { onChange }
}

describe("InheritedSettingsChoice (AQU-1075)", () => {
  it("leaves AI instructions unticked by default", () => {
    renderChoice()
    expect(screen.getByRole("checkbox", { name: "Translation brief" })).toBeChecked()
    expect(screen.getByRole("checkbox", { name: "Knowledge-base documents" })).toBeChecked()
    expect(screen.getByRole("checkbox", { name: /^Workflow policy/ })).toBeChecked()
    expect(screen.getByRole("checkbox", { name: "Living-memory notes" })).not.toBeChecked()
    expect(screen.getByRole("checkbox", { name: "Smart quotes" })).not.toBeChecked()
    expect(screen.getByRole("checkbox", { name: "AI instructions" })).not.toBeChecked()
  })

  it("names the upstream and detaches the field", async () => {
    const user = userEvent.setup()
    const { onChange } = renderChoice({
      showFrom: true,
      upstreamName: "French NT",
    })
    expect(screen.getAllByText("from French NT").length).toBeGreaterThan(0)
    const detach = screen.getAllByRole("button", { name: "Detach" })
    await user.click(detach[0]!)
    expect(onChange).toHaveBeenCalledWith({
      receive: { ...INHERIT_DEFAULTS, translationBrief: false },
      detached: { translationBrief: true },
    })
  })
})
