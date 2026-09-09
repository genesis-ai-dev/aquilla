import { beforeEach, describe, expect, it, vi } from "vitest"
import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { InworldDesignLocaleFields } from "./InworldDesignLocaleFields"
import { listInworldSupportedLanguages } from "@/lib/sync/tts"
import { __resetInworldSupportedLanguagesCacheForTests } from "@/lib/audio/inworld-voices"
import type { FrontierSession } from "@/lib/frontier/types"
import type { InworldSupportedLanguage } from "@/lib/audio/inworld-supported-languages"
import { expectTooltip, renderWithTooltips } from "@/test-utils/tooltip"

vi.mock("@/lib/sync/tts", () => ({
  listInworldVoices: vi.fn(),
  listInworldSupportedLanguages: vi.fn(),
  designInworldVoice: vi.fn(),
  publishInworldVoice: vi.fn(),
  synthesizeCellTts: vi.fn(),
}))

vi.mock("@/lib/audio/sync-token-fetcher", () => ({
  audioSyncTokenFetcherForSession: () => async () => "tok",
}))

const session = { jwt: "tok", username: "dev" } as FrontierSession

function lang(
  partial: Partial<InworldSupportedLanguage> & Pick<InworldSupportedLanguage, "code" | "familyCode" | "familyDisplayName">,
): InworldSupportedLanguage {
  return {
    accentDisplayName: "",
    displayName: partial.familyDisplayName,
    creationEnabled: true,
    hasVoices: true,
    ...partial,
  }
}

const portalLanguages: InworldSupportedLanguage[] = [
  lang({ code: "kbt", familyCode: "kbt", familyDisplayName: "Abadi", hasVoices: false }),
  lang({ code: "en", familyCode: "en", familyDisplayName: "English" }),
  lang({
    code: "en-US",
    familyCode: "en",
    familyDisplayName: "English",
    accentDisplayName: "American",
  }),
  lang({
    code: "en-GB",
    familyCode: "en",
    familyDisplayName: "English",
    accentDisplayName: "British",
  }),
  lang({ code: "sw", familyCode: "sw", familyDisplayName: "Swahili" }),
  lang({
    code: "sw-KE",
    familyCode: "sw",
    familyDisplayName: "Swahili",
    accentDisplayName: "Kenyan",
  }),
  lang({ code: "fil", familyCode: "fil", familyDisplayName: "Filipino", hasVoices: false }),
  lang({ code: "ta", familyCode: "ta", familyDisplayName: "Tamil", hasVoices: false }),
  lang({ code: "acw", familyCode: "acw", familyDisplayName: "Hijazi Arabic", hasVoices: false }),
]

function renderLocales(
  initial?: string,
  copy?: "design" | "catalog",
  voicesOnly = false,
) {
  const onLanguageChange = vi.fn()
  function Harness() {
    const [language, setLanguage] = useState(initial)
    return (
      <InworldDesignLocaleFields
        copy={copy}
        voicesOnly={voicesOnly}
        language={language}
        onLanguageChange={(next) => {
          onLanguageChange(next)
          setLanguage(next)
        }}
        projectId="p1"
        fileId="f1"
        session={session}
      />
    )
  }
  renderWithTooltips(<Harness />)
  return { onLanguageChange }
}

describe("InworldDesignLocaleFields", () => {
  beforeEach(() => {
    __resetInworldSupportedLanguagesCacheForTests()
    vi.mocked(listInworldSupportedLanguages).mockReset()
    vi.mocked(listInworldSupportedLanguages).mockResolvedValue([])
  })

  it("offers Language and Accent without Other", async () => {
    vi.mocked(listInworldSupportedLanguages).mockResolvedValue(portalLanguages)
    const user = userEvent.setup()
    renderLocales()
    expect(screen.queryByRole("option", { name: "Other" })).toBeNull()
    expect(screen.queryByLabelText("Language code")).toBeNull()
    await user.click(screen.getByRole("combobox", { name: "Language" }))
    expect(screen.queryByRole("option", { name: "Other" })).toBeNull()
    expect(await screen.findByRole("option", { name: /^English$/i })).toBeTruthy()
  })

  it("lists live Inworld supported languages, including ones with no SYSTEM voices", async () => {
    vi.mocked(listInworldSupportedLanguages).mockResolvedValue(portalLanguages)
    const user = userEvent.setup()
    renderLocales()
    await user.click(screen.getByRole("combobox", { name: "Language" }))
    expect(await screen.findByRole("option", { name: /^Abadi$/i })).toBeTruthy()
    expect(screen.getByRole("option", { name: /^Swahili$/i })).toBeTruthy()
    expect(screen.getByRole("option", { name: /^Filipino$/i })).toBeTruthy()
    expect(screen.getByRole("option", { name: /^Tamil$/i })).toBeTruthy()
    expect(screen.getByRole("option", { name: /^Hijazi Arabic$/i })).toBeTruthy()
  })

  it("falls back to the published TTS-2 table when Inworld returns nothing", async () => {
    vi.mocked(listInworldSupportedLanguages).mockResolvedValue([])
    const user = userEvent.setup()
    renderLocales()
    await user.click(screen.getByRole("combobox", { name: "Language" }))
    expect(await screen.findByRole("option", { name: /^Swahili$/i })).toBeTruthy()
    expect(screen.getAllByRole("option").length).toBeGreaterThan(80)
  })

  it("filters the language list from the search field", async () => {
    vi.mocked(listInworldSupportedLanguages).mockResolvedValue(portalLanguages)
    const user = userEvent.setup()
    renderLocales()
    await user.click(screen.getByRole("combobox", { name: "Language" }))
    await user.type(screen.getByRole("combobox", { name: "Find a language" }), "swahili")
    expect(await screen.findByRole("option", { name: /^Swahili$/i })).toBeTruthy()
    expect(screen.queryByRole("option", { name: /^English$/i })).toBeNull()
  })

  it("sets American English when the user picks that accent", async () => {
    vi.mocked(listInworldSupportedLanguages).mockResolvedValue(portalLanguages)
    const user = userEvent.setup()
    const { onLanguageChange } = renderLocales("en-GB")
    await user.click(screen.getByRole("combobox", { name: "Accent" }))
    await user.click(await screen.findByRole("option", { name: /American/ }))
    expect(onLanguageChange).toHaveBeenCalledWith("en-US")
  })

  it("puts Default first on the accent list and selects it", async () => {
    vi.mocked(listInworldSupportedLanguages).mockResolvedValue(portalLanguages)
    const user = userEvent.setup()
    const { onLanguageChange } = renderLocales()
    await user.click(await screen.findByRole("combobox", { name: "Accent" }))
    const options = screen.getAllByRole("option")
    expect(options[0]).toHaveAccessibleName(/^Default$/)
    expect(screen.getByRole("option", { name: /American/ })).toBeTruthy()
    expect(onLanguageChange).toHaveBeenCalledWith("en")
    await user.click(options[0])
    expect(onLanguageChange).toHaveBeenCalledWith("en")
  })

  it("explains language and accent behind info icons", async () => {
    vi.mocked(listInworldSupportedLanguages).mockResolvedValue(portalLanguages)
    renderLocales("en-US")
    await expectTooltip(
      screen.getByRole("button", { name: "About the language" }),
      /language this designed voice will speak/i,
    )
    await expectTooltip(
      screen.getByRole("button", { name: "About the accent" }),
      /Default is just en/i,
    )
  })

  it("explains catalog language copy on prebuilt", async () => {
    vi.mocked(listInworldSupportedLanguages).mockResolvedValue(portalLanguages)
    renderLocales("en-US", "catalog", true)
    await expectTooltip(
      screen.getByRole("button", { name: "About the language" }),
      /already has speakers/i,
    )
    await expectTooltip(
      screen.getByRole("button", { name: "About the accent" }),
      /matching stock voices/i,
    )
    expect(screen.getByText(/Can't find the language\? Go to the Voice design tab/)).toBeTruthy()
    expect(screen.queryByRole("button", { name: /Can't find the language/ })).toBeNull()
  })

  it("hides languages without SYSTEM voices on the prebuilt picker", async () => {
    vi.mocked(listInworldSupportedLanguages).mockResolvedValue(portalLanguages)
    const user = userEvent.setup()
    renderLocales("en-US", "catalog", true)
    await user.click(screen.getByRole("combobox", { name: "Language" }))
    expect(await screen.findByRole("option", { name: /^English$/i })).toBeTruthy()
    expect(screen.getByRole("option", { name: /^Swahili$/i })).toBeTruthy()
    expect(screen.queryByRole("option", { name: /^Abadi$/i })).toBeNull()
    expect(screen.queryByRole("option", { name: /^Tamil$/i })).toBeNull()
  })

  it("shows a short empty state when search misses on prebuilt", async () => {
    vi.mocked(listInworldSupportedLanguages).mockResolvedValue(portalLanguages)
    const user = userEvent.setup()
    renderLocales("en-US", "catalog", true)
    await user.click(screen.getByRole("combobox", { name: "Language" }))
    await user.type(screen.getByRole("combobox", { name: "Find a language" }), "abadi")
    expect(await screen.findByText("No matches")).toBeTruthy()
    expect(screen.queryByText(/Design a voice yourself/)).toBeNull()
  })
})
