import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"

import { VideoSoundSourcePicker } from "./VideoSoundSourcePicker"

// AQU-1565 follow-up. WHY: this is the ONE place a person can move a YouTube
// file off the video's own sound, so it has to say which sound is on, name the
// recording, and report a change exactly once.

describe("VideoSoundSourcePicker", () => {
  it("names the current sound on the trigger", () => {
    render(<VideoSoundSourcePicker value="video" recordingName="episode.wav" onChange={() => {}} />)
    expect(screen.getByTestId("video-sound-source-picker"))
      .toHaveAttribute("aria-label", "Sound: The video's own sound")
  })

  it("offers both sounds, checks the current one, and reports a new pick", async () => {
    const onChange = vi.fn()
    render(<VideoSoundSourcePicker value="video" recordingName="episode.wav" onChange={onChange} />)
    fireEvent.click(screen.getByTestId("video-sound-source-picker"))
    const video = await screen.findByTestId("video-sound-source-video")
    const recording = screen.getByTestId("video-sound-source-recording")
    expect(video).toHaveAttribute("aria-checked", "true")
    expect(recording).toHaveAttribute("aria-checked", "false")
    expect(recording).toHaveTextContent("Uploaded recording (episode.wav)")
    fireEvent.click(recording)
    expect(onChange).toHaveBeenCalledExactlyOnceWith("recording")
  })

  it("does not report re-picking the sound that is already on", async () => {
    const onChange = vi.fn()
    render(<VideoSoundSourcePicker value="recording" recordingName={null} onChange={onChange} />)
    fireEvent.click(screen.getByTestId("video-sound-source-picker"))
    const recording = await screen.findByTestId("video-sound-source-recording")
    // No file name on the rows: the plain label, never "()".
    expect(recording).toHaveTextContent(/^Uploaded recording$/)
    fireEvent.click(recording)
    expect(onChange).not.toHaveBeenCalled()
  })
})
