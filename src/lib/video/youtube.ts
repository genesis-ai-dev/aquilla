// Recognising a YouTube address. A watch page is not a media resource, so a
// plain <video src> fails on it; the video pane uses this to hand such links to
// the YouTube iframe player instead.

const ID = /^[A-Za-z0-9_-]{11}$/
const PATH_PREFIXES = ["/shorts/", "/embed/", "/live/", "/v/"]

function isYouTubeHost(host: string): boolean {
  return (
    host === "youtube.com" ||
    host.endsWith(".youtube.com") ||
    host === "youtube-nocookie.com" ||
    host.endsWith(".youtube-nocookie.com")
  )
}

/** The 11-character video id, or null when the address is not a YouTube video. */
export function youTubeVideoId(value: string): string | null {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return null
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null
  const host = url.hostname.toLowerCase()

  let candidate: string | null = null
  if (host === "youtu.be") {
    candidate = url.pathname.slice(1).split("/")[0] ?? null
  } else if (isYouTubeHost(host)) {
    if (url.pathname === "/watch") {
      candidate = url.searchParams.get("v")
    } else {
      const prefix = PATH_PREFIXES.find((p) => url.pathname.startsWith(p))
      if (prefix) candidate = url.pathname.slice(prefix.length).split("/")[0] ?? null
    }
  }
  return candidate && ID.test(candidate) ? candidate : null
}
