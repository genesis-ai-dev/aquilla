// Preferences → Recording (AQU-2264). Two doors, one setting: each control on
// this page is the very preference the recorder's ⚙ (and its format and film
// buttons) and the timeline's toolbar use, so a change on either side shows
// on the other at once. What each one does opens under its name, on click.
import { describe, it, expect, vi, beforeEach } from "vitest"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import { RecordingPreferencesScope, RecordingPreferencesSection } from "./RecordingPreferencesSection"
import {
  getRecordingCountdownBeep,
  getRecordingCountdownSpeed,
  setRecordingCountdownSpeed,
} from "@/lib/store/recording-countdown-pref"
import { getRecordingFormatPref } from "@/lib/store/recording-format-pref"
import { getRecordingVideoCollapsed, setRecordingVideoCollapsed } from "@/lib/store/recording-video-collapsed-pref"
import { getRecordingFilmAudible } from "@/lib/store/recording-film-audible-pref"
import { getRecordingAutoAdvance } from "@/lib/store/recording-auto-advance-pref"
import { getRecordingTakesDrawerOpen } from "@/lib/store/recording-takes-drawer-pref"
import { timelineFollowPlayheadPref, timelineSnapPref } from "@/lib/prefs/person-pref-list"

const accounts = vi.hoisted(() => ({ active: null as null | { username: string; jwt: string } }))
vi.mock("@/hooks/useFrontierSession", () => ({ useFrontierSession: () => ({ session: accounts.active }) }))

function renderSection() {
  return render(
    <I18nProvider>
      <p><RecordingPreferencesScope /></p>
      <RecordingPreferencesSection />
    </I18nProvider>,
  )
}

beforeEach(() => {
  localStorage.clear()
  accounts.active = null
})

describe("Preferences → Recording", () => {
  it("lists every recorder and timeline preference, at its current value", () => {
    setRecordingCountdownSpeed("fast")
    setRecordingVideoCollapsed(true)
    renderSection()
    expect(screen.getByRole("tab", { name: "Fast" })).toHaveAttribute("aria-selected", "true")
    expect(screen.getByRole("switch", { name: "Countdown beep" })).toHaveAttribute("aria-checked", "true")
    expect(screen.getByRole("switch", { name: "Move on after saving a recording" })).toHaveAttribute("aria-checked", "true")
    expect(screen.getByRole("switch", { name: "Keep the takes drawer open" })).toHaveAttribute("aria-checked", "true")
    expect(screen.getByRole("tab", { name: "WAV" })).toHaveAttribute("aria-selected", "true")
    expect(screen.getByRole("switch", { name: "Show the film beside the recorder" })).toHaveAttribute("aria-checked", "false")
    expect(screen.getByRole("switch", { name: "Play the film's sound while recording" })).toHaveAttribute("aria-checked", "false")
    expect(screen.getByRole("switch", { name: "Follow playhead" })).toHaveAttribute("aria-checked", "true")
    expect(screen.getByRole("switch", { name: "Snap to neighboring edges" })).toHaveAttribute("aria-checked", "true")
  })

  it("changes the same preference the recorder and the timeline use", () => {
    renderSection()
    fireEvent.click(screen.getByRole("tab", { name: "Slow" }))
    fireEvent.click(screen.getByRole("switch", { name: "Countdown beep" }))
    fireEvent.click(screen.getByRole("switch", { name: "Move on after saving a recording" }))
    fireEvent.click(screen.getByRole("switch", { name: "Keep the takes drawer open" }))
    fireEvent.click(screen.getByRole("tab", { name: "Compressed" }))
    fireEvent.click(screen.getByRole("switch", { name: "Show the film beside the recorder" }))
    fireEvent.click(screen.getByRole("switch", { name: "Play the film's sound while recording" }))
    fireEvent.click(screen.getByRole("switch", { name: "Follow playhead" }))
    fireEvent.click(screen.getByRole("switch", { name: "Snap to neighboring edges" }))
    expect(getRecordingCountdownSpeed()).toBe("slow")
    expect(getRecordingCountdownBeep()).toBe(false)
    expect(getRecordingAutoAdvance()).toBe(false)
    expect(getRecordingTakesDrawerOpen()).toBe(false)
    expect(getRecordingFormatPref()).toBe("webm")
    expect(getRecordingVideoCollapsed()).toBe(true)
    expect(getRecordingFilmAudible()).toBe(true)
    expect(timelineFollowPlayheadPref.get()).toBe(false)
    expect(timelineSnapPref.get()).toBe(false)
  })

  it("shows a change made in the recorder or on the timeline at once", () => {
    renderSection()
    act(() => {
      setRecordingCountdownSpeed("off")
      timelineSnapPref.set(false)
    })
    expect(screen.getByRole("tab", { name: "Off" })).toHaveAttribute("aria-selected", "true")
    expect(screen.getByRole("switch", { name: "Snap to neighboring edges" })).toHaveAttribute("aria-checked", "false")
  })

  it("greys the beep out while the countdown is off, keeping its setting", () => {
    renderSection()
    fireEvent.click(screen.getByRole("tab", { name: "Off" }))
    const beep = screen.getByRole("switch", { name: "Countdown beep" })
    expect(beep).toHaveAttribute("aria-disabled", "true")
    expect(beep).toHaveAttribute("aria-checked", "true")
  })

  it("opens what a setting does under its name on a click of its (i), and shuts it on a second", () => {
    renderSection()
    const toggle = screen.getByRole("button", { name: "About Follow playhead" })
    const text = screen.getByTestId("pref-tl-follow-info")
    expect(text).toHaveAttribute("data-open", "false")
    fireEvent.click(toggle)
    expect(text).toHaveAttribute("data-open", "true")
    expect(text).toHaveTextContent("While playing, the timeline scrolls to keep the playhead in view.")
    expect(screen.getByRole("switch", { name: "Follow playhead" })).toHaveAttribute("aria-checked", "true")
    fireEvent.click(toggle)
    expect(text).toHaveAttribute("data-open", "false")
  })

  it("says they follow the person when signed in, and stay on this device when not", () => {
    const { unmount } = renderSection()
    expect(screen.getByTestId("recording-prefs-scope")).toHaveTextContent("kept on this device only")
    unmount()
    accounts.active = { username: "ana", jwt: "jwt" }
    renderSection()
    expect(screen.getByTestId("recording-prefs-scope")).toHaveTextContent("every device where you're signed in")
  })
})
