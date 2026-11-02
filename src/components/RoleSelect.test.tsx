import "@/test-utils/all-catalogs"
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, fireEvent, within } from "@testing-library/react"
import { RoleSelect } from "./RoleSelect"
import { LINK_ROLE_OPTIONS, PROJECT_ROLE_OPTIONS, roleDescription } from "@/lib/frontier/roles"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import { LOCALE_STORAGE_KEY } from "@/lib/i18n/store"

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Base UI Select: click does not commit under happy-dom — highlight + Enter. */
async function pickRoleOption(optionName: RegExp) {
  const option = await screen.findByRole("option", { name: optionName })
  fireEvent.pointerMove(option)
  fireEvent.mouseMove(option)
  fireEvent.keyDown(option, { key: "Enter" })
}

describe("RoleSelect", () => {
  it("lists each role with its capability description in the dropdown", async () => {
    const onValueChange = vi.fn()
    render(
      <RoleSelect
        options={LINK_ROLE_OPTIONS}
        value={400}
        onValueChange={onValueChange}
        aria-label="Role"
      />,
    )

    const trigger = screen.getByRole("combobox", { name: "Role" })
    expect(trigger).toHaveTextContent(/contributor/i)

    fireEvent.click(trigger)

    const listbox = await screen.findByRole("listbox")
    for (const opt of LINK_ROLE_OPTIONS) {
      // Match by description — "viewer" is a substring of "reviewer".
      const option = within(listbox).getByRole("option", {
        name: new RegExp(escapeRegExp(roleDescription(opt.level))),
      })
      expect(option).toHaveTextContent(new RegExp(opt.name, "i"))
    }

    await pickRoleOption(new RegExp(escapeRegExp(roleDescription(100))))
    expect(onValueChange).toHaveBeenCalledWith(100)
  })

  // AQU-2289: the closed picker showed "Project Lead", title-cased from the
  // role's machine name and English in every language. It now shows the
  // catalog's name, in sentence case and in the reader's language.
  describe("the chosen role's name", () => {
    afterEach(() => window.localStorage.clear())

    it("is the catalog's sentence-case name", () => {
      render(
        <RoleSelect options={PROJECT_ROLE_OPTIONS} value={500} onValueChange={() => {}} aria-label="Role" />,
      )
      expect(screen.getByRole("combobox", { name: "Role" })).toHaveTextContent(/^Project lead/)
    })

    it("is in the reader's language", () => {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, "fr")
      render(
        <I18nProvider>
          <RoleSelect options={PROJECT_ROLE_OPTIONS} value={500} onValueChange={() => {}} aria-label="Role" />
        </I18nProvider>,
      )
      expect(screen.getByRole("combobox", { name: "Role" })).toHaveTextContent(/^Chef de projet/)
    })
  })
})
