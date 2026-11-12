import { useEffect, useState } from "react"
import { frameRateLabelFor, type FrameRateLabel } from "@/lib/parsers/frame-timecode"
import { fetchFilmFrameRate } from "@/lib/video/film-frame-rate"

/** A linked film's frame rate, as an import's frame check uses it (AQU-2197):
 *  one of the common rates, null when there is no film or its rate is none of
 *  those or could not be read, and "pending" while it is being read. */
export type FilmFrameRate = FrameRateLabel | null | "pending"

// One read per film for the session: the rate of a film never changes, and
// every import dialog over the same file asks again. A failed read is
// forgotten so the next opening tries again.
const reads = new Map<string, Promise<FrameRateLabel | null>>()

function readFilmFrameRate(url: string): Promise<FrameRateLabel | null> {
  let read = reads.get(url)
  if (!read) {
    read = fetchFilmFrameRate(url).then((fps) => {
      if (fps === null) reads.delete(url)
      return fps === null ? null : frameRateLabelFor(fps)
    })
    reads.set(url, read)
  }
  return read
}

/**
 * The frame rates of several linked films, read once each. A url absent from
 * the answer is still being read; pass no urls until the rate is needed, so a
 * file that never shows the frame check never fetches its film.
 */
export function useFilmFrameRates(
  urls: readonly (string | null | undefined)[],
): ReadonlyMap<string, FrameRateLabel | null> {
  const key = [...new Set(urls.filter((url): url is string => !!url))].sort().join("\n")
  const [rates, setRates] = useState<ReadonlyMap<string, FrameRateLabel | null>>(() => new Map())
  useEffect(() => {
    if (!key) return
    let live = true
    for (const url of key.split("\n")) {
      void readFilmFrameRate(url).then((rate) => {
        if (live) setRates((prev) => (prev.get(url) === rate && prev.has(url) ? prev : new Map(prev).set(url, rate)))
      })
    }
    return () => { live = false }
  }, [key])
  return rates
}

/** What `useFilmFrameRates` knows of one film. */
export function filmFrameRateOf(
  rates: ReadonlyMap<string, FrameRateLabel | null>,
  url: string | null | undefined,
): FilmFrameRate {
  if (!url) return null
  return rates.has(url) ? rates.get(url)! : "pending"
}
