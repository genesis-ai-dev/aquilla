// AQU-1686 — the Bible data card's enrichment rows.
//
// The spec's rules for this card: every enrichment has exactly one row, with a
// label, a description, a source/license chip and a switch; a row is never
// disabled silently; when Bible data is off every row stays visible but
// disabled, and says why; the autopilot row says why when Autopilot is off;
// the checks row leads to Rules → Built-in checks; Data sources credits each
// dataset and its license.

import { describe, it, expect, vi } from "vitest"
import { fireEvent, screen, within } from "@testing-library/react"
import { renderWithTooltips } from "@/test-utils/tooltip"
import { BibleDataSection, type BibleDataSectionProps } from "./BibleDataSection"
import { en, type MessageKey } from "@/lib/i18n/messages/en"
import { BIBLE_ENRICHMENT_LABEL_KEYS } from "@/lib/bible-data/enrichment-labels"
import {
  BIBLE_DATA_SOURCE_IDS,
  BIBLE_DATA_SOURCE_LICENSES,
  BIBLE_ENRICHMENTS,
  BIBLE_ENRICHMENT_IDS,
  type BibleEnrichmentId,
} from "../../../db/shared/bible-enrichments"

/** English text of a plain (not count-governed) catalog key. */
function english(key: MessageKey): string {
  const value = en[key]
  if (typeof value !== "string") throw new Error(`${key} is a plural message`)
  return value
}

const SWITCH_OFF_REASON = english("bibleData.enrichment.switchOffReason")
const AUTOPILOT_REASON = english("bibleData.enrichment.autopilotOffReason")

function renderSection(overrides: Partial<BibleDataSectionProps> = {}) {
  const props: BibleDataSectionProps = {
    switchValue: undefined,
    onSwitchChange: vi.fn(),
    enrichments: {},
    onEnrichmentChange: vi.fn(),
    hasScriptureFiles: true,
    canEdit: true,
    lockedTooltip: null,
    autopilotOn: true,
    onOpenBuiltinChecks: vi.fn(),
    experimentOn: true,
    ...overrides,
  }
  renderWithTooltips(<BibleDataSection {...props} />)
  return props
}

const rowSwitch = (id: BibleEnrichmentId) =>
  screen.getByRole("switch", { name: english(BIBLE_ENRICHMENT_LABEL_KEYS[id]) })
const isOn = (el: HTMLElement) => el.getAttribute("aria-checked") === "true"
const isDisabled = (el: HTMLElement) => el.getAttribute("aria-disabled") === "true"

describe("BibleDataSection", () => {
  // AQU-1685: a device that never opted in sees the card it had before the
  // pack existed. Only the master switch, under its old name; no row, reason
  // or Data sources link that would advertise an experiment.
  it("is the old Bible resources card while the experiment is off", () => {
    renderSection({ experimentOn: false, switchValue: false })
    expect(screen.getByRole("switch", { name: "Enable Bible resources" })).toBeInTheDocument()
    expect(screen.getAllByRole("switch")).toHaveLength(1)
    expect(screen.queryByText(SWITCH_OFF_REASON)).toBeNull()
    expect(screen.queryByRole("button", { name: english("bibleData.sources.open") })).toBeNull()
  })

  it("renders one switch per enrichment with a source and license chip", () => {
    renderSection()
    expect(screen.getByRole("switch", { name: "Enable Bible data" })).toBeInTheDocument()
    for (const id of BIBLE_ENRICHMENT_IDS) {
      expect(screen.getAllByRole("switch", { name: english(BIBLE_ENRICHMENT_LABEL_KEYS[id]) }), id).toHaveLength(1)
      expect(screen.getByTestId(`bible-enrichment-source-${id}`), id).toHaveTextContent(BIBLE_ENRICHMENTS[id].license)
    }
    expect(screen.getByTestId("bible-enrichment-source-helps")).toHaveTextContent("unfoldingWord")
  })

  it("shows each row's registry default when the project has made no choice", () => {
    renderSection()
    for (const id of BIBLE_ENRICHMENT_IDS) {
      expect(isOn(rowSwitch(id)), id).toBe(BIBLE_ENRICHMENTS[id].default)
    }
  })

  it("shows an explicit choice over the default and reports a change by id", () => {
    const props = renderSection({ enrichments: { voices: false, autopilot: true } })
    expect(isOn(rowSwitch("voices"))).toBe(false)
    expect(isOn(rowSwitch("autopilot"))).toBe(true)
    fireEvent.click(rowSwitch("places"))
    expect(props.onEnrichmentChange).toHaveBeenCalledWith("places", false)
  })

  // Never disabled silently: the reason is visible text, and each switch
  // points at it so a screen reader hears it with the switch.
  it("disables every enrichment with a visible reason when Bible data is off", () => {
    renderSection({ switchValue: false })
    const reason = screen.getByText(SWITCH_OFF_REASON)
    for (const id of BIBLE_ENRICHMENT_IDS) {
      const control = rowSwitch(id)
      expect(isDisabled(control), id).toBe(true)
      expect(control.getAttribute("aria-describedby")?.split(" "), id).toContain(reason.id)
    }
    // The master switch itself stays usable: it is the way back.
    expect(isDisabled(screen.getByRole("switch", { name: "Enable Bible data" }))).toBe(false)
  })

  it("treats an unset switch on a project without scripture files as off", () => {
    renderSection({ switchValue: undefined, hasScriptureFiles: false })
    expect(screen.getByText(SWITCH_OFF_REASON)).toBeInTheDocument()
    expect(isDisabled(rowSwitch("voices"))).toBe(true)
  })

  it("enables the rows and drops the reason when Bible data is on", () => {
    renderSection({ switchValue: true, hasScriptureFiles: false })
    expect(screen.queryByText(SWITCH_OFF_REASON)).toBeNull()
    expect(isDisabled(rowSwitch("voices"))).toBe(false)
    expect(rowSwitch("voices")).not.toHaveAttribute("aria-describedby")
  })

  it("disables only the autopilot row, with its own reason, when Autopilot is off", () => {
    renderSection({ autopilotOn: false })
    const reason = screen.getByText(AUTOPILOT_REASON)
    expect(isDisabled(rowSwitch("autopilot"))).toBe(true)
    expect(rowSwitch("autopilot").getAttribute("aria-describedby")).toBe(reason.id)
    expect(isDisabled(rowSwitch("voices"))).toBe(false)
  })

  it("keeps every switch read-only below the settings floor", () => {
    renderSection({ canEdit: false })
    expect(isDisabled(screen.getByRole("switch", { name: "Enable Bible data" }))).toBe(true)
    for (const id of BIBLE_ENRICHMENT_IDS) expect(isDisabled(rowSwitch(id)), id).toBe(true)
  })

  // One canonical surface per setting: each check is configured in Rules.
  it("links the checks row to Rules → Built-in checks", () => {
    const props = renderSection()
    fireEvent.click(screen.getByRole("button", { name: "Open built-in checks" }))
    expect(props.onOpenBuiltinChecks).toHaveBeenCalledTimes(1)
  })

  it("credits every dataset with its license in the Data sources dialog", async () => {
    renderSection()
    fireEvent.click(screen.getByRole("button", { name: "Data sources" }))
    const dialog = await screen.findByRole("dialog", { name: "Bible data sources" })
    for (const id of BIBLE_DATA_SOURCE_IDS) {
      const item = within(dialog).getByTestId(`bible-data-source-${id}`)
      const license = within(item).getByRole("link", { name: BIBLE_DATA_SOURCE_LICENSES[id] })
      expect(license.getAttribute("href"), id).toMatch(/^https:\/\/creativecommons\.org\/licenses\//)
    }
    expect(within(dialog).getByText("Macula Greek/Hebrew (Clear-Bible)")).toBeInTheDocument()
  })
})
