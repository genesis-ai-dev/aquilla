// Import map X-D-youtube-film-card (Nov 2): the card printed the raw address
// under "This film could not be loaded" and named nothing a person could do.
import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { VideoPaneErrorCard } from "./VideoPaneErrorCard"
import { filmFailure } from "@/lib/timeline/film-failure"

const WATCH = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"

describe("VideoPaneErrorCard", () => {
  it.each([
    [100, "YouTube says this video is private, removed, or doesn't exist."],
    [150, "The video's owner doesn't let it play on other sites."],
    [101, "The video's owner doesn't let it play on other sites."],
    [2, "This link doesn't point to a YouTube video."],
    [null, "YouTube didn't play this video here."],
    [5, "YouTube didn't play this video here."],
  ])("says what YouTube's player said (code %s), with a link to try it on YouTube", (code, text) => {
    render(<VideoPaneErrorCard failure={{ kind: "youtube", code, watchUrl: WATCH }} onRetry={vi.fn()} />)
    expect(screen.getByTestId("video-pane-error-reason")).toHaveTextContent(text)
    expect(screen.queryByText(WATCH)).toBeNull()
    expect(screen.getByTestId("video-pane-open-youtube")).toHaveAttribute("href", WATCH)
  })

  it("names an uploaded film's failure without its signed address", () => {
    render(<VideoPaneErrorCard failure={{ kind: "upload" }} onRetry={vi.fn()} />)
    expect(screen.getByTestId("video-pane-error-reason")).toHaveTextContent(
      "The film uploaded with this file didn't play. Check that you're online, then retry.")
    expect(screen.queryByTestId("video-pane-open-youtube")).toBeNull()
  })
})

describe("filmFailure", () => {
  it("tells the three kinds apart, from the stored and the played address", () => {
    expect(filmFailure(WATCH, WATCH, true, 150)).toEqual({ kind: "youtube", code: 150, watchUrl: WATCH })
    expect(filmFailure("frontier-audio://p/f/a.mov", "http://127.0.0.1:9251/audio/p/a.mov?t=secret", false, null))
      .toEqual({ kind: "upload" })
    expect(filmFailure("https://cdn.example.com/ep.mp4", "https://cdn.example.com/ep.mp4", false, null))
      .toEqual({ kind: "link", host: "cdn.example.com" })
  })
})
