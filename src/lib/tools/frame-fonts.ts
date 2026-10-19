/**
 * apiRev 3: the app's UI font for extension frames. The sandbox's CSP forbids
 * loading fonts from any URL (and the frame has no origin to load them from),
 * so the host hands the frame the font BYTES over postMessage and the runtime
 * registers them with the FontFace API — no network, no URL, nothing for the
 * frame to fetch. Lets an extension match the app's typography exactly.
 */

import latinUrl from "@fontsource-variable/geist/files/geist-latin-wght-normal.woff2?url"
import latinExtUrl from "@fontsource-variable/geist/files/geist-latin-ext-wght-normal.woff2?url"

export interface FrameFont {
  family: string
  data: ArrayBuffer
  descriptors: { weight: string; style: string; unicodeRange: string }
}

const SOURCES = [
  {
    url: latinUrl,
    unicodeRange:
      "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD",
  },
  {
    url: latinExtUrl,
    unicodeRange:
      "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF",
  },
]

let loaded: Promise<FrameFont[]> | null = null

/** The app font's bytes (fetched once per page from the app's own origin). */
export function loadFrameFonts(): Promise<FrameFont[]> {
  if (!loaded) {
    loaded = Promise.all(
      SOURCES.map(async (s) => {
        const res = await fetch(s.url)
        if (!res.ok) throw new Error(`font ${s.url}: HTTP ${res.status}`)
        return {
          family: "Geist Variable",
          data: await res.arrayBuffer(),
          descriptors: { weight: "100 900", style: "normal", unicodeRange: s.unicodeRange },
        }
      }),
    ).catch((err) => {
      loaded = null
      throw err
    })
  }
  return loaded
}
