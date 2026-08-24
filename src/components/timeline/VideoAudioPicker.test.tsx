import { describe, expect, it, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"

import { VideoAudioPicker } from "./VideoAudioPicker"
import type { FilmAudioTrack } from "@/lib/video/film-audio-tracks"

const t = (id: number, name: string, lang: string): FilmAudioTrack => ({ id, name, lang })

/** A slice of episode 101's list, in the manifest's own order. */
const TRACKS = [
  t(0, "Amharic", "am-ET"),
  t(16, "English", "en"),
  t(40, "Portuguese (Brazil)", "pt-BR"),
  t(50, "Spanish (Latin America)", "es-419"),
]

describe("the film's language picker", () => {
  it("says what is playing, for anyone hovering or using a screen reader", () => {
    render(<VideoAudioPicker tracks={TRACKS} activeLang="en" onChange={vi.fn()} />)
    expect(screen.getByTestId("video-audio-picker")).toHaveAttribute(
      "aria-label",
      "Film audio: English",
    )
  })

  it("does not appear at all for a film with one soundtrack", () => {
    // Every ordinary file lands here: a control that opens onto a single choice
    // is worse than no control.
    render(<VideoAudioPicker tracks={[t(0, "English", "en")]} activeLang="en" onChange={vi.fn()} />)
    expect(screen.queryByTestId("video-audio-picker")).not.toBeInTheDocument()
  })

  it("does not appear before the film has opened", () => {
    render(<VideoAudioPicker tracks={[]} activeLang={null} onChange={vi.fn()} />)
    expect(screen.queryByTestId("video-audio-picker")).not.toBeInTheDocument()
  })

  it("offers every language once opened", () => {
    render(<VideoAudioPicker tracks={TRACKS} activeLang="en" onChange={vi.fn()} />)
    fireEvent.click(screen.getByTestId("video-audio-picker"))
    for (const track of TRACKS) {
      expect(screen.getByText(track.name)).toBeInTheDocument()
    }
  })

  it("reports the language code, not the name, when one is chosen", () => {
    const onChange = vi.fn()
    render(<VideoAudioPicker tracks={TRACKS} activeLang="en" onChange={onChange} />)
    fireEvent.click(screen.getByTestId("video-audio-picker"))
    fireEvent.click(screen.getByText("Portuguese (Brazil)"))
    expect(onChange).toHaveBeenCalledWith("pt-BR")
  })

  it("tells the pane while it is open, so the corner does not fade out from under it", () => {
    const onOpenChange = vi.fn()
    render(
      <VideoAudioPicker tracks={TRACKS} activeLang="en" onChange={vi.fn()} onOpenChange={onOpenChange} />,
    )
    fireEvent.click(screen.getByTestId("video-audio-picker"))
    expect(onOpenChange).toHaveBeenCalledWith(true)
  })

  it("closes once a language is picked", () => {
    const onOpenChange = vi.fn()
    render(
      <VideoAudioPicker tracks={TRACKS} activeLang="en" onChange={vi.fn()} onOpenChange={onOpenChange} />,
    )
    fireEvent.click(screen.getByTestId("video-audio-picker"))
    onOpenChange.mockClear()
    fireEvent.click(screen.getByText("Amharic"))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
