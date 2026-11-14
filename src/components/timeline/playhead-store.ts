// Where the timeline's playhead is, held outside React state so that a tick
// re-renders only `TimelineTransportClock`. See the note there.

import { useState } from "react"

export interface PlayheadStore {
  /** The clock: where every seek and transport write lands. */
  sec(): number
  /** Where the head is drawn: the scrub, or the clock less the output latency. */
  displaySec(): number
  /** Whichever transport owns the clock is sounding. */
  transportPlaying(): boolean
  /** A user seek. Clamps to >= 0, and ends the latency shift — a seek has to
   *  land exactly where it was aimed. */
  seek(sec: number): void
  /** The hand on the head, or null when it lets go. */
  scrub(sec: number | null): void
}

export interface PlayheadStoreInternals extends PlayheadStore {
  scrubSec(): number | null
  compensating(): boolean
  write(sec: number): void
  setCompensating(on: boolean): void
  publish(display: number, playing: boolean): void
  subscribe(listener: () => void): () => void
}

export function createPlayheadStore(): PlayheadStoreInternals {
  let sec = 0
  let scrubAt: number | null = null
  let compensating = false
  let display = 0
  let playing = false
  const listeners = new Set<() => void>()
  const notify = () => { for (const listener of listeners) listener() }
  const clamp = (value: number) => (Number.isFinite(value) ? Math.max(0, value) : 0)
  return {
    sec: () => sec,
    displaySec: () => display,
    transportPlaying: () => playing,
    scrubSec: () => scrubAt,
    compensating: () => compensating,
    seek(next) {
      sec = clamp(next)
      compensating = false
      notify()
    },
    scrub(next) {
      scrubAt = next
      if (next != null) sec = clamp(next)
      notify()
    },
    write(next) {
      if (next === sec) return
      sec = next
      notify()
    },
    setCompensating(on) {
      if (on === compensating) return
      compensating = on
      notify()
    },
    publish(nextDisplay, nextPlaying) {
      display = nextDisplay
      playing = nextPlaying
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

export function useCreatePlayheadStore(): PlayheadStoreInternals {
  return useState(createPlayheadStore)[0]
}
