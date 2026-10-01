import { describe, expect, it } from "vitest"

import { youTubeVideoId } from "./youtube"

// The video pane picks its player from this answer: a YouTube page handed to a
// plain <video> element fails to load, so every address shape people actually
// paste has to be recognised — and nothing else may be, or a real media file
// would be routed into the iframe player and fail there instead.
describe("youTubeVideoId", () => {
  it.each([
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://youtube.com/watch?v=dQw4w9WgXcQ&t=42s", "dQw4w9WgXcQ"],
    ["https://m.youtube.com/watch?feature=share&v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://music.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ?si=abc", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/live/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["  https://youtu.be/dQw4w9WgXcQ  ", "dQw4w9WgXcQ"],
  ])("recognises %s", (url, id) => {
    expect(youTubeVideoId(url)).toBe(id)
  })

  it.each([
    "https://example.com/episode.mp4",
    "https://example.com/watch?v=dQw4w9WgXcQ",
    "https://notyoutube.com/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com/",
    "https://www.youtube.com/channel/UC123",
    "https://www.youtube.com/watch?v=short",
    "blob:https://aquilla.app/123",
    "not a url",
    "",
  ])("rejects %s", (url) => {
    expect(youTubeVideoId(url)).toBeNull()
  })
})
