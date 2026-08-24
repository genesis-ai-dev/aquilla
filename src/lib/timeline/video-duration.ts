// How long the linked video actually is, published as a tiny module store —
// the video-clock.ts / media-cursor.ts pattern. (AQU-646)
//
// The timeline's track has always ended two seconds after the last cue, which
// is right for an imported recording (the cells ARE the recording) and wrong
// for a subtitle file timed against footage: the episode carries on past the
// last line, and that trailing stretch is exactly the space this workflow is
// about. On the demo file it is three minutes that no amount of scrolling
// could reach.
//
// KEYED BY URL, not by file. A single slot looked equivalent and is not: open
// file A, open file B, come back to A, and the reader stops matching — the
// track silently shrinks back to the subtitles' extent with no way to recover
// but a reload. ProjectWorkspace mounts the pane with key={activeFile.id}, so
// switching files remounts it and that is the ordinary case, not an edge one.
//
// Nothing is persisted. The number is a property of the video file, not of the
// translation work, and re-deriving it costs one metadata read that the mounted
// element is doing anyway.

import { useSyncExternalStore } from "react"

/** Longer than this is a corrupt header, not a film. */
const MAX_PLAUSIBLE_SEC = 6 * 60 * 60
/** Enough to keep every file a person has open; small enough to stay a cache. */
const MAX_TRACKED = 8

const byUrl = new Map<string, number>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const l of listeners) l()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * MediaVideoPane calls this from `loadedmetadata` / `durationchange`, passing
 * its own src. A null (or implausible) duration removes the entry rather than
 * storing a zero — "we do not know" and "it is zero seconds long" have to stay
 * distinguishable, because the first falls back to the cells' own extent and
 * the second would collapse the track.
 */
export function setVideoDurationSec(url: string | null | undefined, sec: number | null): void {
  if (!url) return
  const usable =
    sec != null && Number.isFinite(sec) && sec > 0 && sec <= MAX_PLAUSIBLE_SEC ? sec : null
  if (usable == null) {
    if (byUrl.delete(url)) notify()
    return
  }
  if (byUrl.get(url) === usable) return
  // Insertion order is eviction order, and Map.set on an EXISTING key leaves
  // that order alone — so delete first, or the video you keep coming back to
  // ages out while the ones you opened once do not.
  byUrl.delete(url)
  byUrl.set(url, usable)
  if (byUrl.size > MAX_TRACKED) {
    const oldest = byUrl.keys().next()
    if (!oldest.done) byUrl.delete(oldest.value)
  }
  notify()
}

export function getVideoDurationSec(url: string | null | undefined): number | null {
  return url ? (byUrl.get(url) ?? null) : null
}

/** Returns a primitive, so no snapshot caching is needed (same as the sibling
 *  stores). Null means "not known yet" — never treat it as zero. */
export function useVideoDurationSec(url: string | null | undefined): number | null {
  return useSyncExternalStore(
    subscribe,
    () => (url ? (byUrl.get(url) ?? null) : null),
    () => null,
  )
}

export function resetVideoDurationsForTests(): void {
  byUrl.clear()
  notify()
}
